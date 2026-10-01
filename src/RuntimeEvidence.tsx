import { useId, useState } from 'react';
import {
  runtimeEvidence,
  statusReuseMeasurements,
  type RuntimeEvidenceProfile,
} from './runtime-evidence';
import './runtime-evidence.css';

const labels: Record<string, string> = {
  'storage-miss': 'Storage miss',
  'authoritative-export': 'Authoritative export',
  'concurrent-hits': 'Concurrent warm hits',
  'sequential-hits': 'Sequential warm hits',
};
const number = (value: number) => value.toLocaleString('en-US');
const utc = (value: string) => value.replace('T', ' ').replace('Z', ' UTC');

/** Static recorded evidence: selection never invokes the application or a runtime. */
export function RuntimeEvidence() {
  const headingId = useId();
  const targetsId = useId();
  const windowId = useId();
  const tableId = useId();
  const [targetCount, setTargetCount] = useState(2);
  const [window, setWindow] = useState('24h');
  const selection = statusReuseMeasurements(targetCount, window);
  if (!selection) return null;
  const { profile, selected } = selection;
  const source = runtimeEvidence.source;
  const limits = runtimeEvidence.limits;
  const windowLabel = window === '24h' ? '24-hour' : '7-day';

  return (
    <section className="panel runtime-evidence" aria-labelledby={headingId}>
      <div className="eyebrow">DURABLE OBJECTS / RECORDED RUNTIME EVIDENCE</div>
      <h2 id={headingId}>Reuse a view. Keep the original check times.</h2>
      <p>
        Compare actual SQLite work for a public view read from storage and warm request batches.
        This is a pinned {source.projectVersion} local workerd test, not a live benchmark. Changing
        these controls makes no API calls.
      </p>
      <fieldset className="runtime-controls">
        <legend>Choose a measured workload</legend>
        <div>
          <label htmlFor={targetsId}>Monitored targets</label>
          <select
            id={targetsId}
            value={targetCount}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (statusReuseMeasurements(next, window)) setTargetCount(next);
            }}
          >
            {runtimeEvidence.profiles.map((entry) => (
              <option key={entry.targetCount} value={entry.targetCount}>
                {entry.targetCount} targets
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={windowId}>Reporting window</label>
          <select
            id={windowId}
            value={window}
            onChange={(event) => {
              if (statusReuseMeasurements(targetCount, event.target.value))
                setWindow(event.target.value);
            }}
          >
            <option value="24h">24 hours</option>
            <option value="7d">7 days</option>
          </select>
        </div>
      </fieldset>
      <p className="runtime-announcement" role="status" aria-live="polite" aria-atomic="true">
        Showing {targetCount} targets and {windowLabel} reporting. Totals use the request count
        shown.
      </p>
      <div className="runtime-table" role="region" aria-labelledby={tableId} tabIndex={0}>
        <table>
          <caption id={tableId}>
            Measured totals · {targetCount} targets · {windowLabel} reporting
          </caption>
          <thead>
            <tr>
              <th scope="col">Request group</th>
              <th scope="col">HTTP requests</th>
              <th scope="col">SQL attempts</th>
              <th scope="col">Completed SQL</th>
              <th scope="col">Rows read</th>
              <th scope="col">Rows written</th>
              <th scope="col">KV / storage / alarm calls</th>
            </tr>
          </thead>
          <tbody>
            {selected.measurements.map((measurement) => (
              <tr key={measurement.id}>
                <th scope="row">{labels[measurement.id]}</th>
                <td>{number(measurement.requests)}</td>
                <td>{number(measurement.attemptedStatements)}</td>
                <td>{number(measurement.statements)}</td>
                <td>{number(measurement.rowsRead)}</td>
                <td>{number(measurement.rowsWritten)}</td>
                <td>
                  {measurement.kvCalls} / {measurement.storageCalls} / {measurement.alarmCalls}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="runtime-note">
        Each row shows total work for a measured request group. Warm batches reuse an already
        materialized view. Completed SQL and rows come from consumed SQLite cursors;
        KV/storage/alarm values count method calls. These are not CPU, billing or
        production-capacity measurements.
      </p>
      <details className="runtime-details">
        <summary>What makes the zero-storage result safe to interpret?</summary>
        <p>
          Reuse requires age below {limits.maxAgeMs / 1000} seconds, the same UTC minute and no
          relevant intervening commit. At most {limits.maxEntries} reporting windows share{' '}
          {number(limits.maxCombinedSerializedBytes)} serialized UTF-8 bytes (1 MiB), including
          internal budget-age metadata. This is a retained-content limit, not a heap measurement.
          Oversized views remain complete and uncached; eviction loses only disposable memory.
        </p>
        <p>
          Serving a hit preserves actual observation, evaluation, scheduler and cleanup timestamps.
          Current status and readiness age against delivery time. Export, readiness and private
          evidence bypass reuse. An unobserved storage outage can remain hidden for less than ten
          seconds; an observed failure clears the cache and never falls back to an old success.
        </p>
        <p className="runtime-note">Recorded timing proof: {profile.sourceTimesProof}</p>
        <p className="runtime-note">
          The fixture has {number(profile.fixture.finishedHistorySlotsPerTarget)} finished slots and{' '}
          {number(profile.fixture.retainedFinishedChecksPerTarget)} retained checks per target, a
          complete latest hour, older gaps/legacy timing/maintenance and{' '}
          {profile.fixture.recentSchedulerEvents} scheduler events. Baseline profiling has no
          incident. Constructor, enrollment, bootstrap and eviction are profiled separately.
          Object-request overhead, CPU and billing are not measured by the zero-storage counters.
        </p>
      </details>
      <details className="runtime-details">
        <summary>Inspect actual SQLite failures and rollback</summary>
        <p>
          These controlled cases execute native SQLite missing-table exceptions. Successful cursor
          work is counted; the failed attempt produces no cursor, so its row cost is unknown.
        </p>
        <FailureEvidence
          title="Policy write failure"
          failure={profile.policyFailure}
          result="The selected source write executed; source and queue changes rolled back together."
        />
        <FailureEvidence
          title="Status read failure"
          failure={profile.readFailure}
          result="Both windows cleared, including another view only one millisecond old."
        />
        <p className="runtime-note">
          Both returned a sanitized 503 and served no stale-success fallback. Consumed writes are
          work measured before rollback, not committed policy changes. No failed-attempt cost is
          added to those known cursor counts.
        </p>
      </details>
      <details className="runtime-details runtime-provenance">
        <summary>Inspect pinned artifact, runtime and source hashes</summary>
        <p>
          Measured {utc(source.measuredAt)} · source version {source.projectVersion} ·{' '}
          {source.proofGroups} passing proof groups · source hashes stable during the run.
        </p>
        <p>
          {source.runtime.workerd} workerd · Miniflare {source.runtime.miniflare} · Node{' '}
          {source.runtime.node} · compatibility date {source.runtime.compatibilityDate}. Production
          requests, account calls and native AI calls were all zero.
        </p>
        <p>
          Check out the pinned artifact commit and run <code>{source.command}</code> locally. This
          panel reads a thin bundled projection; it does not run that command. Hashes identify the
          pinned artifact and source bytes, rather than certify authenticity or establish production
          savings.
        </p>
        <dl>
          <div>
            <dt>Artifact</dt>
            <dd>
              <a href={source.artifactURL} target="_blank" rel="noreferrer">
                {source.artifactPath} ↗
              </a>
            </dd>
          </div>
          <div>
            <dt>Artifact commit</dt>
            <dd>
              <code>{source.artifactCommit}</code>
            </dd>
          </div>
          <div>
            <dt>Artifact SHA-256</dt>
            <dd>
              <code>{source.artifactSHA256}</code>
            </dd>
          </div>
          <div>
            <dt>Worker bundle SHA-256</dt>
            <dd>
              <code>{source.bundleSHA256}</code>
            </dd>
          </div>
          {source.sourceSHA256.map((entry) => (
            <div key={entry.path}>
              <dt>{entry.path}</dt>
              <dd>
                <code>{entry.sha256}</code>
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}

function FailureEvidence({
  title,
  failure,
  result,
}: {
  title: string;
  failure: RuntimeEvidenceProfile['policyFailure'] | RuntimeEvidenceProfile['readFailure'];
  result: string;
}) {
  return (
    <div className="runtime-failure">
      <h3>{title}</h3>
      <p>{result}</p>
      <dl>
        <div>
          <dt>Attempted / completed SQL</dt>
          <dd>
            {failure.attemptedStatements} / {failure.consumedStatements}
          </dd>
        </div>
        <div>
          <dt>Known cursor reads / writes</dt>
          <dd>
            {failure.consumedCursorRowsRead} / {failure.consumedCursorRowsWritten}
          </dd>
        </div>
        <div>
          <dt>Failed attempts</dt>
          <dd>{failure.failedAttempts}</dd>
        </div>
        <div>
          <dt>Failed-attempt row cost</dt>
          <dd>Unknown (null)</dd>
        </div>
      </dl>
    </div>
  );
}
