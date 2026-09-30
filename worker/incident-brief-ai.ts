import {
  MAX_BRIEF_OUTPUT_BYTES,
  type BRIEF_MODEL,
  type BriefNativeInput,
  type PreparedBriefInput,
} from './incident-brief-domain';

/** Native Workers AI binding, narrowed to the one server-selected brief model. */
export type IncidentBriefAI = {
  run(
    model: typeof BRIEF_MODEL,
    input: BriefNativeInput,
    options: { signal: AbortSignal; rejectIfBusy: true },
  ): Promise<unknown>;
};
export type BriefFailureCode =
  | 'provider-unavailable'
  | 'provider-capacity'
  | 'provider-quota'
  | 'provider-auth'
  | 'timeout'
  | 'invalid-output'
  | 'evidence-limit'
  | 'interrupted';
export type BriefFailure = { code: BriefFailureCode; message: string };
const messages: Record<BriefFailureCode, string> = {
  'provider-unavailable': 'The AI provider could not complete this attempt.',
  'provider-capacity': 'The AI provider has no available capacity for this attempt.',
  'provider-quota': 'The AI provider account allocation is unavailable for this attempt.',
  'provider-auth': 'The AI provider did not permit this model request.',
  timeout: 'The inference deadline expired. This request will not be dispatched again.',
  'invalid-output': 'The AI response failed the required schema or evidence checks.',
  'evidence-limit': 'The retained evidence could not fit the bounded model input.',
  interrupted: 'Generation was interrupted or its persisted deadline expired.',
};
export const briefFailure = (code: BriefFailureCode): BriefFailure => ({
  code,
  message: messages[code],
});

export function providerFailure(error: unknown, aborted = false): BriefFailure {
  if (aborted) return briefFailure('timeout');
  const value = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const message = typeof value.message === 'string' ? value.message : '';
  const code = Number(
    value.code ?? message.match(/\b(3036|3040|5018|5016|3023|3041|5035|3007|3008)\b/)?.[1],
  );
  if (code === 3036) return briefFailure('provider-quota');
  if (code === 3040) return briefFailure('provider-capacity');
  if ([5018, 5016, 3023, 3041, 5035].includes(code) || [401, 403].includes(Number(value.status)))
    return briefFailure('provider-auth');
  if ([3007, 3008].includes(code) || value.name === 'TimeoutError' || value.name === 'AbortError')
    return briefFailure('timeout');
  return briefFailure('provider-unavailable');
}

/** Decode only the native non-streaming response; never repair or execute output. */
export function decodeBriefResponse(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid AI envelope');
  const envelope = value as Record<string, unknown>;
  if (Object.keys(envelope).some((key) => !['response', 'usage', 'tool_calls'].includes(key)))
    throw new Error('Unexpected AI envelope field');
  if (
    envelope.tool_calls !== undefined &&
    envelope.tool_calls !== null &&
    (!Array.isArray(envelope.tool_calls) || envelope.tool_calls.length > 0)
  )
    throw new Error('Tool calls are not permitted');
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > MAX_BRIEF_OUTPUT_BYTES)
    throw new Error('AI output exceeds byte limit');
  if (typeof envelope.response === 'string') return JSON.parse(envelope.response);
  if (
    envelope.response &&
    typeof envelope.response === 'object' &&
    !Array.isArray(envelope.response)
  )
    return envelope.response;
  throw new Error('Missing AI response');
}

export function runIncidentBriefAI(
  binding: IncidentBriefAI,
  prepared: PreparedBriefInput,
  signal: AbortSignal,
) {
  return binding.run(prepared.model, prepared.input, { signal, rejectIfBusy: true });
}
