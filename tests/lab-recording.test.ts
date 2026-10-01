import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaults } from '../worker/engine';
import type { LabObserverDataFrame, LabObserverEvent } from '../worker/lab-observer';
import golden from '../src/data/lab-recording-example.json';
import goldenRaw from '../src/data/lab-recording-example.json?raw';
import {
  LAB_RECORDING_FINALIZATION_HEADROOM,
  MAX_LAB_RECORDING_BYTES,
  MAX_LAB_RECORDING_ENTRIES,
  LabRecordingError,
  appendLabRecording,
  beginLabRecording,
  exportLabRecording,
  finalizeLabRecording,
  importLabRecording,
  inspectLabRecording,
  type LabRecording,
} from '../src/lab-recording';

const run = '22222222-2222-4222-8222-222222222222';
const nextRun = '33333333-3333-4333-8333-333333333333';
const now = Date.UTC(2026, 8, 30);
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
function frame(revision = 1, kind: 'snapshot' | 'update' = 'snapshot'): LabObserverDataFrame {
  return {
    schemaVersion: 1,
    kind,
    runId: run,
    revision,
    committedAt: now - 1000,
    now,
    expiresAt: now + 60000,
    state: {
      config: { ...defaults },
      tokens: 12,
      circuit: 'closed',
      failures: 0,
      total: 0,
      originCalls: 0,
      counts: { origin: 0, stale: 0, limited: 0, blocked: 0, error: 0 },
    },
    events: [],
  };
}
const event = (id: number): LabObserverEvent => ({
  id,
  at: now - 1,
  latencyMs: 20,
  outcome: 'origin',
  status: 200,
  circuit: 'closed',
  originAttempted: true,
});
const start = () => beginLabRecording(frame(), now + 5, '3.6.0');
const finish = () => finalizeLabRecording(start(), 'stopped', now + 10);
async function encoded() {
  return JSON.parse((await exportLabRecording(finish())).json) as Record<string, unknown>;
}
function largeFrame(revision: number, kind: 'snapshot' | 'update') {
  const value = frame(revision, kind);
  const at = 8_640_000_000_000_000 - 1000;
  value.now = at;
  value.committedAt = at - 1;
  value.expiresAt = at + 1;
  value.state.config = {
    capacity: 50,
    refillPerSecond: 20,
    failureThreshold: 10,
    cooldownMs: 15000,
    originLatencyMs: 3000,
    originTimeoutMs: 5000,
    staleFallback: false,
    originMode: 'healthy',
  };
  value.state.tokens = 0.0000012345678901234567;
  value.state.circuit = 'half-open';
  value.state.failures = Number.MAX_SAFE_INTEGER;
  value.state.total = Number.MAX_SAFE_INTEGER;
  value.state.originCalls = Number.MAX_SAFE_INTEGER;
  for (const key of Object.keys(value.state.counts) as (keyof typeof value.state.counts)[])
    value.state.counts[key] = Math.floor(Number.MAX_SAFE_INTEGER / 5);
  value.events = [
    {
      ...event(Number.MAX_SAFE_INTEGER),
      at: at - 1,
      latencyMs: 0.0000012345678901234567,
      outcome: 'limited',
      status: 599,
      circuit: 'half-open',
      originAttempted: false,
    },
  ];
  return value;
}
afterEach(() => vi.restoreAllMocks());

