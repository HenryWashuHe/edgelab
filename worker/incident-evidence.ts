import { MINUTE, RETENTION, type MonitorPolicy, type ProbeResult } from './monitor-domain';

export type PublicIncident = {
  id: string;
  service: string;
  opened: number;
  resolved: number | null;
  acknowledged: number | null;
};
export type IncidentCheck = {
  service: string;
  slot: number;
  at: number;
  outcome: ProbeResult['outcome'];
  status: number | null;
  latency: number;
  revision: number;
  observedAt: number | null;
};
export type IncidentPolicyVersion = {
  service: string;
  revision: number;
  recordedAt: number;
  name: string;
  transport: 'https' | 'origin';
  assertion: 'ok-json' | 'catalog-json';
  policy: MonitorPolicy;
  provenance: string;
};
export type IncidentNote = { id: string; at: number; note: string };
export type IncidentDetail = {
  incident: PublicIncident;
  checks: IncidentCheck[];
  nextCursor: number | null;
  versions: IncidentPolicyVersion[];
  range: {
    fromSlot: number;
    toSlot: number;
    retentionStart: number;
    limitedByRetention: boolean;
  };
  lifecycle: {
    action: 'incident.opened' | 'incident.acknowledged' | 'incident.recovered';
    at: number;
  }[];
  notes?: IncidentNote[];
  acknowledgementNote?: string;
};
type IncidentRow = PublicIncident & { note: string };
type CheckRow = Omit<IncidentCheck, 'observedAt'> & { observed_at: number | null };
type VersionRow = Omit<IncidentPolicyVersion, 'recordedAt' | 'policy'> & {
  recorded_at: number;
  policy: string;
};
type NoteRow = IncidentNote & { incident: string };
export type IncidentNoteResult = {
  status: number;
  data: { ok: true; note: IncidentNote; alreadyRecorded?: true } | { error: string };
};
const PAGE_SIZE = 50;
const MAX_NOTES = 100;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const publicIncident = ({ id, service, opened, resolved, acknowledged }: IncidentRow) => ({
  id,
  service,
  opened,
  resolved,
  acknowledged,
});

/** Incident evidence is read from the same SQLite coordinator as the monitoring state. */
export class IncidentEvidence {
  constructor(private readonly storage: DurableObjectStorage) {}

