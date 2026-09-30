import type { ProbeResult } from './monitor-domain';

/** Calendar slots covered, including gaps; source checks always remain authoritative. */
export const MONITOR_CHECK_CACHE_SLOTS = 10080;
const CACHE_VERSION = 1;
export type CachedMonitorCheck = {
  service: string;
  slot: number;
  at: number;
  outcome: ProbeResult['outcome'];
  status: number | null;
  latency: number;
  revision: number;
  observedAt: number | null;
};
type CompactCheck = [
  number,
  number,
  ProbeResult['outcome'],
  number | null,
  number,
  number,
  number | null,
];
type CacheRow = {
  service: string;
  start_slot: number;
  end_slot: number;
  version: number;
  checks: string;
};
export type CheckCacheReadDiagnostics = {
  mode: 'bootstrap' | 'rebuild' | 'hit' | 'append' | 'repair';
  rowsRead: number;
  rowsWritten: number;
  sourceRowsRead: number;
  dirtySlots: number;
};
const OUTCOMES = [
  'good',
  'http-error',
  'timeout',
  'network-error',
  'invalid-body',
  'slow',
  'maintenance',
];
const safeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const nullableInteger = (value: unknown) => value === null || safeInteger(value);

/**
 * Persist a bounded raw-check projection so cron and dashboard work do not scan
 * a week of source rows repeatedly. Dirty slots repair actual source changes;
 * reads never create observations or renew monitoring/alert evidence timestamps.
 */
export class MonitorCheckCache {
  lastRead: CheckCacheReadDiagnostics | null = null;
  constructor(private readonly storage: DurableObjectStorage) {}

  ensureSchema() {
    const sql = this.storage.sql;
    sql.exec(
      'CREATE TABLE IF NOT EXISTS monitor_check_cache (service TEXT PRIMARY KEY, start_slot INTEGER NOT NULL, end_slot INTEGER NOT NULL, version INTEGER NOT NULL, checks TEXT NOT NULL)',
    );
    sql.exec(
      'CREATE TABLE IF NOT EXISTS monitor_check_dirty (service TEXT NOT NULL, slot INTEGER NOT NULL, PRIMARY KEY(service,slot))',
    );
    // Calendar coverage matters even when a slot had no check: a late completion
    // inserted into a previously missing minute must repair that same minute.
    sql.exec(
      `CREATE TRIGGER IF NOT EXISTS monitor_check_cache_insert AFTER INSERT ON checks BEGIN
        INSERT OR IGNORE INTO monitor_check_dirty(service,slot)
        SELECT NEW.service,NEW.slot FROM monitor_check_cache
        WHERE service=NEW.service AND NEW.slot BETWEEN start_slot AND end_slot;
      END`,
    );
    sql.exec(
      `CREATE TRIGGER IF NOT EXISTS monitor_check_cache_update AFTER UPDATE ON checks BEGIN
        INSERT OR IGNORE INTO monitor_check_dirty(service,slot)
        SELECT OLD.service,OLD.slot FROM monitor_check_cache
        WHERE service=OLD.service AND OLD.slot BETWEEN start_slot AND end_slot;
        INSERT OR IGNORE INTO monitor_check_dirty(service,slot)
        SELECT NEW.service,NEW.slot FROM monitor_check_cache
        WHERE service=NEW.service AND NEW.slot BETWEEN start_slot AND end_slot;
      END`,
    );
    sql.exec(
      `CREATE TRIGGER IF NOT EXISTS monitor_check_cache_delete AFTER DELETE ON checks BEGIN
        INSERT OR IGNORE INTO monitor_check_dirty(service,slot)
        SELECT OLD.service,OLD.slot FROM monitor_check_cache
        WHERE service=OLD.service AND OLD.slot BETWEEN start_slot AND end_slot;
      END`,
    );
  }

  /** Derived data only: use after source-schema migration, never delete checks. */
  invalidateAll() {
    this.storage.transactionSync(() => {
      this.storage.sql.exec('DELETE FROM monitor_check_dirty');
      this.storage.sql.exec('DELETE FROM monitor_check_cache');
    });
  }

  /** Drop projections for deployment-removed services; their source retention is separate. */
  prune(activeIds: Iterable<string>) {
    const active = [...new Set(activeIds)];
    this.storage.transactionSync(() => {
      if (!active.length) {
        this.storage.sql.exec('DELETE FROM monitor_check_dirty');
        this.storage.sql.exec('DELETE FROM monitor_check_cache');
        return;
      }
      const placeholders = active.map(() => '?').join(',');
      this.storage.sql.exec(
        `DELETE FROM monitor_check_dirty WHERE service NOT IN (${placeholders})`,
        ...active,
      );
      this.storage.sql.exec(
        `DELETE FROM monitor_check_cache WHERE service NOT IN (${placeholders})`,
        ...active,
      );
    });
  }

  private query<T extends Record<string, SqlStorageValue>>(
    query: string,
    bindings: SqlStorageValue[],
    diagnostics: CheckCacheReadDiagnostics,
    source = false,
  ): T[] {
    const cursor = this.storage.sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    diagnostics.rowsRead += cursor.rowsRead;
    diagnostics.rowsWritten += cursor.rowsWritten;
    if (source) diagnostics.sourceRowsRead += cursor.rowsRead;
    return rows;
  }

