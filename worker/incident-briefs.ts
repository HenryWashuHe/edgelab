import { IncidentEvidence } from './incident-evidence';
import {
  BRIEF_MODEL,
  BRIEF_PROMPT_VERSION,
  BRIEF_SCHEMA_VERSION,
  buildBriefInput,
  captureBriefEvidence,
  validateBriefOutput,
  type BriefEvidence,
  type GeneratedBrief,
  type PreparedBriefInput,
} from './incident-brief-domain';
import {
  briefFailure,
  decodeBriefResponse,
  providerFailure,
  runIncidentBriefAI,
  type BriefFailure,
  type IncidentBriefAI,
} from './incident-brief-ai';
import { MINUTE, RETENTION } from './monitor-domain';

export type { BriefFailure, IncidentBriefAI } from './incident-brief-ai';
export type BriefRecord = {
  requestId: string;
  incident: string;
  service: string;
  createdAt: number;
  completedAt: number | null;
  state: 'pending' | 'complete' | 'failed' | 'interrupted' | 'insufficient-evidence';
  evidence: BriefEvidence;
  evidenceHash: string;
  evidenceSchemaVersion: typeof BRIEF_SCHEMA_VERSION;
  promptVersion: typeof BRIEF_PROMPT_VERSION;
  model: typeof BRIEF_MODEL;
  promptEvidenceIds: string[];
  omittedEvidenceCount: number;
  messageBytes: number;
  inputBytes: number;
  generated: GeneratedBrief | null;
  failure: BriefFailure | null;
};
export type BriefQuota = {
  day: string;
  attempts: number;
  remaining: number;
  nextAllowedAt: number | null;
  pendingUntil: number | null;
};
export type BriefListResponse = {
  capability: 'enabled' | 'disabled';
  records: BriefRecord[];
  quota: BriefQuota;
};
export type BriefResponse = { brief: BriefRecord; alreadyRecorded?: true };
export type BriefErrorResponse = {
  error: string;
  brief?: BriefRecord;
  capability?: 'disabled';
  quota?: BriefQuota;
};
export type BriefResult<T = BriefResponse> = { status: number; data: T | BriefErrorResponse };
type BriefRow = {
  request_id: string;
  incident: string;
  service: string;
  created_at: number;
  state: BriefRecord['state'];
  record: string;
  dispatch_token: string | null;
  deadline: number | null;
};
type IncidentRow = { id: string; service: string };
type QuotaRow = { day: string; attempts: number; last_slot: number };
const DAY = 86400000;
const DAILY_ATTEMPTS = 4;
const DEADLINE_MS = 20000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const dayOf = (now: number) => new Date(Math.floor(now / DAY) * DAY).toISOString().slice(0, 10);

