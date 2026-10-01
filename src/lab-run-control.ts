/** Only the demo's own cancellation checks produce this deliberate-stop result. */
export class LabDemoStopped extends Error {
  constructor() {
    super('The guided demo was deliberately stopped.');
    this.name = 'LabDemoStopped';
  }
}

export function checkDemoStop(signal: Pick<AbortSignal, 'aborted'>) {
  if (signal.aborted) throw new LabDemoStopped();
}

export type LabRunResult = 'completed' | 'stopped' | 'abandoned';

/**
 * Await the dispatched operation before confirming state. A deliberate stop
 * makes the old snapshot unconfirmed; any other rejection keeps its identity
 * and performs no follow-up read. The caller owns the page guard inside its
 * confirmation read and must not replay commands from that callback.
 */
export async function settleLabRun(
  operation: PromiseLike<void>,
  options: {
    isCurrent: () => boolean;
    markUnconfirmed: () => void;
    confirmState: () => PromiseLike<void>;
  },
): Promise<LabRunResult> {
  let stopped = false;
  try {
    await operation;
  } catch (error) {
    if (!options.isCurrent()) return 'abandoned';
    if (!(error instanceof LabDemoStopped)) throw error;
    stopped = true;
  }
  if (!options.isCurrent()) return 'abandoned';
  if (stopped) options.markUnconfirmed();
  if (!options.isCurrent()) return 'abandoned';
  try {
    await options.confirmState();
  } catch (error) {
    if (!options.isCurrent()) return 'abandoned';
    throw error;
  }
  if (!options.isCurrent()) return 'abandoned';
  return stopped ? 'stopped' : 'completed';
}