  private decode(row: CacheRow, service: string): CachedMonitorCheck[] | null {
    if (
      row.version !== CACHE_VERSION ||
      row.service !== service ||
      !safeInteger(row.start_slot) ||
      !Number.isSafeInteger(row.end_slot) ||
      row.end_slot < -1 ||
      row.start_slot !== Math.max(0, row.end_slot - MONITOR_CHECK_CACHE_SLOTS + 1)
    )
      return null;
    try {
      const compact: unknown = JSON.parse(row.checks);
      if (!Array.isArray(compact) || compact.length > MONITOR_CHECK_CACHE_SLOTS) return null;
      let previous = -1;
      const checks: CachedMonitorCheck[] = [];
      for (const item of compact) {
        if (
          !Array.isArray(item) ||
          item.length !== 7 ||
          !safeInteger(item[0]) ||
          item[0] <= previous ||
          item[0] < row.start_slot ||
          item[0] > row.end_slot ||
          !safeInteger(item[1]) ||
          !OUTCOMES.includes(item[2]) ||
          !nullableInteger(item[3]) ||
          typeof item[4] !== 'number' ||
          !Number.isFinite(item[4]) ||
          item[4] < 0 ||
          !safeInteger(item[5]) ||
          !nullableInteger(item[6])
        )
          return null;
        previous = item[0];
        checks.push({
          service,
          slot: item[0],
          at: item[1],
          outcome: item[2],
          status: item[3],
          latency: item[4],
          revision: item[5],
          observedAt: item[6],
        });
      }
      return checks;
    } catch {
      return null;
    }
  }

  /** Ascending source-equivalent rows for at most the last seven finished days. */
  read(service: string, finishedEndSlot: number): CachedMonitorCheck[] {
    if (!/^[a-z0-9-]{1,40}$/.test(service)) throw new Error('Invalid cache service');
    if (!Number.isSafeInteger(finishedEndSlot) || finishedEndSlot < -1)
      throw new Error('Invalid cache end slot');
    const diagnostics: CheckCacheReadDiagnostics = {
      mode: 'hit',
      rowsRead: 0,
      rowsWritten: 0,
      sourceRowsRead: 0,
      dirtySlots: 0,
    };
    const result = this.storage.transactionSync(() => {
      const start = Math.max(0, finishedEndSlot - MONITOR_CHECK_CACHE_SLOTS + 1);
      const row = this.query<CacheRow>(
        'SELECT * FROM monitor_check_cache WHERE service=?',
        [service],
        diagnostics,
      )[0];
      const cached = row ? this.decode(row, service) : null;
      let checks: CachedMonitorCheck[];
      const source = (from: number, to: number) =>
        this.query<CachedMonitorCheck>(
          'SELECT service,slot,at,outcome,status,latency,revision,observed_at AS observedAt FROM checks WHERE service=? AND slot BETWEEN ? AND ? ORDER BY slot',
          [service, from, to],
          diagnostics,
          true,
        );
      if (!row || cached === null || finishedEndSlot < row.end_slot) {
        diagnostics.mode = row ? 'rebuild' : 'bootstrap';
        checks = source(start, finishedEndSlot);
      } else {
        const dirty = this.query<{ slot: number }>(
          'SELECT slot FROM monitor_check_dirty WHERE service=? ORDER BY slot',
          [service],
          diagnostics,
        );
        diagnostics.dirtySlots = dirty.length;
        const changed = finishedEndSlot !== row.end_slot || dirty.length > 0;
        if (!changed) return cached;
        diagnostics.mode = dirty.length > 0 ? 'repair' : 'append';
        const selected = new Map(
          cached.filter((check) => check.slot >= start).map((check) => [check.slot, check]),
        );
        if (finishedEndSlot > row.end_slot)
          for (const check of source(Math.max(start, row.end_slot + 1), finishedEndSlot))
            selected.set(check.slot, check);
        // Every dirty slot is in the old covered range. Outside the new range
        // it is simply discarded; inside it, an absent source row means deletion.
        for (const { slot } of dirty) {
          if (slot < start || slot > finishedEndSlot) continue;
          selected.delete(slot);
          const replacement = source(slot, slot)[0];
          if (replacement) selected.set(slot, replacement);
        }
        checks = [...selected.values()].sort((left, right) => left.slot - right.slot);
      }
      const compact: CompactCheck[] = checks.map((check) => [
        check.slot,
        check.at,
        check.outcome,
        check.status,
        check.latency,
        check.revision,
        check.observedAt,
      ]);
      this.query(
        'INSERT INTO monitor_check_cache VALUES(?,?,?,?,?) ON CONFLICT(service) DO UPDATE SET start_slot=excluded.start_slot,end_slot=excluded.end_slot,version=excluded.version,checks=excluded.checks',
        [service, start, finishedEndSlot, CACHE_VERSION, JSON.stringify(compact)],
        diagnostics,
      );
      this.query('DELETE FROM monitor_check_dirty WHERE service=?', [service], diagnostics);
      return checks;
    });
    this.lastRead = diagnostics;
    return result;
  }
}
