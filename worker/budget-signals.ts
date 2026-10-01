import { evaluateBurnRates, type BurnRateEvaluation, type BurnRuleEvidence } from './burn-rate';
import { MINUTE, type MonitorPolicy } from './monitor-domain';
import type { IncidentPolicyVersion } from './incident-evidence';
import { MonitorCheckCache } from './monitor-check-cache';

export type BudgetFiringEvidence = {
  firstFiredAt: number;
  lastConfirmedAt: number;
  revision: number;
  rule: string;
  evidence: BurnRuleEvidence;
  policyContext: IncidentPolicyVersion | null;
};
export type BudgetSignalSnapshot = {
  evaluation: BurnRateEvaluation | null;
  evaluationStatus: 'current' | 'stale' | 'policy-changed' | 'not-evaluated';
  lastFiring: BudgetFiringEvidence | null;
};
/** Cache-only source metadata. Freshness is authoritative to these SQL columns. */
export type BudgetAgeSource = { revision: number; computedAt: number } | null;
export type BudgetSignalMaterialization = {
  snapshot: BudgetSignalSnapshot;
  ageSource: BudgetAgeSource;
};
export type BudgetSignalInput = {
  service: string;
  revision: number;
  policy: MonitorPolicy;
  policyRecordedAt: number;
  policyContext: IncidentPolicyVersion;
  now: number;
};
type SignalRow = {
  service: string;
  revision: number;
  computed_at: number;
  evaluation: string;
  last_firing: string | null;
};
const MAX_WINDOW_MINUTES = 4320;
const EVALUATION_FRESHNESS_MS = 180000;

/** Age captured evidence without recomputing it or changing any recorded timestamp. */
export function projectBudgetSignal(
  snapshot: BudgetSignalSnapshot,
  source: BudgetAgeSource,
  currentRevision: number,
  now: number,
): BudgetSignalSnapshot {
  const age = source === null ? NaN : now - source.computedAt;
  return {
    ...snapshot,
    evaluationStatus:
      source === null
        ? 'not-evaluated'
        : source.revision !== currentRevision
          ? 'policy-changed'
          : !Number.isFinite(now) ||
              !Number.isFinite(age) ||
              age < 0 ||
              age > EVALUATION_FRESHNESS_MS
            ? 'stale'
            : 'current',
  };
}

/** One current evaluation and one retained warning per approved service; no delivery side effects. */
export class BudgetSignals {
  private readonly checkCache: MonitorCheckCache;
  private readonly ownsCheckCache: boolean;
  constructor(
    private readonly storage: DurableObjectStorage,
    checkCache?: MonitorCheckCache,
  ) {
    this.checkCache = checkCache ?? new MonitorCheckCache(storage);
    this.ownsCheckCache = checkCache === undefined;
  }

