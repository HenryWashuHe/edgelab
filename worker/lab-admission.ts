/**
 * Invoke after gateway validation and before any lab namespace lookup.
 * Workers RateLimit is permissive and per-location, not a global accounting gate.
 * https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
 */
export const LAB_ADMISSION_LANE_KEY = 'edgelab-lab-lane-v1';
export const LAB_ADMISSION_RETRY_AFTER_SECONDS = 60;

/** Structural contract compatible with the native Workers RateLimit binding. */
export interface LabAdmissionBinding {
  limit(options: { key: string }): Promise<unknown>;
}

export type LabAdmissionErrorCode = 'lab-admission-limited' | 'lab-admission-unavailable';
export interface LabAdmissionFailure {
  error: string;
  code: LabAdmissionErrorCode;
  retryAfterSeconds: number;
}

function failure(code: LabAdmissionErrorCode): Response {
  const limited = code === 'lab-admission-limited';
  const body: LabAdmissionFailure = {
    error: limited
      ? 'Lab admission limit reached. Wait before trying again.'
      : 'Lab admission is temporarily unavailable. Wait before trying again.',
    code,
    // Fixed backoff advice, not a promise that this lane will admit the next request.
    retryAfterSeconds: LAB_ADMISSION_RETRY_AFTER_SECONDS,
  };
  return Response.json(body, {
    status: limited ? 429 : 503,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Retry-After': String(LAB_ADMISSION_RETRY_AFTER_SECONDS),
    },
  });
}

/**
 * null allows the caller to proceed; a Response must return before any LABS lookup.
 * Optionality belongs to a separate explicit gateway switch. An enabled guard never
 * bypasses a missing/failed binding. It accepts no caller key, UUID, IP or Request,
 * and performs exactly one native limit call with the same aggregate lane key.
 * No storage, namespace access, timers, logging, retries or LabState fabrication.
 */
export async function checkLabAdmission(binding: unknown): Promise<Response | null> {
  try {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding))
      return failure('lab-admission-unavailable');
    const limit: unknown = Reflect.get(binding, 'limit');
    if (typeof limit !== 'function') return failure('lab-admission-unavailable');
    // Reflect.apply preserves an opaque native binding's receiver without casting it.
    const result: unknown = await Reflect.apply(limit, binding, [{ key: LAB_ADMISSION_LANE_KEY }]);
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      !Object.hasOwn(result, 'success')
    )
      return failure('lab-admission-unavailable');
    const success: unknown = Reflect.get(result, 'success');
    if (typeof success !== 'boolean') return failure('lab-admission-unavailable');
    return success ? null : failure('lab-admission-limited');
  } catch {
    // Do not expose a provider exception or serialize any provider result fields.
    return failure('lab-admission-unavailable');
  }
}

/** Only an exact deployment switch enables admission; invalid settings fail closed. */
export interface LabAdmissionConfig {
  LAB_ADMISSION_ENABLED?: string;
  LAB_OWNER_LIMITER?: unknown;
  LAB_OBSERVER_LIMITER?: unknown;
}
export async function admitLabRequest(
  config: LabAdmissionConfig,
  lane: 'owner' | 'observer',
): Promise<Response | null> {
  try {
    const enabled = config.LAB_ADMISSION_ENABLED;
    if (enabled === undefined || enabled === 'false') return null;
    if (enabled !== 'true') return failure('lab-admission-unavailable');
    if (lane !== 'owner' && lane !== 'observer') return failure('lab-admission-unavailable');
    return await checkLabAdmission(
      lane === 'owner' ? config.LAB_OWNER_LIMITER : config.LAB_OBSERVER_LIMITER,
    );
  } catch {
    return failure('lab-admission-unavailable');
  }
}