  ensureSchema() {
    this.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS incident_notes (id TEXT PRIMARY KEY, incident TEXT NOT NULL, at INTEGER NOT NULL, note TEXT NOT NULL)',
    );
    this.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS incident_notes_by_incident ON incident_notes(incident, at, id)',
    );
  }

  private rows<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ) {
    return this.storage.sql.exec<T>(query, ...bindings).toArray();
  }

  /** Filtering precedes the limit; an old open incident can never be crowded out. */
  list(activeIds: Iterable<string>): PublicIncident[] {
    const ids = [...new Set(activeIds)];
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    const open = this.rows<IncidentRow>(
      `SELECT * FROM incidents WHERE service IN (${placeholders}) AND resolved IS NULL ORDER BY opened DESC, id DESC`,
      ...ids,
    );
    const resolved = this.rows<IncidentRow>(
      `SELECT * FROM incidents WHERE service IN (${placeholders}) AND resolved IS NOT NULL ORDER BY opened DESC, id DESC LIMIT 100`,
      ...ids,
    );
    return [...open, ...resolved].map(publicIncident);
  }

  detail(
    id: string,
    activeIds: Iterable<string>,
    beforeSlot?: number,
    operator = false,
  ): IncidentDetail | null {
    const active = new Set(activeIds);
    const row = this.rows<IncidentRow>('SELECT * FROM incidents WHERE id=?', id)[0];
    if (!row || !active.has(row.service)) return null;
    if (beforeSlot !== undefined && (!Number.isSafeInteger(beforeSlot) || beforeSlot < 0))
      throw new Error('before must be a nonnegative integer slot');

    const now = Date.now();
    const retentionStart = now - RETENTION;
    const requestedFrom = Math.floor(row.opened / MINUTE) - 10;
    const fromSlot = Math.max(0, requestedFrom, Math.floor(retentionStart / MINUTE));
    const toSlot = Math.min(
      Math.floor(now / MINUTE),
      Math.floor((row.resolved ?? now) / MINUTE) + (row.resolved === null ? 0 : 1),
    );
    const rows = this.rows<CheckRow>(
      'SELECT service,slot,at,outcome,status,latency,revision,observed_at FROM checks WHERE service=? AND slot BETWEEN ? AND ? AND at>=? AND slot<? ORDER BY slot DESC LIMIT ?',
      row.service,
      fromSlot,
      toSlot,
      retentionStart,
      beforeSlot ?? Number.MAX_SAFE_INTEGER,
      PAGE_SIZE + 1,
    );
    const checks: IncidentCheck[] = rows.slice(0, PAGE_SIZE).map(({ observed_at, ...check }) => ({
      ...check,
      observedAt: observed_at,
    }));
    const revisions = [...new Set(checks.map((check) => check.revision))];
    const versions: IncidentPolicyVersion[] = revisions.length
      ? this.rows<VersionRow>(
          `SELECT service,revision,recorded_at,name,transport,assertion,policy,provenance FROM service_versions WHERE service=? AND revision IN (${revisions.map(() => '?').join(',')}) ORDER BY revision`,
          row.service,
          ...revisions,
        ).map(({ recorded_at, policy, ...version }) => ({
          ...version,
          recordedAt: recorded_at,
          policy: JSON.parse(policy) as MonitorPolicy,
        }))
      : [];
    const lifecycle: IncidentDetail['lifecycle'] = [{ action: 'incident.opened', at: row.opened }];
    if (row.acknowledged !== null)
      lifecycle.push({ action: 'incident.acknowledged', at: row.acknowledged });
    if (row.resolved !== null) lifecycle.push({ action: 'incident.recovered', at: row.resolved });
    lifecycle.sort((left, right) => left.at - right.at);
    const detail: IncidentDetail = {
      incident: publicIncident(row),
      checks,
      nextCursor: rows.length > PAGE_SIZE ? checks[checks.length - 1].slot : null,
      versions,
      range: {
        fromSlot,
        toSlot,
        retentionStart,
        limitedByRetention: requestedFrom * MINUTE < retentionStart,
      },
      lifecycle,
    };
    if (operator) {
      detail.notes = this.rows<NoteRow>(
        'SELECT id,incident,at,note FROM incident_notes WHERE incident=? AND at>=? ORDER BY at,id',
        id,
        retentionStart,
      ).map(({ incident: _incident, ...note }) => note);
      detail.acknowledgementNote = row.note;
    }
    return detail;
  }

  addNote(body: unknown, activeIds: Iterable<string>): IncidentNoteResult {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return { status: 400, data: { error: 'JSON object required' } };
    const value = body as Record<string, unknown>;
    if (
      typeof value.incident !== 'string' ||
      typeof value.requestId !== 'string' ||
      !UUID_V4.test(value.requestId) ||
      typeof value.note !== 'string' ||
      !value.note.trim() ||
      value.note.length > 500
    )
      return {
        status: 400,
        data: { error: 'Incident, UUID v4 requestId, and a note of 1–500 characters required' },
      };
    const id = value.requestId.toLowerCase();
    const incidentId = value.incident;
    const noteText = value.note;
    const active = new Set(activeIds);
    return this.storage.transactionSync(() => {
      const incident = this.rows<IncidentRow>('SELECT * FROM incidents WHERE id=?', incidentId)[0];
      if (!incident || !active.has(incident.service))
        return { status: 404, data: { error: 'Incident not found' } };
      const previous = this.rows<NoteRow>('SELECT * FROM incident_notes WHERE id=?', id)[0];
      if (previous) {
        if (previous.incident !== incidentId || previous.note !== noteText)
          return {
            status: 409,
            data: { error: 'requestId was already used for a different note' },
          };
        return {
          status: 200,
          data: {
            ok: true,
            note: { id: previous.id, at: previous.at, note: previous.note },
            alreadyRecorded: true,
          },
        };
      }
      const count = this.rows<{ count: number }>(
        'SELECT COUNT(*) AS count FROM incident_notes WHERE incident=?',
        incidentId,
      )[0].count;
      if (count >= MAX_NOTES)
        return { status: 409, data: { error: 'An incident can contain at most 100 notes' } };
      const note = { id, at: Date.now(), note: noteText };
      this.storage.sql.exec(
        'INSERT INTO incident_notes(id,incident,at,note) VALUES(?,?,?,?)',
        note.id,
        incidentId,
        note.at,
        note.note,
      );
      this.storage.sql.exec(
        'INSERT INTO audit(at,action,service,detail) VALUES(?,?,?,?)',
        note.at,
        'incident.note-added',
        incident.service,
        JSON.stringify({ incident: incidentId, requestId: id }),
      );
      return { status: 201, data: { ok: true, note } };
    });
  }

  /** Call after pruning resolved incidents so private notes cannot become orphaned. */
  prune(cutoff: number) {
    this.storage.sql.exec(
      'DELETE FROM incident_notes WHERE at<? OR NOT EXISTS(SELECT 1 FROM incidents WHERE incidents.id=incident_notes.incident)',
      cutoff,
    );
  }
}
