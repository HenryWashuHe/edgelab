/**
 * Wait for every already-dispatched task before surfacing the first observed
 * rejection. No task factory is accepted, so this helper cannot replay a write.
 */
export async function settleLabBatch(tasks: readonly PromiseLike<unknown>[]): Promise<void> {
  let failed = false;
  let firstFailure: unknown;
  const observed = tasks.map((task) =>
    Promise.resolve(task).catch((error: unknown) => {
      if (!failed) {
        failed = true;
        firstFailure = error;
      }
      throw error;
    }),
  );
  await Promise.allSettled(observed);
  if (failed) throw firstFailure;
}

export type LabFailure = {
  error?: string;
  outcome?: string;
  code?: string;
  reason?: string;
  retryAtUTC?: string | null;
  retryAfterSeconds?: number;
};

export type LabAdmissionFailure =
  | {
      kind: 'admission-limited' | 'admission-unavailable';
      retryAfterSeconds: 60;
    }
  | { kind: 'unconfirmed-admission' };

function row(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function admissionKind(payload: unknown): 'admission-limited' | 'admission-unavailable' | null {
  const value = row(payload);
  return value?.code === 'lab-admission-limited'
    ? 'admission-limited'
    : value?.code === 'lab-admission-unavailable'
      ? 'admission-unavailable'
      : null;
}

/** Only an exact gateway admission error shape/status supports refusal copy. */
export function classifyLabFailure(status: number, payload: unknown): LabAdmissionFailure | null {
  const value = row(payload);
  const kind = admissionKind(payload);
  if (!kind) return null;
  if (
    !value ||
    status !== (kind === 'admission-limited' ? 429 : 503) ||
    typeof value.error !== 'string' ||
    value.error.length === 0 ||
    value.retryAfterSeconds !== 60 ||
    Object.keys(value).length !== 3 ||
    Object.keys(value).some((key) => !['error', 'code', 'retryAfterSeconds'].includes(key))
  )
    return { kind: 'unconfirmed-admission' };
  // This fixed backoff is advice, not an exact reset time or admission guarantee.
  return { kind, retryAfterSeconds: 60 };
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isEngineErrorDecision(path: string, status: number, payload: unknown): boolean {
  const value = row(payload);
  if (
    path !== 'request' ||
    !value ||
    value.status !== status ||
    typeof value.requestId !== 'string' ||
    !UUID_V4.test(value.requestId)
  )
    return false;
  return (
    (value.outcome === 'limited' && status === 429) ||
    (value.outcome === 'blocked' && status === 503) ||
    (value.outcome === 'error' && (status === 502 || status === 504))
  );
}

/**
 * Admission codes take precedence over even a misleading outcome or HTTP 200.
 * A known non-OK engine response remains a decision, not a transport failure.
 */
export function isLabHttpFailure(path: string, status: number, payload: unknown): boolean {
  if (admissionKind(payload)) return true;
  if (Number.isInteger(status) && status >= 200 && status < 300) return false;
  return !isEngineErrorDecision(path, status, payload);
}

/** Safe product copy without echoing an arbitrary response body. */
export function labAdmissionFailureMessage(
  failure: LabAdmissionFailure,
  hasSnapshot: boolean,
): string {
  const reason =
    failure.kind === 'admission-limited'
      ? 'This request was rejected by the gateway admission limit before reaching the lab.'
      : failure.kind === 'admission-unavailable'
        ? 'Gateway admission is temporarily unavailable; this request was not forwarded to the lab.'
        : 'The lab request did not produce a confirmed result.';
  const advice =
    failure.kind === 'unconfirmed-admission'
      ? ''
      : ' The server advises waiting at least 60 seconds before a deliberate retry; that delay does not guarantee admission.';
  return `${reason} Earlier or concurrent writes may have completed. Current lab state cannot be confirmed. ${
    hasSnapshot ? 'Cached results are shown.' : 'No lab snapshot has loaded.'
  }${advice} Reconnect reads state only; it does not repeat a request, reset, or configuration change.`;
}
