import type { CleanupBatch } from './metadata-cleanup';

export const MAX_VERSION_RETENTION_CANDIDATES = 32;

type Candidate = { id: number; service: string; revision: number; source_exists: number };

// These fragments receive only fixed SQL column references, never request data.
const noChecks = (service: string, revision: string, extra = '') =>
  `NOT EXISTS(SELECT 1 FROM checks WHERE checks.service=${service} AND checks.revision=${revision}${extra})`;
const noCurrentPolicy = (service: string, revision: string) =>
  `NOT EXISTS(SELECT 1 FROM services WHERE services.id=${service} AND services.revision=${revision})`;
const versionExists = (service: string, revision: string) =>
  `EXISTS(SELECT 1 FROM service_versions WHERE service_versions.service=${service} AND service_versions.revision=${revision})`;
const unused = (service: string, revision: string) =>
  `${noChecks(service, revision)} AND ${noCurrentPolicy(service, revision)}`;
const lostReference = (service: string, revision: string) =>
  `${unused(service, revision)} AND ${versionExists(service, revision)}`;

/**
 * Queue immutable policy versions only when their last source reference is lost.
 * Reads never drain this queue. Completed cron runs perform bounded, source-
 * authoritative GC; source checks and current policies are always preserved.
 */
export class MonitorVersionRetention {
  constructor(private readonly storage: DurableObjectStorage) {}

