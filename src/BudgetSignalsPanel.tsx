import { useEffect, useId, useMemo, useState } from 'react';
import { Activity, Clock3, Flame, ShieldAlert } from 'lucide-react';
import type { BudgetSignalSnapshot } from '../worker/budget-signals';
import { MONITOR_FRESHNESS_MS } from '../worker/monitor-readiness';
import './budget-signals.css';

type Evaluation = NonNullable<BudgetSignalSnapshot['evaluation']>;
type Rule = Evaluation['rules'][number];
type Window = Rule['long'];
const when = (at: number) => new Date(at).toLocaleString();
const duration = (minutes: number) =>
  minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes} min`;
const ratio = (value: number | null) =>
  value === null ? '—' : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}×`;
const percent = (value: number | null) => (value === null ? '—' : `${value.toFixed(1)}%`);
const ruleLabels: Record<string, string> = {
  firing: 'Warning firing',
  clear: 'Below trigger',
  'insufficient-evidence': 'More evidence needed',
  maintenance: 'Maintenance',
};

export function BudgetSignalsPanel({
  budget,
  snapshotNow,
}: {
  budget: BudgetSignalSnapshot;
  snapshotNow: number;
}) {
  const titleId = useId();
  // Server age plus a monotonic elapsed clock remains honest when refreshes fail,
  // without relying on the browser's potentially skewed wall-clock time.
  const clockAnchor = useMemo(() => performance.now(), [budget, snapshotNow]);
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setClockTick((tick) => tick + 1), 15000);
    return () => clearInterval(timer);
  }, [clockAnchor]);
  const evaluation = budget.evaluation;
  const snapshotAge = evaluation ? snapshotNow - evaluation.computedAt : null;
  const age =
    snapshotAge === null ? null : snapshotAge + Math.max(0, performance.now() - clockAnchor);
  const effectiveStatus =
    budget.evaluationStatus === 'current' &&
    age !== null &&
    (!Number.isFinite(snapshotAge) ||
      (snapshotAge !== null && snapshotAge < 0) ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > MONITOR_FRESHNESS_MS)
      ? 'stale'
      : budget.evaluationStatus;
  const current = effectiveStatus === 'current';
  const status = !current ? effectiveStatus : (evaluation?.state ?? 'not-evaluated');
  const title =
    status === 'firing'
      ? 'Error budget is burning quickly'
      : status === 'clear'
        ? 'No qualifying budget warning'
        : status === 'maintenance'
          ? 'Budget evaluation paused for maintenance'
          : status === 'policy-changed'
            ? 'Waiting for evidence under the new policy'
            : status === 'stale'
              ? 'Budget evaluation needs fresh evidence'
              : status === 'not-evaluated'
                ? 'First budget evaluation pending'
                : 'More evidence is needed';
  const previous = budget.lastFiring;
  const priorRule = evaluation?.rules.find((rule) => rule.id === previous?.rule);
  const priorCleared =
    previous !== null &&
    current &&
    evaluation?.revision === previous.revision &&
    priorRule?.state === 'clear';
  const priorCurrent =
    previous !== null &&
    current &&
    evaluation?.revision === previous.revision &&
    priorRule?.state === 'firing';
  const priorPolicyChanged =
    previous !== null &&
    (effectiveStatus === 'policy-changed' ||
      (evaluation !== null && evaluation.revision !== previous.revision));

  return (
    <section className={`budget-signals ${status}`} aria-labelledby={titleId}>
      <div className="budget-signals-heading">
        <div>
          <h3 id={titleId}>
            {status === 'firing' ? <Flame size={16} /> : <Activity size={16} />}
            Error budget signals
          </h3>
          <p className="budget-signals-summary">{title}</p>
        </div>
        {evaluation && (
          <div className="budget-evaluation-time">
            <span>{current ? 'Evaluated' : 'Last recorded evaluation'}</span>
            <time dateTime={new Date(evaluation.computedAt).toISOString()}>
              {when(evaluation.computedAt)}
            </time>
            <small>Policy v{evaluation.revision}</small>
          </div>
        )}
      </div>
      {!current && (
        <p className="budget-evidence-warning" role="status">
          <Clock3 size={14} />
          {effectiveStatus === 'not-evaluated'
            ? 'A scheduled monitoring run must record the first evaluation.'
            : effectiveStatus === 'policy-changed'
              ? 'The retained evaluation belongs to the previous policy. Its result does not establish the current budget state.'
              : 'The retained evaluation is stale. A dashboard refresh cannot confirm that a budget warning has cleared.'}
        </p>
      )}
      {evaluation && (
        <div className="budget-rules">
          {evaluation.rules.map((rule) => (
            <details className={`budget-rule ${current ? rule.state : 'historical'}`} key={rule.id}>
              <summary>
                <div>
                  <strong>{rule.name}</strong>
                  <small>
                    {duration(rule.long.minutes)} + {duration(rule.short.minutes)} · trigger{' '}
                    {ratio(rule.threshold)}
                  </small>
                </div>
                <span className="budget-rule-state">
                  {!current && 'Recorded: '}
                  {ruleLabels[rule.state] ?? rule.state}
                </span>
              </summary>
              <div className="budget-rule-detail">
                <p>{rule.reason}</p>
                <WindowEvidence long={rule.long} short={rule.short} />
              </div>
            </details>
          ))}
        </div>
      )}
      {previous && (
        <details className="budget-prior-signal">
          <summary>
            <ShieldAlert size={14} />
            {priorCurrent
              ? 'Current firing evidence'
              : priorCleared
                ? 'Previous warning is below its trigger'
                : priorPolicyChanged
                  ? 'Warning retained from a previous policy'
                  : 'Previous warning has no confirmed clearance'}
          </summary>
          <div className="budget-prior-detail">
            <p>
              {priorCurrent
                ? 'Both windows still meet this warning’s trigger.'
                : priorCleared
                  ? `The same rule and policy were below the trigger at ${when(evaluation!.computedAt)}.`
                  : priorPolicyChanged
                    ? 'A policy change preserves historical firing evidence. New-policy observations must qualify independently.'
                    : status === 'maintenance'
                      ? 'Maintenance pauses evaluation; it does not establish recovery.'
                      : 'Missing, stale, or insufficient observations do not prove that the warning stopped firing.'}
            </p>
            <dl className="budget-prior-times">
              <div>
                <dt>Rule</dt>
                <dd>{previous.evidence.name}</dd>
              </div>
              <div>
                <dt>Policy</dt>
                <dd>v{previous.revision}</dd>
              </div>
              <div>
                <dt>First fired</dt>
                <dd>{when(previous.firstFiredAt)}</dd>
              </div>
              <div>
                <dt>Last confirmed firing</dt>
                <dd>{when(previous.lastConfirmedAt)}</dd>
              </div>
            </dl>
            <WindowEvidence long={previous.evidence.long} short={previous.evidence.short} />
          </div>
        </details>
      )}
      <p className="budget-signals-method">
        Signals use one sampled check per minute and a 30-day check-budget basis. Each pair needs
        complete windows, at least 95% verified coverage, five short-window samples, and twenty
        long-window samples under the current policy. They describe probe observations rather than
        customer-request availability. Warnings appear in this application; external notifications
        are not sent.
      </p>
    </section>
  );
}
function WindowEvidence({ long, short }: { long: Window; short: Window }) {
  return (
    <div
      className="budget-window-table"
      role="region"
      aria-label="Paired budget window evidence"
      tabIndex={0}
    >
      <table>
        <caption>Persisted paired-window evidence · finished scheduled minutes</caption>
        <thead>
          <tr>
            <th>Evidence</th>
            <th>Long window · {duration(long.minutes)}</th>
            <th>Short window · {duration(short.minutes)}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>Burn rate</th>
            <td>{ratio(long.burnRate)}</td>
            <td>{ratio(short.burnRate)}</td>
          </tr>
          <tr>
            <th>Verified coverage</th>
            <td>{percent(long.coverage)}</td>
            <td>{percent(short.coverage)}</td>
          </tr>
          <tr>
            <th>Good / bad checks</th>
            <td>
              {long.good} / {long.bad}
            </td>
            <td>
              {short.good} / {short.bad}
            </td>
          </tr>
          <tr>
            <th>Verified observations</th>
            <td>{long.observed}</td>
            <td>{short.observed}</td>
          </tr>
          <tr>
            <th>Unknown minutes</th>
            <td>{long.unknown}</td>
            <td>{short.unknown}</td>
          </tr>
          <tr>
            <th>Maintenance minutes</th>
            <td>{long.maintenance}</td>
            <td>{short.maintenance}</td>
          </tr>
          <tr>
            <th>Expected minutes</th>
            <td>{long.expected}</td>
            <td>{short.expected}</td>
          </tr>
          <tr>
            <th>Window maturity</th>
            <td>{long.mature ? 'Policy covers full window' : 'Policy window incomplete'}</td>
            <td>{short.mature ? 'Policy covers full window' : 'Policy window incomplete'}</td>
          </tr>
          <tr className="budget-window-range">
            <th>Scheduled range</th>
            <td>
              {when(long.startSlot * 60000)}
              <br />
              to {when(long.endSlot * 60000)}
            </td>
            <td>
              {when(short.startSlot * 60000)}
              <br />
              to {when(short.endSlot * 60000)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
