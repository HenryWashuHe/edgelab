import app from '../../worker/index';
import { MonitorStore as ClockMonitorStore } from './monitor-clock';
import type { MonitorEnv } from '../../worker/monitor';
import type { IncidentBriefAI } from '../../worker/incident-brief-ai';
export { ReliabilityLab } from '../../worker/index';

/** Only this isolated fixture translates native AI.run to a controlled fake Fetcher. */
export class MonitorStore extends ClockMonitorStore {
  constructor(ctx: DurableObjectState, env: MonitorEnv & { FAKE_AI?: Fetcher }) {
    const AI: IncidentBriefAI | undefined = env.FAKE_AI
      ? {
          async run(model, input, options) {
            const response = await env.FAKE_AI!.fetch('https://fake-ai.internal/run', {
              method: 'POST',
              body: JSON.stringify({
                model,
                input,
                rejectIfBusy: options.rejectIfBusy,
                signalPresent: options.signal instanceof AbortSignal,
              }),
              signal: options.signal,
            });
            const result = (await response.json()) as { code?: number };
            if (!response.ok)
              throw Object.assign(
                new Error('Fixture private provider error must not be disclosed'),
                { code: result.code, status: response.status },
              );
            return result;
          },
        }
      : undefined;
    super(ctx, { ...env, AI: AI as Ai | undefined });
  }
}
export default app;