  ensureSchema() {
    this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      sql.exec(
        'CREATE TABLE IF NOT EXISTS monitor_version_gc (id INTEGER PRIMARY KEY AUTOINCREMENT, service TEXT NOT NULL, revision INTEGER NOT NULL, UNIQUE(service,revision))',
      );
      sql.exec(
        'CREATE TABLE IF NOT EXISTS monitor_version_gc_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)',
      );
      sql.exec(
        `CREATE TRIGGER IF NOT EXISTS monitor_version_gc_check_deleted AFTER DELETE ON checks BEGIN
          INSERT OR IGNORE INTO monitor_version_gc(service,revision)
          SELECT OLD.service,OLD.revision WHERE ${lostReference('OLD.service', 'OLD.revision')};
        END`,
      );
      sql.exec(
        `CREATE TRIGGER IF NOT EXISTS monitor_version_gc_check_updated AFTER UPDATE OF service,revision ON checks
        WHEN OLD.service<>NEW.service OR OLD.revision<>NEW.revision BEGIN
          INSERT OR IGNORE INTO monitor_version_gc(service,revision)
          SELECT OLD.service,OLD.revision WHERE ${lostReference('OLD.service', 'OLD.revision')};
        END`,
      );
      // SQLite REPLACE can remove its old row without firing DELETE triggers.
      // Capture that old key before insertion, excluding only the replaced slot.
      // A failed/conflicting insertion rolls these trigger writes back as well.
      sql.exec(
        `CREATE TRIGGER IF NOT EXISTS monitor_version_gc_check_replaced BEFORE INSERT ON checks BEGIN
          INSERT OR IGNORE INTO monitor_version_gc(service,revision)
          SELECT replaced.service,replaced.revision FROM checks AS replaced
          WHERE replaced.service=NEW.service AND replaced.slot=NEW.slot AND replaced.revision<>NEW.revision
          AND ${noChecks('replaced.service', 'replaced.revision', ' AND checks.slot<>NEW.slot')}
          AND ${noCurrentPolicy('replaced.service', 'replaced.revision')}
          AND ${versionExists('replaced.service', 'replaced.revision')};
        END`,
      );
      // UPDATE OR REPLACE can also discard a row at the destination primary
      // key. Exclude both rows that the statement changes, then preserve any
      // other reference. The resulting NEW row protects its own revision.
      sql.exec(
        `CREATE TRIGGER IF NOT EXISTS monitor_version_gc_check_replace_updated BEFORE UPDATE OF service,slot ON checks
        WHEN OLD.service<>NEW.service OR OLD.slot<>NEW.slot BEGIN
          INSERT OR IGNORE INTO monitor_version_gc(service,revision)
          SELECT replaced.service,replaced.revision FROM checks AS replaced
          WHERE replaced.service=NEW.service AND replaced.slot=NEW.slot AND replaced.revision<>NEW.revision
          AND ${noChecks('replaced.service', 'replaced.revision', ' AND NOT(checks.service=OLD.service AND checks.slot=OLD.slot) AND NOT(checks.service=NEW.service AND checks.slot=NEW.slot)')}
          AND ${noCurrentPolicy('replaced.service', 'replaced.revision')}
          AND ${versionExists('replaced.service', 'replaced.revision')};
        END`,
      );
      sql.exec(
        `CREATE TRIGGER IF NOT EXISTS monitor_version_gc_service_updated AFTER UPDATE OF id,revision ON services
        WHEN OLD.id<>NEW.id OR OLD.revision<>NEW.revision BEGIN
          INSERT OR IGNORE INTO monitor_version_gc(service,revision)
          SELECT OLD.id,OLD.revision WHERE ${lostReference('OLD.id', 'OLD.revision')};
        END`,
      );
      sql.exec(
        `CREATE TRIGGER IF NOT EXISTS monitor_version_gc_service_deleted AFTER DELETE ON services BEGIN
          INSERT OR IGNORE INTO monitor_version_gc(service,revision)
          SELECT OLD.id,OLD.revision WHERE ${lostReference('OLD.id', 'OLD.revision')};
        END`,
      );
      // The unique service ID identifies the sole current-policy row that this
      // insertion will replace. A different new revision cannot retain its key.
      sql.exec(
        `CREATE TRIGGER IF NOT EXISTS monitor_version_gc_service_replaced BEFORE INSERT ON services BEGIN
          INSERT OR IGNORE INTO monitor_version_gc(service,revision)
          SELECT replaced.id,replaced.revision FROM services AS replaced
          WHERE replaced.id=NEW.id AND replaced.revision<>NEW.revision
          AND ${noChecks('replaced.id', 'replaced.revision')}
          AND ${versionExists('replaced.id', 'replaced.revision')};
        END`,
      );
      sql.exec(
        `CREATE TRIGGER IF NOT EXISTS monitor_version_gc_service_replace_updated BEFORE UPDATE OF id ON services
        WHEN OLD.id<>NEW.id BEGIN
          INSERT OR IGNORE INTO monitor_version_gc(service,revision)
          SELECT replaced.id,replaced.revision FROM services AS replaced
          WHERE replaced.id=NEW.id AND replaced.revision<>NEW.revision
          AND ${noChecks('replaced.id', 'replaced.revision')}
          AND ${versionExists('replaced.id', 'replaced.revision')};
        END`,
      );
      sql.exec(
        `CREATE TRIGGER IF NOT EXISTS monitor_version_gc_version_inserted AFTER INSERT ON service_versions BEGIN
          INSERT OR IGNORE INTO monitor_version_gc(service,revision)
          SELECT NEW.service,NEW.revision WHERE ${unused('NEW.service', 'NEW.revision')};
        END`,
      );
      sql.exec(
        `CREATE TRIGGER IF NOT EXISTS monitor_version_gc_version_updated AFTER UPDATE OF service,revision ON service_versions
        WHEN OLD.service<>NEW.service OR OLD.revision<>NEW.revision BEGIN
          INSERT OR IGNORE INTO monitor_version_gc(service,revision)
          SELECT NEW.service,NEW.revision WHERE ${unused('NEW.service', 'NEW.revision')};
        END`,
      );
      const marker = sql
        .exec<{ version: number }>('SELECT version FROM monitor_version_gc_meta WHERE id=1')
        .toArray()[0];
      if (marker && marker.version !== 1) throw new Error('Unsupported version-retention schema');
      if (!marker) {
        // One atomic upgrade pass covers pre-existing unused versions. New
        // reference loss is covered by the installed triggers before it commits.
        sql.exec(
          `INSERT OR IGNORE INTO monitor_version_gc(service,revision)
          SELECT service,revision FROM service_versions
          WHERE ${unused('service_versions.service', 'service_versions.revision')}
          ORDER BY service,revision`,
        );
        sql.exec('INSERT INTO monitor_version_gc_meta VALUES(1,1)');
      }
    });
  }

  /** Call within completed cron cleanup; nested transactions retain atomicity. */
  prune(): CleanupBatch {
    return this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      const candidates = sql
        .exec<Candidate>(
          `SELECT candidates.id,candidates.service,candidates.revision,
          (source.service IS NOT NULL) AS source_exists
          FROM (SELECT id,service,revision FROM monitor_version_gc ORDER BY id LIMIT ?) AS candidates
          LEFT JOIN service_versions AS source ON source.service=candidates.service AND source.revision=candidates.revision
          ORDER BY candidates.id`,
          MAX_VERSION_RETENTION_CANDIDATES,
        )
        .toArray();
      let deleted = 0;
      let protectedCount = 0;
      let missing = 0;
      for (const candidate of candidates) {
        // A later observation/import may have restored a reference. Dequeue it
        // either way; a subsequent last-reference loss queues a fresh FIFO entry.
        const removed = sql
          .exec<{ removed: number }>(
            `DELETE FROM service_versions WHERE service=? AND revision=?
            AND ${unused('service_versions.service', 'service_versions.revision')}
            RETURNING 1 AS removed`,
            candidate.service,
            candidate.revision,
          )
          .toArray();
        deleted += removed.length;
        if (!removed.length) {
          if (candidate.source_exists) protectedCount++;
          else missing++;
        }
        sql.exec('DELETE FROM monitor_version_gc WHERE id=?', candidate.id);
      }
      return {
        limit: MAX_VERSION_RETENTION_CANDIDATES,
        examined: candidates.length,
        deleted,
        protected: protectedCount,
        missing,
        // A full batch may have emptied the queue. Avoid a second read merely
        // to distinguish that case; this is a conservative backlog signal.
        mayRemain: candidates.length === MAX_VERSION_RETENTION_CANDIDATES,
      };
    });
  }
}