  ensureSchema() {
    this.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS budget_signals (service TEXT PRIMARY KEY, revision INTEGER NOT NULL, computed_at INTEGER NOT NULL, evaluation TEXT NOT NULL, last_firing TEXT)',
    );
    if (this.ownsCheckCache) this.checkCache.ensureSchema();
  }

  private rows<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ) {
    return this.storage.sql.exec<T>(query, ...bindings).toArray();
  }

  update(input: BudgetSignalInput): BudgetSignalSnapshot {
    if (
      input.policyContext.service !== input.service ||
      input.policyContext.revision !== input.revision ||
      input.policyContext.recordedAt !== input.policyRecordedAt ||
      JSON.stringify(input.policyContext.policy) !== JSON.stringify(input.policy)
    )
      throw new Error('Budget policy context must match the evaluated service revision and policy');
    return this.storage.transactionSync(() => {
      const end = Math.floor(input.now / MINUTE) - 1;
      const checks = this.checkCache
        .read(input.service, end)
        .filter((check) => check.slot >= end - MAX_WINDOW_MINUTES + 1);
      const evaluation = evaluateBurnRates({
        now: input.now,
        revision: input.revision,
        policyRecordedAt: input.policyRecordedAt,
        target: input.policy.availabilityTarget,
        paused: input.policy.paused,
        checks,
      });
      const previous = this.read(input.service, input.revision, input.now);
      let lastFiring = previous.lastFiring;
      if (evaluation.state === 'firing' && evaluation.highestFiring !== null) {
        const rule = evaluation.rules.find(
          (candidate) => candidate.id === evaluation.highestFiring && candidate.state === 'firing',
        );
        if (!rule) throw new Error('Firing evaluation must contain matching rule evidence');
        const continuing =
          previous.evaluationStatus === 'current' &&
          previous.evaluation?.state === 'firing' &&
          previous.evaluation.revision === input.revision &&
          previous.evaluation.highestFiring === rule.id &&
          lastFiring?.revision === input.revision &&
          lastFiring.rule === rule.id;
        lastFiring = {
          firstFiredAt: continuing ? lastFiring!.firstFiredAt : input.now,
          lastConfirmedAt: input.now,
          revision: input.revision,
          rule: rule.id,
          evidence: rule,
          policyContext:
            continuing && lastFiring!.policyContext !== null
              ? lastFiring!.policyContext
              : structuredClone({
                  service: input.policyContext.service,
                  revision: input.policyContext.revision,
                  recordedAt: input.policyContext.recordedAt,
                  name: input.policyContext.name,
                  transport: input.policyContext.transport,
                  assertion: input.policyContext.assertion,
                  policy: input.policyContext.policy,
                  provenance: input.policyContext.provenance,
                }),
        };
      }
      this.storage.sql.exec(
        'INSERT INTO budget_signals(service,revision,computed_at,evaluation,last_firing) VALUES(?,?,?,?,?) ON CONFLICT(service) DO UPDATE SET revision=excluded.revision,computed_at=excluded.computed_at,evaluation=excluded.evaluation,last_firing=excluded.last_firing',
        input.service,
        input.revision,
        input.now,
        JSON.stringify(evaluation),
        lastFiring === null ? null : JSON.stringify(lastFiring),
      );
      return { evaluation, evaluationStatus: 'current', lastFiring };
    });
  }

  /** Public reads only age persisted evidence; they never recompute or renew its timestamp. */
  read(service: string, currentRevision: number, now: number): BudgetSignalSnapshot {
    return this.materialize(service, currentRevision, now).snapshot;
  }

  /** One SQL read supplies both the public view and private metadata for clock projection. */
  materialize(service: string, currentRevision: number, now: number): BudgetSignalMaterialization {
    const row = this.rows<SignalRow>('SELECT * FROM budget_signals WHERE service=?', service)[0];
    if (!row)
      return {
        snapshot: { evaluation: null, evaluationStatus: 'not-evaluated', lastFiring: null },
        ageSource: null,
      };
    const lastFiring =
      row.last_firing === null ? null : (JSON.parse(row.last_firing) as BudgetFiringEvidence);
    const ageSource = { revision: row.revision, computedAt: row.computed_at };
    return {
      snapshot: projectBudgetSignal(
        {
          evaluation: JSON.parse(row.evaluation) as BurnRateEvaluation,
          evaluationStatus: 'current',
          lastFiring:
            lastFiring === null
              ? null
              : { ...lastFiring, policyContext: lastFiring.policyContext ?? null },
        },
        ageSource,
        currentRevision,
        now,
      ),
      ageSource,
    };
  }

  /** Retain warning history for configured services, even through a prolonged monitoring gap. */
  prune(cutoff: number, activeIds?: Iterable<string>) {
    const active = activeIds === undefined ? [] : [...new Set(activeIds)];
    if (!active.length) {
      this.storage.sql.exec('DELETE FROM budget_signals WHERE computed_at<?', cutoff);
      return;
    }
    this.storage.sql.exec(
      `DELETE FROM budget_signals WHERE computed_at<? AND service NOT IN (${active.map(() => '?').join(',')})`,
      cutoff,
      ...active,
    );
  }
}
