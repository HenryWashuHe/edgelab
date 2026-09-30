import {
  evaluateBurnRates,
  type BurnRateCheck,
  type BurnRateEvaluation,
  type BurnRuleEvidence,
} from './burn-rate';
import { MINUTE, type MonitorPolicy } from './monitor-domain';

export type BudgetFiringEvidence = {
  firstFiredAt: number;
  lastConfirmedAt: number;
  revision: number;
  rule: string;
  evidence: BurnRuleEvidence;
};
export type BudgetSignalSnapshot = {
  evaluation: BurnRateEvaluation | null;
  evaluationStatus: 'current' | 'stale' | 'policy-changed' | 'not-evaluated';
  lastFiring: BudgetFiringEvidence | null;
};
export type BudgetSignalInput = {
  service: string;
  revision: number;
  policy: MonitorPolicy;
  policyRecordedAt: number;
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

/** One current evaluation and one retained warning per approved service; no delivery side effects. */
export class BudgetSignals {
  constructor(private readonly storage: DurableObjectStorage) {}

  ensureSchema() {
    this.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS budget_signals (service TEXT PRIMARY KEY, revision INTEGER NOT NULL, computed_at INTEGER NOT NULL, evaluation TEXT NOT NULL, last_firing TEXT)',
    );
  }

  private rows<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ) {
    return this.storage.sql.exec<T>(query, ...bindings).toArray();
  }

  update(input: BudgetSignalInput): BudgetSignalSnapshot {
    return this.storage.transactionSync(() => {
      const end = Math.floor(input.now / MINUTE) - 1;
      const checks = this.rows<BurnRateCheck>(
        'SELECT slot,observed_at AS observedAt,revision,outcome FROM checks WHERE service=? AND slot BETWEEN ? AND ? ORDER BY slot',
        input.service,
        end - MAX_WINDOW_MINUTES + 1,
        end,
      );
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
    const row = this.rows<SignalRow>('SELECT * FROM budget_signals WHERE service=?', service)[0];
    if (!row) return { evaluation: null, evaluationStatus: 'not-evaluated', lastFiring: null };
    const age = now - row.computed_at;
    const evaluationStatus =
      row.revision !== currentRevision
        ? 'policy-changed'
        : !Number.isFinite(now) || !Number.isFinite(age) || age < 0 || age > EVALUATION_FRESHNESS_MS
          ? 'stale'
          : 'current';
    return {
      evaluation: JSON.parse(row.evaluation) as BurnRateEvaluation,
      evaluationStatus,
      lastFiring:
        row.last_firing === null ? null : (JSON.parse(row.last_firing) as BudgetFiringEvidence),
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