/** Private, frozen evidence and one conservatively reserved AI dispatch per request. */
export class IncidentBriefs {
  private readonly evidence: IncidentEvidence;
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.evidence = new IncidentEvidence(storage);
  }

  ensureSchema() {
    this.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS incident_briefs (request_id TEXT PRIMARY KEY, incident TEXT NOT NULL, service TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL, record TEXT NOT NULL, dispatch_token TEXT, deadline INTEGER)',
    );
    this.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS incident_briefs_by_incident ON incident_briefs(incident,created_at,request_id)',
    );
    this.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS brief_quota (day TEXT PRIMARY KEY, attempts INTEGER NOT NULL, last_slot INTEGER NOT NULL)',
    );
  }

  private rows<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ) {
    return this.storage.sql.exec<T>(query, ...bindings).toArray();
  }
  private eligible(incident: string, activeIds: Set<string>) {
    const row = this.rows<IncidentRow>('SELECT id,service FROM incidents WHERE id=?', incident)[0];
    return row && activeIds.has(row.service) ? row : null;
  }
  private record(row: BriefRow): BriefRecord {
    return JSON.parse(row.record) as BriefRecord;
  }
  private existing(requestId: string) {
    return this.rows<BriefRow>('SELECT * FROM incident_briefs WHERE request_id=?', requestId)[0];
  }
  private retained(row: BriefRow): BriefResult {
    return {
      status: row.state === 'pending' ? 202 : 200,
      data: { brief: this.record(row), alreadyRecorded: true },
    };
  }
  private expired(now: number) {
    for (const row of this.rows<BriefRow>(
      'SELECT * FROM incident_briefs WHERE state=? AND deadline<=?',
      'pending',
      now,
    )) {
      const record = this.record(row);
      record.state = 'interrupted';
      record.completedAt = now;
      record.failure = briefFailure('interrupted');
      this.storage.sql.exec(
        'UPDATE incident_briefs SET state=?,record=?,dispatch_token=NULL WHERE request_id=? AND state=? AND dispatch_token=?',
        record.state,
        JSON.stringify(record),
        row.request_id,
        'pending',
        row.dispatch_token,
      );
    }
  }
  private quota(now: number): BriefQuota {
    const day = dayOf(now);
    const quota = this.rows<QuotaRow>('SELECT * FROM brief_quota WHERE day=?', day)[0];
    const pending = this.rows<{ deadline: number }>(
      'SELECT deadline FROM incident_briefs WHERE state=? ORDER BY deadline DESC LIMIT 1',
      'pending',
    )[0];
    return {
      day,
      attempts: quota?.attempts ?? 0,
      remaining: Math.max(0, DAILY_ATTEMPTS - (quota?.attempts ?? 0)),
      nextAllowedAt:
        quota && quota.last_slot >= Math.floor(now / MINUTE)
          ? (quota.last_slot + 1) * MINUTE
          : null,
      pendingUntil: pending?.deadline ?? null,
    };
  }

  read(requestId: string, activeIds: Iterable<string>, now: number): BriefResult {
    if (!UUID_V4.test(requestId))
      return { status: 400, data: { error: 'UUID v4 requestId required' } };
    return this.storage.transactionSync(() => {
      this.expired(now);
      const row = this.existing(requestId.toLowerCase());
      if (
        !row ||
        row.created_at < now - RETENTION ||
        !this.eligible(row.incident, new Set(activeIds))
      )
        return { status: 404, data: { error: 'Incident brief not found' } };
      return this.retained(row);
    });
  }

  list(
    incident: string,
    activeIds: Iterable<string>,
    now: number,
    AIavailable: boolean,
  ): BriefResult<BriefListResponse> {
    if (!UUID.test(incident)) return { status: 400, data: { error: 'Incident UUID required' } };
    incident = incident.toLowerCase();
    return this.storage.transactionSync(() => {
      this.expired(now);
      if (!this.eligible(incident, new Set(activeIds)))
        return { status: 404, data: { error: 'Incident not found' } };
      return {
        status: 200,
        data: {
          capability: AIavailable ? 'enabled' : 'disabled',
          records: this.rows<BriefRow>(
            'SELECT * FROM incident_briefs WHERE incident=? AND created_at>=? ORDER BY created_at DESC,request_id DESC LIMIT 5',
            incident,
            now - RETENTION,
          ).map((row) => this.record(row)),
          quota: this.quota(now),
        },
      };
    });
  }

  async generate(
    body: unknown,
    activeIds: Iterable<string>,
    now: number,
    AI?: IncidentBriefAI,
  ): Promise<BriefResult> {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return { status: 400, data: { error: 'JSON object required' } };
    const value = body as Record<string, unknown>;
    if (
      Object.keys(value).some((key) => !['incident', 'requestId'].includes(key)) ||
      typeof value.incident !== 'string' ||
      !UUID.test(value.incident) ||
      typeof value.requestId !== 'string' ||
      !UUID_V4.test(value.requestId)
    )
      return {
        status: 400,
        data: { error: 'Only incident UUID and UUID v4 requestId are accepted' },
      };
    const requestId = value.requestId.toLowerCase();
    const incidentId = value.incident.toLowerCase();
    const active = new Set(activeIds);
    const initial = this.storage.transactionSync(() => {
      this.expired(now);
      const previous = this.existing(requestId);
      if (previous) {
        if (previous.created_at < now - RETENTION)
          return { status: 404, data: { error: 'Incident brief no longer retained' } };
        if (previous.incident !== incidentId)
          return {
            status: 409,
            data: { error: 'requestId was already used for another incident' },
          };
        if (!this.eligible(incidentId, active))
          return { status: 404, data: { error: 'Incident not found' } };
        return this.retained(previous);
      }
      if (!this.eligible(incidentId, active))
        return { status: 404, data: { error: 'Incident not found' } };
      if (!AI)
        return {
          status: 503,
          data: {
            error: 'AI briefs unavailable in this deployment',
            capability: 'disabled' as const,
            quota: this.quota(now),
          },
        };
      return null;
    });
    if (initial) return initial;
    const detail = this.evidence.detail(incidentId, active, undefined, false);
    if (!detail) return { status: 404, data: { error: 'Incident not found' } };
    // SHA-256 yields: all ownership, eligibility and quota checks are repeated below.
    const snapshot = await captureBriefEvidence(detail, now);
    let prepared: PreparedBriefInput | null = null;
    let preparationFailure: BriefFailure | null = null;
    if (snapshot.evidence.facts.badChecks > 0) {
      try {
        prepared = buildBriefInput(snapshot.evidence);
      } catch {
        preparationFailure = briefFailure('evidence-limit');
      }
    }
    const reservation = this.storage.transactionSync(() => {
      const reservationTime = this.clock();
      this.expired(reservationTime);
      const previous = this.existing(requestId);
      if (previous) {
        if (previous.created_at < reservationTime - RETENTION)
          return { result: { status: 404, data: { error: 'Incident brief no longer retained' } } };
        if (previous.incident !== incidentId)
          return {
            result: {
              status: 409,
              data: { error: 'requestId was already used for another incident' },
            },
          };
        if (!this.eligible(incidentId, active))
          return { result: { status: 404, data: { error: 'Incident not found' } } };
        return { result: this.retained(previous) };
      }
      const incident = this.eligible(incidentId, active);
      if (!incident) return { result: { status: 404, data: { error: 'Incident not found' } } };
      const record: BriefRecord = {
        requestId,
        incident: incidentId,
        service: incident.service,
        createdAt: now,
        completedAt: prepared === null ? reservationTime : null,
        state: preparationFailure ? 'failed' : prepared ? 'pending' : 'insufficient-evidence',
        evidence: snapshot.evidence,
        evidenceHash: snapshot.evidenceHash,
        evidenceSchemaVersion: BRIEF_SCHEMA_VERSION,
        promptVersion: BRIEF_PROMPT_VERSION,
        model: BRIEF_MODEL,
        promptEvidenceIds: prepared?.citationIds ?? [],
        omittedEvidenceCount: prepared?.omittedEvidenceCount ?? 0,
        messageBytes: prepared?.messageBytes ?? 0,
        inputBytes: prepared?.inputBytes ?? 0,
        generated: null,
        failure: preparationFailure,
      };
      if (prepared) {
        const quota = this.quota(reservationTime);
        if (quota.pendingUntil !== null)
          return {
            result: { status: 429, data: { error: 'One AI generation is already pending', quota } },
          };
        if (quota.remaining === 0)
          return {
            result: {
              status: 429,
              data: { error: 'Four AI attempts are permitted per UTC day', quota },
            },
          };
        if (quota.nextAllowedAt !== null)
          return {
            result: {
              status: 429,
              data: { error: 'At most one AI attempt may start per UTC minute', quota },
            },
          };
      }
      const dispatchToken = prepared ? crypto.randomUUID() : null;
      const deadline = prepared ? reservationTime + DEADLINE_MS : null;
      this.storage.sql.exec(
        'INSERT INTO incident_briefs VALUES(?,?,?,?,?,?,?,?)',
        requestId,
        incidentId,
        incident.service,
        now,
        record.state,
        JSON.stringify(record),
        dispatchToken,
        deadline,
      );
      if (prepared)
        this.storage.sql.exec(
          'INSERT INTO brief_quota VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET attempts=attempts+1,last_slot=excluded.last_slot',
          dayOf(reservationTime),
          1,
          Math.floor(reservationTime / MINUTE),
        );
      return { record, dispatchToken, deadline };
    });
    if ('result' in reservation) return reservation.result as BriefResult;
    if (!prepared)
      return preparationFailure
        ? { status: 422, data: { error: preparationFailure.message, brief: reservation.record } }
        : { status: 201, data: { brief: reservation.record } };
    const signal = AbortSignal.timeout(DEADLINE_MS);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generated: GeneratedBrief | null = null;
    let failure: BriefFailure | null = null;
    try {
      const output = await Promise.race([
        runIncidentBriefAI(AI!, prepared, signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new DOMException('Inference deadline', 'TimeoutError')),
            DEADLINE_MS,
          );
        }),
      ]);
      try {
        generated = validateBriefOutput(
          decodeBriefResponse(output),
          snapshot.evidence,
          prepared.citationIds,
        );
      } catch {
        failure = briefFailure('invalid-output');
      }
    } catch (error) {
      failure = providerFailure(error, signal.aborted);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return this.storage.transactionSync(() => {
      const completedAt = this.clock();
      const current = this.existing(requestId);
      if (
        !current ||
        current.created_at < completedAt - RETENTION ||
        !this.eligible(incidentId, active)
      )
        return { status: 404, data: { error: 'Incident brief no longer retained' } };
      if (current.state !== 'pending' || current.dispatch_token !== reservation.dispatchToken)
        return this.retained(current);
      // A live owner's own bounded timeout is a failed attempt. Other results
      // arriving after the lease are interrupted and cannot publish output.
      if (
        current.deadline !== null &&
        completedAt >= current.deadline &&
        failure?.code !== 'timeout'
      ) {
        this.expired(completedAt);
        return this.retained(this.existing(requestId)!);
      }
      const record = this.record(current);
      record.state = failure ? 'failed' : 'complete';
      record.completedAt = completedAt;
      record.generated = failure ? null : generated;
      record.failure = failure;
      this.storage.sql.exec(
        'UPDATE incident_briefs SET state=?,record=?,dispatch_token=NULL WHERE request_id=? AND state=? AND dispatch_token=?',
        record.state,
        JSON.stringify(record),
        requestId,
        'pending',
        reservation.dispatchToken,
      );
      return failure
        ? {
            status: failure.code === 'invalid-output' ? 502 : 503,
            data: { error: failure.message, brief: record },
          }
        : { status: 201, data: { brief: record } };
    });
  }

  prune(cutoff: number, activeIds?: Iterable<string>) {
    this.storage.transactionSync(() => {
      this.expired(this.clock());
      this.storage.sql.exec(
        'DELETE FROM incident_briefs WHERE created_at<? OR NOT EXISTS(SELECT 1 FROM incidents WHERE incidents.id=incident_briefs.incident)',
        cutoff,
      );
      if (activeIds !== undefined) {
        const active = [...new Set(activeIds)];
        if (!active.length) this.storage.sql.exec('DELETE FROM incident_briefs');
        else
          this.storage.sql.exec(
            `DELETE FROM incident_briefs WHERE service NOT IN (${active.map(() => '?').join(',')})`,
            ...active,
          );
      }
      this.storage.sql.exec('DELETE FROM brief_quota WHERE day<?', dayOf(cutoff));
    });
  }
}
