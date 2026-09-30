import { useEffect, useId, useRef, useState } from 'react';
import { FileText, RefreshCw } from 'lucide-react';
import type { BriefEvidence, BriefNextCheck } from '../worker/incident-brief-domain';
import type { BriefListResponse, BriefRecord } from '../worker/incident-briefs';
import './incident-brief.css';

const when = (at: number | null) => (at === null ? 'Not completed' : new Date(at).toLocaleString());
const stateLabels: Record<BriefRecord['state'], string> = {
  pending: 'Pending',
  complete: 'Complete',
  failed: 'Failed',
  interrupted: 'Interrupted',
  'insufficient-evidence': 'Insufficient evidence',
};
const nextCheckLabels: Record<BriefNextCheck, string> = {
  'inspect-service-logs': 'Inspect the service’s logs',
  'compare-deployments': 'Compare deployment times with the observations',
  'verify-response-contract': 'Verify the service’s response contract',
  'review-latency-and-timeout': 'Review latency and timeout settings',
  'compare-policy-versions': 'Compare the captured policy versions',
  'inspect-monitor-scheduler': 'Inspect monitoring scheduler diagnostics',
};
type BriefResponse = { brief: BriefRecord; alreadyRecorded?: true };
type ErrorPayload = {
  error?: string;
  code?: string;
  brief?: BriefRecord;
  capability?: BriefListResponse['capability'];
  quota?: BriefListResponse['quota'];
  admission?: BriefListResponse['admission'];
};
class BriefRequestError extends Error {
  constructor(
    readonly payload: ErrorPayload,
    readonly status: number,
  ) {
    super(payload.error || `Request failed (${status})`);
  }
}
type PanelState = {
  scope: string;
  list: BriefListResponse | null;
  records: Record<string, BriefRecord>;
  selected: string | null;
  error: string;
  reading: boolean;
  creating: boolean;
  pollingStopped: boolean;
};
function mergeRecord(records: PanelState['records'], brief: BriefRecord) {
  const previous = records[brief.requestId];
  // A delayed pending read cannot replace an already received terminal result.
  if (previous && previous.state !== 'pending' && brief.state === 'pending') return records;
  return { ...records, [brief.requestId]: brief };
}

