import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, FileText, Fingerprint } from 'lucide-react';
import {
  hashBriefEvidence,
  type BriefEvidence,
  type BriefNextCheck,
} from '../worker/incident-brief-domain';
import { briefExamples, briefExamplesSource, type BriefExample } from './brief-examples';
import './brief-examples.css';

const utc = (at: number) =>
  new Date(at)
    .toISOString()
    .replace('T', ' ')
    .replace(/(?:\.000)?Z$/, ' UTC');
const scenarioNames: Record<string, string> = {
  'http-recovery': 'HTTP errors and sampled recovery',
  'timeout-gaps': 'Timeouts and coverage gaps',
  'insufficient-history': 'Insufficient verified evidence',
};
const nextChecks: Record<BriefNextCheck, string> = {
  'inspect-service-logs': 'Inspect service logs',
  'compare-deployments': 'Compare deployment times with the observations',
  'verify-response-contract': 'Verify the response contract',
  'review-latency-and-timeout': 'Review latency and timeout settings',
  'compare-policy-versions': 'Compare the captured policy versions',
  'inspect-monitor-scheduler': 'Inspect scheduler diagnostics',
};

/** Public, bundled examples. Opening and inspecting them makes no API requests. */
export function BriefExamples() {
  const headingId = useId();
  const selectId = useId();
  const [selectedId, setSelectedId] = useState(briefExamples[0].id);
  const example = briefExamples.find((item) => item.id === selectedId) ?? briefExamples[0];
  const facts = example.evidence.facts;
  const skipped = example.disposition === 'insufficient-evidence';
  return (
    <section className="panel brief-examples" aria-labelledby={headingId}>
      <div className="eyebrow">WORKERS AI / CONTROLLED EXAMPLES</div>
      <h2 id={headingId}>
        <FileText size={20} /> Inspect the evidence behind a brief.
      </h2>
      <p className="examples-intro">
        See how frozen observations, bounded model input, and checked citations support an incident
        brief. Production briefs are private to authenticated operators; these examples are
        available to everyone.
      </p>
      <p className="examples-label">
        <strong>
          Controlled test data · human-authored canned explanations · zero native AI calls
        </strong>
        No production incident or operator data is used. This explorer reads bundled examples and
        does not change monitoring.
      </p>
      <div className="examples-selector">
        <label htmlFor={selectId}>Choose a controlled scenario</label>
        <select
          id={selectId}
          value={selectedId}
          onChange={(event) => {
            const selected = briefExamples.find((item) => item.id === event.target.value);
            if (selected) setSelectedId(selected.id);
          }}
        >
          {briefExamples.map((item) => (
            <option key={item.id} value={item.id}>
              {scenarioNames[item.id] ?? item.label}
            </option>
          ))}
        </select>
      </div>
      <p className="examples-disposition" role="status" aria-live="polite" aria-atomic="true">
        {scenarioNames[example.id] ?? example.label}:{' '}
        {skipped
          ? 'No verified bad evidence; prompt preparation and inference skipped.'
          : 'Canned response accepted by offline schema and citation validation.'}
      </p>
      <div key={example.id} className="examples-case">
        <h3>Observed evidence · controlled fixture</h3>
        <p>{example.description}</p>
        <p className="examples-meta">
          Frozen at {utc(example.capturedAt)} · historical test timestamps
          {example.evidence.incident.resolved !== null &&
            '. Recovery time is a supplied fixture lifecycle input.'}
        </p>
        <dl className="examples-facts">
          <div>
            <dt>Verified good / bad checks</dt>
            <dd>
              {facts.goodChecks} / {facts.badChecks}
            </dd>
          </div>
          <div>
            <dt>Finished-slice coverage</dt>
            <dd>
              {facts.verifiedCoveragePercentWithinFinishedSlice === null
                ? 'Unavailable'
                : `${facts.verifiedCoveragePercentWithinFinishedSlice.toFixed(1)}%`}
            </dd>
          </div>
          <div>
            <dt>Legacy / invalid timing</dt>
            <dd>
              {facts.legacyChecks} / {facts.invalidTimingChecks}
            </dd>
          </div>
          <div>
            <dt>Missing / maintenance minutes</dt>
            <dd>
              {facts.missingMinutesWithinSlice ?? 'Unknown'} / {facts.maintenanceChecks}
            </dd>
          </div>
        </dl>
        <p className="examples-meta">
          {facts.finishedEligibleMinutesWithinSlice ?? 'Unknown'} eligible finished minutes /{' '}
          {facts.finishedExpectedMinutesWithinSlice ?? 'unknown'} expected in this selected slice.
          Verified maintenance is excluded from the coverage denominator. Coverage describes sampled
          checks, not customer-request availability or the full incident.
        </p>
        <div className="examples-explanations">
          <h3>Canned explanations · unverified</h3>
          {skipped ? (
            <p className="examples-caution">
              The bad-looking records have legacy or invalid observation timing. With no verified
              bad check, this fixture prepares no prompt and dispatches no inference.
            </p>
          ) : (
            <>
              <p>
                Offline validation checks structure and relevance to supplied symptoms. Every
                proposed cause remains unverified; model quality is not measured.
              </p>
              {example.generated?.hypotheses.map((hypothesis, index) => (
                <article key={index}>
                  <p>{hypothesis.explanation}</p>
                  <div className="examples-citations">
                    {hypothesis.evidenceIds.map((id) => {
                      const reference = example.evidence.references.find((item) => item.id === id);
                      return reference ? (
                        <details key={id}>
                          <summary>Inspect citation: {reference.label}</summary>
                          <p>{reference.detail}</p>
                          <small className="mono">{reference.id} · supplied frozen reference</small>
                        </details>
                      ) : (
                        <p key={id}>Reference unavailable: {id}</p>
                      );
                    })}
                  </div>
                  <p className="examples-meta">Suggested manual checks; none are executed:</p>
                  <ul>
                    {hypothesis.nextChecks.map((step) => (
                      <li key={step}>{nextChecks[step]}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </>
          )}
        </div>
        <details className="examples-snapshot">
          <summary>Inspect frozen checks, policy, and fixture lifecycle</summary>
          <div
            className="examples-table"
            role="region"
            aria-label="Controlled frozen observations"
            tabIndex={0}
          >
            <table>
              <caption>Test observations · newest first · UTC</caption>
              <thead>
                <tr>
                  <th>Scheduled minute</th>
                  <th>Observed at</th>
                  <th>Outcome / HTTP</th>
                  <th>Elapsed / timing</th>
                  <th>Policy</th>
                </tr>
              </thead>
              <tbody>
                {example.evidence.checks.map((check) => (
                  <tr key={check.id}>
                    <td>{utc(check.slot * 60000)}</td>
                    <td>{check.observedAt === null ? 'Unavailable' : utc(check.observedAt)}</td>
                    <td>
                      {check.outcome} / {check.status ?? '—'}
                    </td>
                    <td>
                      {check.latency} ms / {check.timing}
                    </td>
                    <td>v{check.revision}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {example.evidence.versions.map((version) => (
            <details className="examples-policy" key={version.id}>
              <summary>Captured policy v{version.revision}</summary>
              <p>
                Recorded {utc(version.recordedAt)} · {version.provenance} · {version.transport} ·{' '}
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
          <p className="examples-meta">
            Lifecycle events are supplied test inputs. These examples do not exercise the scheduler
            or incident transition reducer.
          </p>
          <ul>
            {example.evidence.lifecycle.map((event) => (
              <li key={event.id}>
                {event.action} · {utc(event.at)}
              </li>
            ))}
          </ul>
        </details>
        <details className="examples-provenance">
          <summary>Inspect bounded input and verify the snapshot fingerprint</summary>
          <dl>
            <div>
              <dt>Source</dt>
              <dd>
                Archived evaluation v{briefExamplesSource.sourceProjectVersion} · controlled suite{' '}
                {briefExamplesSource.suiteVersion}
              </dd>
            </div>
            <div>
              <dt>Model setting</dt>
              <dd className="mono">
                {briefExamplesSource.model} · no native model call or compatibility verification
              </dd>
            </div>
            <div>
              <dt>Evidence / prompt version</dt>
              <dd>
                {briefExamplesSource.schemaVersion} / {briefExamplesSource.promptVersion}
              </dd>
            </div>
            <div>
              <dt>Prepared input</dt>
              <dd>
                {example.inputBytes === null
                  ? 'Not prepared'
                  : `${example.messageBytes} message bytes / ${example.inputBytes} total bytes`}
              </dd>
            </div>
            <div>
              <dt>Offline evaluation caps</dt>
              <dd>
                {briefExamplesSource.maxMessageBytes} message bytes /{' '}
                {briefExamplesSource.maxInputBytes} input bytes /{' '}
                {briefExamplesSource.maxOutputTokens} output tokens
              </dd>
            </div>
            <div>
              <dt>References supplied / omitted</dt>
              <dd>
                {example.omittedEvidenceCount === null
                  ? 'Not prepared'
                  : `${example.suppliedCitationIds.length} / ${example.omittedEvidenceCount}`}
              </dd>
            </div>
            <div>
              <dt>Prepared-input SHA-256</dt>
              <dd className="mono">{example.inputHash ?? 'Not prepared'}</dd>
            </div>
            <div>
              <dt>Expected snapshot SHA-256</dt>
              <dd className="mono">{example.evidenceHash}</dd>
            </div>
          </dl>
          <SnapshotFingerprint example={example} />
        </details>
      </div>
      <p className="examples-meta examples-source-links">
        <a href={briefExamplesSource.sourceArtifactURL} target="_blank" rel="noreferrer">
          Inspect the pinned evaluation artifact <ArrowUpRight size={13} />
        </a>
        <a href={briefExamplesSource.evaluationGuideURL} target="_blank" rel="noreferrer">
          Reproduce the offline checks <ArrowUpRight size={13} />
        </a>
      </p>
    </section>
  );
}

function SnapshotFingerprint({ example }: { example: BriefExample }) {
  const active = useRef(true);
  const sequence = useRef(0);
  const [result, setResult] = useState<{
    busy: boolean;
    computed?: string;
    altered?: string;
    error?: string;
  }>({ busy: false });
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      sequence.current++;
    };
  }, []);
  async function verify(compareAltered = false) {
    const current = ++sequence.current;
    setResult({ busy: true });
    try {
      const snapshot = structuredClone(example.evidence) as BriefEvidence;
      const computed = await hashBriefEvidence(snapshot);
      let altered: string | undefined;
      if (compareAltered && snapshot.checks[0]) {
        const copy = structuredClone(snapshot);
        copy.checks[0].latency += 1;
        altered = await hashBriefEvidence(copy);
      }
      if (active.current && current === sequence.current)
        setResult({ busy: false, computed, altered });
    } catch {
      if (active.current && current === sequence.current)
        setResult({
          busy: false,
          error:
            'Hash verification is unavailable in this browser. The original snapshot remains available.',
        });
    }
  }
  return (
    <div className="examples-fingerprint">
      <p>
        A SHA-256 hash is a content fingerprint. Matching it does not establish authenticity,
        monitoring recovery, or a root cause. Verification happens locally in your browser.
      </p>
      <div className="examples-actions">
        <button className="button" disabled={result.busy} onClick={() => verify()}>
          <Fingerprint size={15} /> Verify snapshot hash
        </button>
        <button
          className="button"
          disabled={result.busy || !example.evidence.checks.length}
          onClick={() => verify(true)}
        >
          Compare altered copy
        </button>
      </div>
      <div className="examples-hash-result">
        <p role="status" aria-live="polite" aria-atomic="true">
          {result.busy ? (
            'Computing local fingerprint…'
          ) : result.error ? (
            result.error
          ) : result.computed ? (
            <strong>
              {result.computed === example.evidenceHash
                ? 'Snapshot matches the expected fingerprint.'
                : 'Snapshot does not match the expected fingerprint.'}
              {result.altered &&
                (result.altered !== result.computed
                  ? ' The altered copy has a different fingerprint.'
                  : ' The altered copy has the same fingerprint.')}
            </strong>
          ) : null}
        </p>
        {!result.busy && result.computed && (
          <>
            <p className="mono">Computed SHA-256: {result.computed}</p>
            {result.altered && (
              <>
                <p>
                  Only the first check’s latency increases by 1 ms in the copy. Original evidence
                  and facts are unchanged.
                </p>
                <p className="mono">Altered-copy SHA-256: {result.altered}</p>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