describe('bounded observer recording', () => {
  it('captures actual parsed snapshots and deep-freezes fresh public values', () => {
    const input = frame();
    const recording = beginLabRecording(JSON.stringify(input), now + 5, '3.6.0');
    input.state.tokens = 1;
    expect(recording.entries[0].frame).toMatchObject({ state: { tokens: 12 } });
    expect(recording.startedAt).toBe(now + 5);
    expect(Object.isFrozen(recording)).toBe(true);
    expect(Object.isFrozen(recording.entries)).toBe(true);
    expect(Object.isFrozen(recording.entries[0].frame)).toBe(true);
    expect(Object.isFrozen((recording.entries[0].frame as LabObserverDataFrame).state.config)).toBe(
      true,
    );
    expect(() => beginLabRecording(frame(1, 'update'), now, '3.6.0')).toThrow(LabRecordingError);
    expect(() => beginLabRecording(frame(), NaN, '3.6.0')).toThrow(LabRecordingError);
    expect(() => beginLabRecording(frame(), now, 'fixture-secret-version<script>')).toThrow(
      LabRecordingError,
    );
  });

  it('records regressing receipt clocks without deriving source latency or reordering entries', () => {
    let recording = start();
    recording = appendLabRecording(recording, frame(2, 'update'), now - 20000);
    recording = appendLabRecording(recording, frame(3, 'update'), now - 10000);
    expect(recording.startedAt).toBe(now + 5);
    expect(recording.lastReceivedAt).toBe(now - 10000);
    expect(recording.entries.map((entry) => entry.receivedAt)).toEqual([
      now + 5,
      now - 20000,
      now - 10000,
    ]);
    expect(
      recording.entries.map((entry) => (entry.frame as LabObserverDataFrame).revision),
    ).toEqual([1, 2, 3]);
  });

  it('requires one initial snapshot and increasing revisions, including after run changes', () => {
    for (const invalid of [
      frame(2),
      frame(1, 'update'),
      frame(0, 'update'),
      { ...frame(1, 'update'), runId: nextRun },
    ]) {
      const recording = start();
      const stopped = appendLabRecording(recording, invalid, now + 10);
      expect(stopped.end).toEqual({ reason: 'invalid-frame', at: now + 10 });
      expect(stopped.entries).toEqual(recording.entries);
    }
    const changed = appendLabRecording(start(), { ...frame(2, 'update'), runId: nextRun }, now);
    expect(changed.end).toBeNull();
    expect(inspectLabRecording(changed, 1).runChanged).toBe(true);
    expect(() =>
      beginLabRecording(
        { schemaVersion: 1, kind: 'expired', reason: 'idle-expired', now },
        now,
        '3.6.0',
      ),
    ).toThrow();
  });

  it('preserves genuinely unknown legacy commit metadata until a real recorded update', async () => {
    const legacy = { ...frame(0), committedAt: null };
    let recording = beginLabRecording(legacy, now, '3.6.0');
    recording = appendLabRecording(recording, frame(1, 'update'), now + 1);
    expect(
      (inspectLabRecording(recording, 0).entry.frame as LabObserverDataFrame).committedAt,
    ).toBeNull();
    expect(inspectLabRecording(recording, 1).latestData.revision).toBe(1);
    const exported = await exportLabRecording(
      finalizeLabRecording(recording, 'disconnected', null),
    );
    expect((await importLabRecording(exported.json)).end.at).toBeNull();
  });

  it('includes a validated terminal then freezes the prefix and original end reason', async () => {
    for (const kind of ['expired', 'unavailable'] as const) {
      const recording = appendLabRecording(
        start(),
        {
          schemaVersion: 1,
          kind,
          reason: kind === 'expired' ? 'idle-expired' : 'lab-unavailable',
          now,
        },
        now + 10,
      );
      expect(recording.end).toEqual({ reason: kind, at: now + 10 });
      expect(recording.entries.at(-1)?.frame.kind).toBe(kind);
      expect(appendLabRecording(recording, frame(2, 'update'), now + 20)).toBe(recording);
      expect(finalizeLabRecording(recording, 'interrupted', now + 20)).toBe(recording);
      const step = inspectLabRecording(recording, 1);
      expect(step.latestData.revision).toBe(1);
      expect(step.entry.frame.kind).toBe(kind);
      expect(
        (await importLabRecording((await exportLabRecording(recording)).json)).end.reason,
      ).toBe(kind);
    }
  });

  it('stops on invalid receipt/frames without retaining raw rejected bytes', () => {
    const receipt = appendLabRecording(start(), frame(2, 'update'), Infinity);
    expect(receipt.end).toEqual({ reason: 'invalid-frame', at: null });
    expect(receipt.entries).toHaveLength(1);
    const invalid = appendLabRecording(start(), 'fixture-secret-invalid-json', now);
    expect(invalid.end?.reason).toBe('invalid-frame');
    expect(JSON.stringify(invalid)).not.toContain('fixture-secret-');
  });

  it('rejects duplicate raw snapshots, including escaped aliases, without exposing discarded bytes', () => {
    const original = frame();
    const json = JSON.stringify(original);
    for (const duplicate of [
      '{"schemaVersion":2,' + json.slice(1),
      '{"\\u0073chemaVersion":2,' + json.slice(1),
      json.replace('"tokens":12', '"tokens":"fixture-secret-discarded","tokens":12'),
      json.replace('"tokens":12', '"tokens":"fixture-secret-discarded","\\u0074okens":12'),
    ]) {
      // Ordinary JSON parsing would erase the conflicting evidence entirely.
      expect(JSON.parse(duplicate)).toEqual(original);
      try {
        beginLabRecording(duplicate, now + 5, '3.6.0');
        expect.fail('Duplicate frame names must reject');
      } catch (error) {
        expect(error).toBeInstanceOf(LabRecordingError);
        expect(error).toMatchObject({ code: 'invalid-frame' });
        expect((error as Error).message).not.toContain('fixture-secret-');
      }
    }
  });

  it('stops at a duplicate raw update while preserving the valid prefix and safe end reason', async () => {
    const original = frame(2, 'update');
    const json = JSON.stringify(original);
    for (const duplicate of [
      '{"revision":999,' + json.slice(1),
      '{"\\u0072evision":999,' + json.slice(1),
      '{"state":{"cachedPayload":"fixture-secret-discarded"},' + json.slice(1),
      json.replace('"tokens":12', '"\\u0074okens":"fixture-secret-discarded","tokens":12'),
    ]) {
      expect(JSON.parse(duplicate)).toEqual(original);
      const prefix = start();
      const stopped = appendLabRecording(prefix, duplicate, now + 10);
      expect(stopped.end).toEqual({ reason: 'invalid-frame', at: now + 10 });
      expect(stopped.entries).toEqual(prefix.entries);
      expect(stopped.lastReceivedAt).toBe(prefix.lastReceivedAt);
      expect(prefix.end).toBeNull();
      expect(Object.isFrozen(stopped.entries[0].frame)).toBe(true);
      expect(appendLabRecording(stopped, original, now + 20)).toBe(stopped);
      const exported = await exportLabRecording(stopped);
      expect(exported.json).not.toContain('fixture-secret-');
      expect((await importLabRecording(exported.json)).entries).toEqual(prefix.entries);
    }
  });

  it('freezes exactly256 compact entries without evicting its actual initial snapshot', async () => {
    let recording = start();
    for (let revision = 2; revision <= MAX_LAB_RECORDING_ENTRIES; revision++)
      recording = appendLabRecording(recording, frame(revision, 'update'), now + revision);
    expect(recording.entries).toHaveLength(256);
    expect(recording.end?.reason).toBe('frame-limit');
    expect(recording.entries[0].frame.kind).toBe('snapshot');
    expect(appendLabRecording(recording, frame(257, 'update'), now + 257)).toBe(recording);
    const { json, artifact } = await exportLabRecording(recording);
    expect(bytes(json)).toBeLessThanOrEqual(MAX_LAB_RECORDING_BYTES);
    expect((await importLabRecording(json)).entries).toEqual(artifact.entries);
  });

  it('exercises the real byte gate with valid large-number/event frames and preserves finalization headroom', async () => {
    let recording = beginLabRecording(
      largeFrame(Number.MAX_SAFE_INTEGER - 500, 'snapshot'),
      8_640_000_000_000_000 - 1000,
      '1234567890.1234567890.1234567890',
    );
    const first = recording.entries[0];
    let before = recording;
    for (let offset = 1; !recording.end && offset < 256; offset++) {
      before = recording;
      recording = appendLabRecording(
        recording,
        largeFrame(Number.MAX_SAFE_INTEGER - 500 + offset, 'update'),
        8_640_000_000_000_000 - 1000,
      );
    }
    expect(recording.end?.reason).toBe('byte-limit');
    expect(recording.entries.length).toBeLessThan(256);
    expect(recording.entries).toEqual(before.entries);
    expect(recording.entries[0]).toEqual(first);
    expect(bytes(JSON.stringify({ ...recording, end: null }))).toBeLessThanOrEqual(
      MAX_LAB_RECORDING_BYTES - LAB_RECORDING_FINALIZATION_HEADROOM,
    );
    const { artifact, json } = await exportLabRecording(recording);
    expect(bytes(json)).toBeLessThanOrEqual(MAX_LAB_RECORDING_BYTES);
    expect((await importLabRecording(json)).entries).toEqual(artifact.entries);
    expect(appendLabRecording(recording, frame(2, 'update'), now)).toBe(recording);
  });

  it('rejects raw file UTF-8 bytes above the cap before parsing, even when string length is below it', async () => {
    const multibyte = JSON.stringify({ private: '😀'.repeat(50000) });
    expect(multibyte.length).toBeLessThan(MAX_LAB_RECORDING_BYTES);
    expect(bytes(multibyte)).toBeGreaterThan(MAX_LAB_RECORDING_BYTES);
    await expect(importLabRecording(multibyte)).rejects.toMatchObject({ code: 'recording-size' });
  });

  it('rejects unknown metadata and private keys nested in frames, config, counters and events', async () => {
    for (const change of [
      (value: any) => (value.url = 'https://fixture-secret.example'),
      (value: any) => (value.entries[0].capability = 'fixture-secret-capability'),
      (value: any) => (value.entries[0].frame.capability = 'fixture-secret-capability'),
      (value: any) =>
        (value.entries[0].frame.state.cachedPayload = { value: 'fixture-secret-payload' }),
      (value: any) =>
        (value.entries[0].frame.state.config.headers = { cookie: 'fixture-secret-cookie' }),
      (value: any) => (value.entries[0].frame.state.counts.private = 'fixture-secret-counter'),
      (value: any) =>
        (value.entries[0].frame.events = [{ ...event(1), requestId: 'fixture-secret-id' }]),
      (value: any) => (value.end.message = 'fixture-secret-close-message'),
    ]) {
      const value = await encoded();
      change(value);
      try {
        await importLabRecording(JSON.stringify(value));
        expect.fail('Private or unknown data must reject');
      } catch (error) {
        expect(error).toBeInstanceOf(LabRecordingError);
        expect((error as Error).message).not.toContain('fixture-secret-');
      }
    }
  });

  it('rejects malformed dates, unsupported versions, receipt context and hash format', async () => {
    for (const change of [
      (value: any) => (value.schemaVersion = 2),
      (value: any) => (value.protocol = 'edgelab-observer-v2'),
      (value: any) => (value.producerVersion = 'fixture-secret-version'),
      (value: any) => (value.startedAt = -1),
      (value: any) => (value.lastReceivedAt = now),
      (value: any) => (value.entries[0].receivedAt = 8_640_000_000_000_001),
      (value: any) => (value.entries[0].frame.committedAt = now + 1),
      (value: any) => (value.end.at = 'fixture-secret-time'),
      (value: any) => (value.end.reason = 'byte-limit'),
      (value: any) => (value.contentHash = 'invalid'),
    ]) {
      const value = await encoded();
      change(value);
      await expect(importLabRecording(JSON.stringify(value))).rejects.toBeInstanceOf(
        LabRecordingError,
      );
    }
  });

  it('rejects changed evidence but tolerates insignificant object-key order/whitespace', async () => {
    const { json, artifact } = await exportLabRecording(finish());
    const changed = JSON.parse(json);
    changed.entries[0].frame.state.tokens = 11;
    await expect(importLabRecording(JSON.stringify(changed))).rejects.toMatchObject({
      code: 'recording-integrity',
    });
    const reordered = Object.fromEntries(Object.entries(JSON.parse(json)).reverse());
    expect(await importLabRecording(JSON.stringify(reordered, null, 2))).toEqual(artifact);
    await expect(exportLabRecording(start())).rejects.toMatchObject({ code: 'recording-open' });
  });

  it('rejects duplicate archive names at every evidence boundary despite the original content hash', async () => {
    const initial = frame();
    initial.events = [event(1)];
    const { json, artifact } = await exportLabRecording(
      finalizeLabRecording(beginLabRecording(initial, now + 5, '3.6.0'), 'stopped', now + 10),
    );
    for (const duplicate of [
      '{"schemaVersion":2,' + json.slice(1),
      '{"\\u0073chemaVersion":2,' + json.slice(1),
      '{"entries":[{"capability":"fixture-secret-discarded"}],' + json.slice(1),
      json.replace(
        `"receivedAt":${now + 5}`,
        `"receivedAt":"fixture-secret-discarded","receivedAt":${now + 5}`,
      ),
      json.replace(
        `"committedAt":${now - 1000}`,
        `"committedAt":"fixture-secret-discarded","committedAt":${now - 1000}`,
      ),
      json.replace('"config":{', '"config":{"headers":"fixture-secret-discarded"},"config":{'),
      json.replace('"tokens":12', '"tokens":"fixture-secret-discarded","tokens":12'),
      json.replace('"tokens":12', '"tokens":"fixture-secret-discarded","\\u0074okens":12'),
      json.replace('"origin":0', '"\\u006frigin":"fixture-secret-discarded","origin":0'),
      json.replace('"id":1', '"id":"fixture-secret-discarded","id":1'),
      json.replace('"reason":"stopped"', '"reason":"fixture-secret-discarded","reason":"stopped"'),
    ]) {
      const normalized = JSON.parse(duplicate);
      expect(normalized).toEqual(artifact);
      expect(normalized.contentHash).toBe(artifact.contentHash);
      try {
        await importLabRecording(duplicate);
        expect.fail('Duplicate archive names must reject before hashing');
      } catch (error) {
        expect(error).toBeInstanceOf(LabRecordingError);
        expect(error).toMatchObject({ code: 'invalid-recording' });
        expect((error as Error).message).not.toContain('fixture-secret-');
      }
    }
  });

  it('keeps the pinned golden archive and hash unchanged across pretty and reordered imports', async () => {
    const reverseKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reverseKeys);
      if (value !== null && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, child]) => [key, reverseKeys(child)]),
        );
      return value;
    };
    const expectedHash = 'ee884cdcefaedcd23c22eed275ec5088852beec2b6dd8ed323381d2cc908a082';
    for (const json of [
      goldenRaw,
      JSON.stringify(golden),
      JSON.stringify(golden, null, 2),
      JSON.stringify(reverseKeys(golden), null, 2),
    ]) {
      const imported = await importLabRecording(json);
      expect(imported).toEqual(golden);
      expect(imported.contentHash).toBe(expectedHash);
      const { contentHash: _contentHash, ...recording } = imported;
      expect((await exportLabRecording(recording)).artifact.contentHash).toBe(expectedHash);
      expect(imported.entries).toHaveLength(25);
    }
  });

  it('rejects unsupported imported sequence structure before hashing', async () => {
    let valid = appendLabRecording(start(), frame(2, 'update'), now + 6);
    valid = appendLabRecording(valid, frame(3, 'update'), now + 7);
    const source = JSON.parse(
      (await exportLabRecording(finalizeLabRecording(valid, 'stopped', now + 8))).json,
    );
    for (const change of [
      (value: any) => (value.entries[0].frame.kind = 'update'),
      (value: any) => (value.entries[1].frame.kind = 'snapshot'),
      (value: any) => (value.entries[1].frame.revision = 1),
      (value: any) => (value.entries[1].frame = JSON.stringify(value.entries[1].frame)),
      (value: any) => {
        value.entries[1].frame = { schemaVersion: 1, kind: 'expired', reason: 'idle-expired', now };
        value.end.reason = 'expired';
      },
    ]) {
      const value = structuredClone(source);
      change(value);
      await expect(importLabRecording(JSON.stringify(value))).rejects.toMatchObject({
        code: 'invalid-recording',
      });
    }
  });

  it('snapshots mutable caller input before asynchronous SHA-256 can yield', async () => {
    const mutable = JSON.parse(JSON.stringify(finish()));
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const original = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
      await barrier;
      return original(...args);
    });
    const pending = exportLabRecording(mutable as LabRecording);
    mutable.entries[0].frame.state.tokens = 1;
    mutable.producerVersion = '9.9.9';
    mutable.end.reason = 'interrupted';
    release();
    const result = await pending;
    spy.mockRestore();
    expect(result.artifact.producerVersion).toBe('3.6.0');
    expect(result.artifact.entries[0].frame).toMatchObject({ state: { tokens: 12 } });
    expect(result.artifact.end.reason).toBe('stopped');
    expect(Object.isFrozen(result.artifact)).toBe(true);
    expect(await importLabRecording(result.json)).toEqual(result.artifact);
  });

  it('reconstructs observed event prefixes, missing revisions and run-scoped identities without simulating state', () => {
    const initial = frame();
    initial.events = [event(2), event(1)];
    let recording = beginLabRecording(initial, now, '3.6.0');
    const update = frame(4, 'update');
    update.state.tokens = 8;
    update.events = [event(3)];
    recording = appendLabRecording(recording, update, now - 1);
    const gap = inspectLabRecording(recording, 1);
    expect(gap.gapBefore).toEqual({ fromRevision: 2, toRevision: 3, count: 2 });
    expect(gap.events.map((item) => item.id)).toEqual([3, 2, 1]);
    expect(gap.latestData.state.tokens).toBe(8);
    const changed = { ...frame(5, 'update'), runId: nextRun, events: [event(1)] };
    recording = appendLabRecording(recording, changed, now);
    const step = inspectLabRecording(recording, 2);
    expect(step.runChanged).toBe(true);
    expect(step.events.map((item) => item.id)).toEqual([1]);
    expect(step.gapBefore).toBeNull();
    expect(step.hasEarlierGap).toBe(true);
    expect(() => inspectLabRecording(recording, -1)).toThrow(RangeError);
  });

  it('bounds reconstructed outcomes to twelve, independently of recording length', () => {
    let recording = start();
    for (let revision = 2; revision <= 20; revision++)
      recording = appendLabRecording(
        recording,
        { ...frame(revision, 'update'), events: [event(revision)] },
        now,
      );
    expect(inspectLabRecording(recording, 19).events.map((item) => item.id)).toEqual([
      20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9,
    ]);
  });
});
