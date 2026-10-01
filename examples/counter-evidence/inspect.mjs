import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { MAX_COUNTER_ARTIFACT_BYTES, importSamples, inspect } from './codec.mjs';

/** Read at most the artifact limit plus one byte, even if the file grows. */
export async function readBoundedFile(path) {
  const file = await open(path, 'r');
  try {
    if (!(await file.stat()).isFile()) throw new Error('Unsupported input.');
    const buffer = Buffer.alloc(MAX_COUNTER_ARTIFACT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > MAX_COUNTER_ARTIFACT_BYTES) throw new Error('Input exceeds its limit.');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } finally {
    await file.close();
  }
}
const utc = (at) => (at === null ? 'unavailable' : new Date(at).toISOString());
export async function main(args = process.argv.slice(2)) {
  if (args.length !== 1) {
    console.error('Usage: node examples/counter-evidence/inspect.mjs <local-artifact.json>');
    return 1;
  }
  try {
    const artifact = await importSamples(await readBoundedFile(args[0]));
    const summary = inspect(artifact);
    const source = artifact.source;
    console.log(
      [
        'EdgeLab counter read samples — offline inspection',
        `Source: ${source.example}@${source.commit}`,
        `Source file SHA-256: ${source.fileSHA256}`,
        `Adapter: ${source.adapterVersion}; producer: ${artifact.producerVersion}`,
        source.adapterVersion === 1
          ? 'Declared observation clock origin: Durable Object after the additional KV read.'
          : 'Declared observation clock origin: gateway after the existing counter read RPC returns.',
        `Coverage: ${artifact.coverage}; samples: ${summary.sampleCount}`,
        `Observed value: first ${summary.firstValue}; last ${summary.lastValue}; range ${summary.minimumValue}..${summary.maximumValue}`,
        `Observed value changes: ${summary.valueChanges}; these do not identify commands or causes.`,
        `Observation clock: first ${utc(summary.firstObservedAt)}; last ${utc(summary.lastObservedAt)}`,
        `Recorder receipt clock: first ${utc(summary.startedAt)}; last ${utc(summary.lastReceivedAt)}`,
        `Clock regressions: observation ${summary.observationClockRegressions}; receipt ${summary.receiptClockRegressions}. Sequence alone orders samples.`,
        'Source revision and source commit time: unavailable (null). Observation time is not commit time.',
        `Capture ended: ${summary.endReason}; recorder end time: ${utc(summary.endedAt)}`,
        `Content SHA-256: ${artifact.contentHash}`,
        'A matching hash detects content changes; it does not establish authenticity or a complete history.',
        'Inspection performs no network calls, command execution or mutation replay.',
      ].join('\n'),
    );
    return 0;
  } catch {
    console.error('The local counter artifact could not be read or validated.');
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main();