/** All brief data and request IDs are limited to the authenticated Operations session. */
export function IncidentBriefPanel({
  incidentId,
  token,
  requestId,
  changeRequestId,
}: {
  incidentId: string;
  token: string;
  requestId: string | null;
  changeRequestId: (requestId: string) => void;
}) {
  const headingId = useId();
  const historyId = useId();
  const scope = `${incidentId}:${token}`;
  const epoch = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const listSequence = useRef(0);
  const recordSequences = useRef(new Map<string, number>());
  const creating = useRef(false);
  const pollAttempts = useRef(0);
  const [state, setState] = useState<PanelState>({
    scope,
    list: null,
    records: {},
    selected: requestId,
    error: '',
    reading: true,
    creating: false,
    pollingStopped: false,
  });
  const visible = state.scope === scope ? state : null;
  const selected = visible?.selected ? visible.records[visible.selected] : null;
  const requested = requestId ? visible?.records[requestId] : null;
  const quota = visible?.list?.quota;
  const admission = visible?.list?.admission;
  const upgradeDayClosed = admission?.upgradeDayClosed === true;
  const dailyRecordLimit = Boolean(admission && admission.remaining <= 0 && !upgradeDayClosed);
  const retainedRecordLimit = Boolean(
    admission && admission.retainedRecords >= admission.maxRetainedRecords,
  );

  function update(generation: number, fn: (previous: PanelState) => PanelState) {
    if (generation !== epoch.current) return;
    setState((previous) =>
      generation === epoch.current && previous.scope === scope ? fn(previous) : previous,
    );
  }
  async function api<T>(path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const response = await fetch(`/api/ops/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      });
      const data = (await response.json()) as T & ErrorPayload;
      if (!response.ok) throw new BriefRequestError(data, response.status);
      return data;
    } finally {
      controllers.current.delete(controller);
    }
  }
  async function loadList(generation = epoch.current) {
    const sequence = ++listSequence.current;
    update(generation, (previous) => ({ ...previous, reading: true }));
    try {
      const list = await api<BriefListResponse>(`incidents/${incidentId}/briefs`);
      if (sequence !== listSequence.current) return;
      update(generation, (previous) => {
        let records = previous.records;
        list.records.forEach((brief) => {
          records = mergeRecord(records, brief);
        });
        return {
          ...previous,
          list,
          records,
          selected: previous.selected ?? list.records[0]?.requestId ?? null,
          reading: false,
        };
      });
    } catch (e) {
      if (sequence !== listSequence.current) return;
      update(generation, (previous) => ({
        ...previous,
        reading: false,
        error: `Brief availability could not be refreshed: ${(e as Error).message}`,
      }));
    }
  }
  async function loadBrief(id: string, generation = epoch.current) {
    const sequence = (recordSequences.current.get(id) ?? 0) + 1;
    recordSequences.current.set(id, sequence);
    try {
      const { brief } = await api<BriefResponse>(`incident-briefs/${id}`);
      if (recordSequences.current.get(id) !== sequence) return;
      update(generation, (previous) => ({
        ...previous,
        records: mergeRecord(previous.records, brief),
        error: '',
      }));
    } catch (e) {
      if (recordSequences.current.get(id) !== sequence) return;
      update(generation, (previous) => ({
        ...previous,
        error:
          e instanceof BriefRequestError && e.status === 404
            ? 'No stored brief is available for this request ID. Retrieve it again or deliberately retry the same ID; retrieval has not started a new AI request.'
            : `The stored request could not be retrieved: ${(e as Error).message}. Its request ID is preserved.`,
      }));
    }
  }
  async function refresh() {
    const generation = epoch.current;
    update(generation, (previous) => ({ ...previous, error: '' }));
    await Promise.allSettled([
      loadList(generation),
      ...(visible?.selected ? [loadBrief(visible.selected, generation)] : []),
      ...(requestId && requestId !== visible?.selected ? [loadBrief(requestId, generation)] : []),
    ]);
  }
  useEffect(() => {
    const generation = ++epoch.current;
    creating.current = false;
    pollAttempts.current = 0;
    recordSequences.current.clear();
    setState({
      scope,
      list: null,
      records: {},
      selected: requestId,
      error: '',
      reading: true,
      creating: false,
      pollingStopped: false,
    });
    loadList(generation);
    if (requestId) loadBrief(requestId, generation);
    return () => {
      epoch.current++;
      controllers.current.forEach((controller) => controller.abort());
      controllers.current.clear();
    };
  }, [incidentId, token]);

  const pollingId =
    requested?.state === 'pending'
      ? requested.requestId
      : selected?.state === 'pending'
        ? selected.requestId
        : null;
  useEffect(() => {
    if (!pollingId) return;
    const generation = epoch.current;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (pollAttempts.current >= 8) {
        clearInterval(timer);
        update(generation, (previous) => ({ ...previous, pollingStopped: true }));
        return;
      }
      pollAttempts.current++;
      loadBrief(pollingId, generation);
      loadList(generation);
    }, 15000);
    return () => clearInterval(timer);
  }, [pollingId, token]);

  async function generate(retry = false) {
    if (!token || creating.current || (retry && !requestId)) return;
    const id = retry ? requestId! : crypto.randomUUID();
    const generation = epoch.current;
    recordSequences.current.set(id, (recordSequences.current.get(id) ?? 0) + 1);
    creating.current = true;
    pollAttempts.current = 0;
    changeRequestId(id);
    update(generation, (previous) => ({
      ...previous,
      selected: id,
      creating: true,
      error: '',
      pollingStopped: false,
    }));
    try {
      const { brief } = await api<BriefResponse>('incident-brief', {
        incident: incidentId,
        requestId: id,
      });
      if (generation === epoch.current)
        recordSequences.current.set(id, (recordSequences.current.get(id) ?? 0) + 1);
      update(generation, (previous) => ({
        ...previous,
        records: mergeRecord(previous.records, brief),
      }));
    } catch (e) {
      if (generation === epoch.current && e instanceof BriefRequestError && e.payload.brief)
        recordSequences.current.set(id, (recordSequences.current.get(id) ?? 0) + 1);
      update(generation, (previous) => {
        const payload = e instanceof BriefRequestError ? e.payload : null;
        return {
          ...previous,
          records: payload?.brief ? mergeRecord(previous.records, payload.brief) : previous.records,
          list:
            payload && previous.list
              ? {
                  ...previous.list,
                  quota: payload.quota ?? previous.list.quota,
                  capability: payload.capability ?? previous.list.capability,
                  admission: payload.admission ?? previous.list.admission,
                }
              : previous.list,
          error:
            payload?.code === 'brief-record-limit' || payload?.code === 'brief-record-size'
              ? `${(e as Error).message} No new brief record was stored and no AI attempt was used. Stored briefs remain readable. The request ID is retained; this request will not retry automatically.`
              : `${(e as Error).message} The same request ID is retained; retrieve its stored state before requesting another brief.`,
        };
      });
    } finally {
      if (generation === epoch.current) {
        creating.current = false;
        update(generation, (previous) => ({ ...previous, creating: false }));
        loadList(generation);
      }
    }
  }
  const unknownRequest = Boolean(requestId && !requested);
  const canGenerate =
    visible?.list?.capability === 'enabled' &&
    !visible.creating &&
    !unknownRequest &&
    !upgradeDayClosed &&
    Boolean(
      admission &&
      admission.remaining > 0 &&
      admission.retainedRecords < admission.maxRetainedRecords,
    ) &&
    (quota?.remaining ?? 0) > 0 &&
    quota?.nextAllowedAt === null &&
    quota.pendingUntil === null;
  const choices = Object.values(visible?.records ?? {}).sort((a, b) => b.createdAt - a.createdAt);

  return (
    <section className="investigation-section incident-brief" aria-labelledby={headingId}>
      <div className="investigation-section-heading">
        <h3 id={headingId}>
          <FileText size={16} /> Private incident brief
        </h3>
        <button
          className="button"
          disabled={visible?.reading || visible?.creating}
          onClick={refresh}
        >
          <RefreshCw size={14} /> Retrieve latest
        </button>
      </div>
      <p className="investigation-help">
        A brief freezes a bounded observation snapshot and adds possible explanations. AI output is
        unverified; it does not establish a root cause, execute actions, or change monitoring.
      </p>
      {visible?.error && (
        <p className="error-banner" role="alert">
          {visible.error}
        </p>
      )}
      {!visible?.list ? (
        <p className="investigation-help" role="status">
          {visible?.reading
            ? 'Checking brief availability…'
            : 'Brief availability is unknown. Retrieve latest to try again.'}
        </p>
      ) : (
        <>
          <div className="brief-controls">
            <button className="button primary" disabled={!canGenerate} onClick={() => generate()}>
              {visible.creating
                ? 'Requesting…'
                : requestId || choices.length
                  ? 'Generate a new brief'
                  : 'Generate brief'}
            </button>
            {unknownRequest && (
              <button
                className="button"
                disabled={visible.creating || visible.list.capability === 'disabled'}
                onClick={() => generate(true)}
              >
                Retry same request
              </button>
            )}
          </div>
          {visible.list.capability === 'disabled' && (
            <p className="brief-caution" role="status">
              AI generation is unavailable in this deployment. Previously stored briefs remain
              available for inspection.
            </p>
          )}
          <p className="brief-quota">
            Deployment limit: 4 AI attempts per UTC day · at most 1 per UTC minute · 1 pending
            request. {quota?.attempts ?? 0} used on {quota?.day}; {quota?.remaining ?? 0} remaining.
            {quota?.nextAllowedAt !== null &&
              quota?.nextAllowedAt !== undefined &&
              ` Next attempt may be allowed after ${when(quota.nextAllowedAt)}.`}
            {quota?.pendingUntil !== null &&
              quota?.pendingUntil !== undefined &&
              ` A request may remain pending until ${when(quota.pendingUntil)}.`}{' '}
            Retrieve latest to recheck availability; retrieval does not run AI.
          </p>
          <p className="brief-quota">
            {admission ? (
              <>
                Brief storage across the deployment:{' '}
                {upgradeDayClosed
                  ? `At least ${admission.recordsCreated} known record creations on ${admission.day}; earlier deleted records cannot be counted.`
                  : `${admission.recordsCreated} / ${admission.maxRecordsPerDay} new records on ${admission.day}; ${admission.remaining} remaining today.`}{' '}
                {admission.retainedRecords} / {admission.maxRetainedRecords} retained records.
                Maximum {Math.round(admission.maxRecordBytes / 1024)} KiB per new record. Storage
                limits apply even when a brief runs no AI; they are separate from the AI attempt
                quota.
              </>
            ) : (
              'Brief storage availability is unknown. Retrieve latest before creating a new record.'
            )}
          </p>
          {(upgradeDayClosed || dailyRecordLimit || retainedRecordLimit) && (
            <p className="brief-caution" role="status">
              {upgradeDayClosed
                ? 'New brief admission is closed for this UTC day after a storage-limit upgrade; retained briefs remain available. Recheck after the next UTC day starts.'
                : 'New brief records cannot be stored.'}
              {dailyRecordLimit &&
                ' The daily record allowance is exhausted; recheck after the next UTC day starts.'}
              {retainedRecordLimit &&
                ' Retained record capacity is full; recheck after retention cleanup.'}{' '}
              Stored briefs remain retrievable, and retrying the same request ID can retrieve an
              existing record without creating another one.
            </p>
          )}
          {quota?.remaining === 0 && (
            <p className="brief-caution" role="status">
              The deployment’s AI attempt quota is exhausted for this UTC day. Stored briefs remain
              retrievable; recheck availability after the next UTC day starts.
            </p>
          )}
        </>
      )}
      {requestId && <p className="brief-request-id mono">Retained request ID: {requestId}</p>}
      {choices.length > 0 && (
        <div className="brief-history">
          <label htmlFor={historyId}>
            Stored briefs · latest five plus this session’s retrieved requests
          </label>
          <select
            id={historyId}
            value={visible?.selected ?? ''}
            onChange={(event) => {
              const id = event.target.value;
              pollAttempts.current = 0;
              update(epoch.current, (previous) => ({
                ...previous,
                selected: id,
                pollingStopped: false,
              }));
              loadBrief(id);
            }}
          >
            {unknownRequest && (
              <option value={requestId!}>Retained request · result not retrieved</option>
            )}
            {choices.map((brief) => (
              <option key={brief.requestId} value={brief.requestId}>
                {when(brief.createdAt)} · {stateLabels[brief.state]}
              </option>
            ))}
          </select>
        </div>
      )}
      {selected ? (
        <>
          <div className={`brief-state ${selected.state}`} role="status">
            <strong>{stateLabels[selected.state]}</strong>
            {selected.state === 'pending' && (
              <p>
                This stored request is awaiting a result. Automatic retrieval uses GET requests only
                and stops after eight attempts. Closing this workspace does not undo a server
                request.
              </p>
            )}
            {visible?.pollingStopped && selected.state === 'pending' && (
              <p>
                Automatic retrieval has paused. Use Retrieve latest to inspect this same request.
              </p>
            )}
            {selected.failure && (
              <p>
                {selected.failure.message} ({selected.failure.code})
              </p>
            )}
            {selected.state === 'insufficient-evidence' && (
              <p>
                The frozen snapshot has no verified bad-check evidence to explain. No AI inference
                was run.
              </p>
            )}
          </div>
          <FrozenEvidence evidence={selected.evidence} />
          <div className="brief-explanations">
            <h4>Possible explanations · AI-generated, unverified</h4>
            <p className="brief-quota">
              {selected.inputBytes > 0
                ? `The prepared model input contains ${selected.promptEvidenceIds.length} validated evidence references.${selected.omittedEvidenceCount > 0 ? ` ${selected.omittedEvidenceCount} other references were omitted from the bounded model input.` : ''}`
                : 'No model input was prepared for this stored request.'}{' '}
              The stored observation snapshot remains available for independent inspection.
            </p>
            {selected.generated?.hypotheses.length ? (
              selected.generated.hypotheses.map((hypothesis, index) => (
                <article key={index}>
                  <p>{hypothesis.explanation}</p>
                  <div className="brief-citations">
                    {hypothesis.evidenceIds.map((id) => {
                      const reference = selected.evidence.references.find((item) => item.id === id);
                      return reference ? (
                        <details key={id}>
                          <summary>{reference.label}</summary>
                          <p>{reference.detail}</p>
                          <small className="mono">{reference.id} · frozen snapshot</small>
                        </details>
                      ) : (
                        <span key={id}>Stored reference unavailable: {id}</span>
                      );
                    })}
                  </div>
                  <p className="brief-next-label">
                    Suggested checks for an operator; none are executed:
                  </p>
                  <ul>
                    {hypothesis.nextChecks.map((step) => (
                      <li key={step}>{nextCheckLabels[step]}</li>
                    ))}
                  </ul>
                </article>
              ))
            ) : (
              <p>
                {selected.state === 'complete'
                  ? 'The model returned no supported explanation. The captured evidence remains available above.'
                  : 'No validated AI explanation is available for this request.'}
              </p>
            )}
          </div>
          <details className="brief-provenance">
            <summary>Request provenance and frozen evidence hash</summary>
            <dl>
              <div>
                <dt>Request ID</dt>
                <dd className="mono">{selected.requestId}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{when(selected.createdAt)}</dd>
              </div>
              <div>
                <dt>Completed</dt>
                <dd>{when(selected.completedAt)}</dd>
              </div>
              <div>
                <dt>Snapshot captured</dt>
                <dd>{when(selected.evidence.capturedAt)}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd className="mono">{selected.model}</dd>
              </div>
              <div>
                <dt>Evidence / prompt version</dt>
                <dd>
                  {selected.evidenceSchemaVersion} / {selected.promptVersion}
                </dd>
              </div>
              <div>
                <dt>Model input size</dt>
                <dd>
                  {selected.messageBytes} message bytes · {selected.inputBytes} total bytes
                </dd>
              </div>
              <div>
                <dt>SHA-256 evidence hash</dt>
                <dd className="mono">{selected.evidenceHash}</dd>
              </div>
            </dl>
          </details>
        </>
      ) : !visible?.reading && !visible?.creating && choices.length === 0 && !requestId ? (
        <p className="investigation-help">No briefs have been stored for this incident.</p>
      ) : null}
    </section>
  );
}

function FrozenEvidence({ evidence }: { evidence: BriefEvidence }) {
  const facts = evidence.facts;
  const limits = evidence.limits;
  return (
    <div className="brief-observed">
      <h4>Observed evidence · frozen at {when(evidence.capturedAt)}</h4>
      <p>
        These counts come from stored monitoring observations, not the model. They describe one
        sampled observation point and do not measure customer-request availability.
      </p>
      <dl className="brief-facts">
        <div>
          <dt>Recorded checks</dt>
          <dd>{facts.recordedChecks}</dd>
        </div>
        <div>
          <dt>Verified good / bad</dt>
          <dd>
            {facts.goodChecks} / {facts.badChecks}
          </dd>
        </div>
        <div>
          <dt>Verified maintenance</dt>
          <dd>{facts.maintenanceChecks}</dd>
        </div>
        <div>
          <dt>Legacy / invalid timing</dt>
          <dd>
            {facts.legacyChecks} / {facts.invalidTimingChecks}
          </dd>
        </div>
        <div>
          <dt>Missing minutes in selected slice</dt>
          <dd>{facts.missingMinutesWithinSlice ?? 'Unavailable'}</dd>
        </div>
        <div>
          <dt>Verified coverage · finished selected slice</dt>
          <dd>
            {facts.verifiedCoveragePercentWithinFinishedSlice === null
              ? 'Unavailable'
              : `${facts.verifiedCoveragePercentWithinFinishedSlice.toFixed(1)}%`}
          </dd>
        </div>
        <div>
          <dt>Finished eligible / expected minutes</dt>
          <dd>
            {facts.finishedEligibleMinutesWithinSlice ?? 'Unavailable'} /{' '}
            {facts.finishedExpectedMinutesWithinSlice ?? 'Unavailable'}
          </dd>
        </div>
      </dl>
      <p className="brief-caution">
        Snapshot limited to {limits.checkLimit} checks.
        {limits.checksOmitted > 0 && ` ${limits.checksOmitted} loaded checks omitted.`}
        {limits.olderPagesAvailable && ' Older observation pages exist and are not included.'}
        {limits.limitedByRetention && ' Earlier evidence passed the retention boundary.'}
        {limits.includesCurrentMinute &&
          ' A check from the current minute is included; this is an incident snapshot, not a finished-minute SLO report.'}
        {limits.missingPolicyRevisions.length > 0 &&
          ` Policy context is unavailable for revisions ${limits.missingPolicyRevisions.join(', ')}.`}
        {limits.recoveredPolicyRevisions.length > 0 &&
          ` Revisions ${limits.recoveredPolicyRevisions.join(', ')} have recovered current-policy context; earlier settings cannot be reconstructed.`}{' '}
        Coverage applies only to finished minutes in this selected slice; it does not cover the full
        incident. Gaps and unverified timing cannot prove recovery. Response bodies and private
        notes are not included.
      </p>
      <details className="brief-snapshot">
        <summary>Inspect stored snapshot · observations, policies, and lifecycle</summary>
        <div
          className="brief-snapshot-table"
          role="region"
          aria-label="Frozen brief observations"
          tabIndex={0}
        >
          <table>
            <caption>Captured observations · newest first · local timezone</caption>
            <thead>
              <tr>
                <th>Scheduled minute</th>
                <th>Observed at</th>
                <th>Outcome</th>
                <th>Timing</th>
                <th>Policy</th>
              </tr>
            </thead>
            <tbody>
              {evidence.checks.map((check) => (
                <tr key={check.id}>
                  <td>{when(check.slot * 60000)}</td>
                  <td>{check.observedAt === null ? 'Unavailable' : when(check.observedAt)}</td>
                  <td>
                    {check.outcome} · HTTP {check.status ?? '—'} · {check.latency} ms
                  </td>
                  <td>{check.timing}</td>
                  <td>v{check.revision}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {evidence.versions.map((version) => (
          <details className="brief-snapshot-policy" key={version.id}>
            <summary>
              Policy v{version.revision} · {version.name}
            </summary>
            <p>
              Recorded {when(version.recordedAt)} · {version.provenance} · {version.transport} ·{' '}
              {version.assertion}
            </p>
            <p>
              Good-check target {version.policy.availabilityTarget}% · latency objective{' '}
              {version.policy.latencyObjectiveMs} ms · timeout {version.policy.timeoutMs} ms ·
              failure/recovery thresholds {version.policy.failureThreshold}/
              {version.policy.recoveryThreshold} ·{' '}
              {version.policy.paused ? 'maintenance paused' : 'active'}
            </p>
          </details>
        ))}
        <ul className="brief-snapshot-lifecycle">
          {evidence.lifecycle.map((event) => (
            <li key={event.id}>
              {event.action} · {when(event.at)}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
