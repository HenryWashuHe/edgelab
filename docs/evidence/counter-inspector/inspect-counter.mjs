// examples/counter-evidence/inspect.mjs
import { constants, open, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// examples/counter-evidence/codec.mjs
import { webcrypto } from "node:crypto";

// worker/unique-json.mjs
var MAX_UNIQUE_JSON_BYTES = 196608;
var MAX_UNIQUE_JSON_DEPTH = 64;
var INVALID_JSON = "Invalid JSON input.";
function parseUniqueJson(text) {
  try {
    if (typeof text !== "string" || text.length > MAX_UNIQUE_JSON_BYTES || new TextEncoder().encode(text).byteLength > MAX_UNIQUE_JSON_BYTES) {
      throw new SyntaxError(INVALID_JSON);
    }
    const stack = [];
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (char === '"') {
        const start = index;
        let closed = false;
        while (++index < text.length) {
          if (text[index] === "\\") {
            index++;
          } else if (text[index] === '"') {
            closed = true;
            break;
          }
        }
        if (!closed) throw new SyntaxError(INVALID_JSON);
        const object2 = stack[stack.length - 1];
        if (object2?.kind === "object" && object2.expectingKey) {
          const name = JSON.parse(text.slice(start, index + 1));
          if (object2.keys.has(name)) throw new SyntaxError(INVALID_JSON);
          object2.keys.add(name);
          object2.expectingKey = false;
        }
      } else if (char === "{" || char === "[") {
        stack.push(
          char === "{" ? { kind: "object", keys: /* @__PURE__ */ new Set(), expectingKey: true } : { kind: "array" }
        );
        if (stack.length > MAX_UNIQUE_JSON_DEPTH) throw new SyntaxError(INVALID_JSON);
      } else if (char === "}" || char === "]") {
        const container = stack.pop();
        if (!container || container.kind !== (char === "}" ? "object" : "array")) {
          throw new SyntaxError(INVALID_JSON);
        }
      } else if (char === ",") {
        const object2 = stack[stack.length - 1];
        if (object2?.kind === "object") object2.expectingKey = true;
      }
    }
    return JSON.parse(text);
  } catch {
    throw new SyntaxError(INVALID_JSON);
  }
}

// examples/counter-evidence/codec.mjs
var MAX_COUNTER_SAMPLES = 32;
var MAX_COUNTER_ARTIFACT_BYTES = 32 * 1024;
var COUNTER_FINALIZATION_RESERVE = 1024;
var MAX_COUNTER_SAMPLE_BYTES = 1024;
var COUNTER_SOURCE = Object.freeze({
  example: "cloudflare-build-a-counter-js",
  commit: "976c80e2120fdea5b4e1b1dd0eff2683802da981",
  fileSHA256: "1c7c0f960a1f9b91b0b7488fc228208d8ec2a39fdfaf0d89b553184fae9151a6",
  adapterVersion: 1
});
var COUNTER_RPC_SOURCE = Object.freeze({ ...COUNTER_SOURCE, adapterVersion: 2 });
var reasons = ["stopped", "read-failed", "invalid-sample", "interrupted", "sample-limit"];
var sampleKeys = ["observedAt", "receivedAt", "sourceRevision", "sourceCommitAt", "state"];
var bodyKeys = [
  "schemaVersion",
  "kind",
  "producerVersion",
  "source",
  "coverage",
  "startedAt",
  "lastReceivedAt",
  "samples",
  "end"
];
var encoder = new TextEncoder();
var bytes = (value) => encoder.encode(value).byteLength;
var timestamp = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 864e13;
var object = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
var exact = (value, keys) => object(value) && Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
var validVersion = (value) => typeof value === "string" && value.length <= 32 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
  value
) && !value.split("+")[0].split("-").slice(1).join("-").split(".").some((part) => /^0\d+$/.test(part));
var CounterSamplesError = class extends Error {
  constructor(code) {
    const messages = {
      "invalid-record": "The counter sample record could not be validated.",
      "invalid-sample": "The counter read sample could not be validated.",
      "record-size": "The counter samples exceed their fixed size or sample limit.",
      "record-open": "Finish the counter samples before exporting.",
      "record-integrity": "The counter sample content hash does not match."
    };
    super(messages[code] ?? messages["invalid-record"]);
    this.name = "CounterSamplesError";
    this.code = code;
  }
};
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}
function freeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function sampleFrom(input, sequence) {
  try {
    if (typeof input === "string") {
      if (bytes(input) > MAX_COUNTER_SAMPLE_BYTES) throw new Error();
      input = parseUniqueJson(input);
    }
    if (!exact(input, sequence === void 0 ? sampleKeys : ["sequence", ...sampleKeys]) || sequence !== void 0 && input.sequence !== sequence || !timestamp(input.observedAt) || !timestamp(input.receivedAt) || input.sourceRevision !== null || input.sourceCommitAt !== null || !exact(input.state, ["value"]) || !Number.isSafeInteger(input.state.value) || Math.abs(input.state.value) > 1e9)
      throw new Error();
    const sample = {
      ...sequence === void 0 ? {} : { sequence },
      observedAt: input.observedAt,
      receivedAt: input.receivedAt,
      sourceRevision: null,
      sourceCommitAt: null,
      state: { value: input.state.value }
    };
    if (bytes(canonical(sample)) > MAX_COUNTER_SAMPLE_BYTES) throw new Error();
    return sample;
  } catch {
    throw new CounterSamplesError("invalid-sample");
  }
}
function sourceFrom(value) {
  const known = [COUNTER_SOURCE, COUNTER_RPC_SOURCE].find(
    (source) => exact(value, Object.keys(source)) && Object.entries(source).every(([key, expected]) => value[key] === expected)
  );
  if (!known) throw new CounterSamplesError("invalid-record");
  return { ...known };
}
function bodyFrom(value, artifact = false) {
  try {
    if (!exact(value, artifact ? [...bodyKeys, "contentHash"] : bodyKeys) || value.schemaVersion !== 1 || value.kind !== "edgelab-counter-samples" || !validVersion(value.producerVersion) || value.coverage !== "discrete-read-samples" || !timestamp(value.startedAt) || !timestamp(value.lastReceivedAt) || !Array.isArray(value.samples) || value.samples.length < 1)
      throw new CounterSamplesError("invalid-record");
    const source = sourceFrom(value.source);
    if (value.samples.length > MAX_COUNTER_SAMPLES) throw new CounterSamplesError("record-size");
    const samples = value.samples.map((sample, index) => {
      if (!object(sample)) throw new CounterSamplesError("invalid-record");
      return sampleFrom(sample, index + 1);
    });
    if (value.startedAt !== samples[0].receivedAt || value.lastReceivedAt !== samples.at(-1).receivedAt)
      throw new CounterSamplesError("invalid-record");
    let end = null;
    if (value.end !== null) {
      if (!exact(value.end, ["reason", "at"]) || !reasons.includes(value.end.reason) || value.end.at !== null && !timestamp(value.end.at) || value.end.reason === "sample-limit" && samples.length !== MAX_COUNTER_SAMPLES)
        throw new CounterSamplesError("invalid-record");
      end = { reason: value.end.reason, at: value.end.at };
    }
    if (artifact && end === null) throw new CounterSamplesError("record-open");
    const body = {
      schemaVersion: 1,
      kind: "edgelab-counter-samples",
      producerVersion: value.producerVersion,
      source,
      coverage: "discrete-read-samples",
      startedAt: value.startedAt,
      lastReceivedAt: value.lastReceivedAt,
      samples,
      end
    };
    if (bytes(canonical({ ...body, end: null })) > MAX_COUNTER_ARTIFACT_BYTES - COUNTER_FINALIZATION_RESERVE)
      throw new CounterSamplesError("record-size");
    return body;
  } catch (error) {
    if (error instanceof CounterSamplesError) throw error;
    throw new CounterSamplesError("invalid-record");
  }
}
async function digest(body) {
  const result = await webcrypto.subtle.digest("SHA-256", encoder.encode(canonical(body)));
  return Buffer.from(result).toString("hex");
}
async function importSamples(text) {
  if (typeof text !== "string") throw new CounterSamplesError("invalid-record");
  if (bytes(text) > MAX_COUNTER_ARTIFACT_BYTES) throw new CounterSamplesError("record-size");
  let value;
  try {
    value = parseUniqueJson(text);
  } catch {
    throw new CounterSamplesError("invalid-record");
  }
  const body = freeze(bodyFrom(value, true));
  if (typeof value.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(value.contentHash))
    throw new CounterSamplesError("invalid-record");
  if (await digest(body) !== value.contentHash) throw new CounterSamplesError("record-integrity");
  return freeze({ ...body, contentHash: value.contentHash });
}
function inspect(record) {
  const body = bodyFrom(record, object(record) && Object.hasOwn(record, "contentHash"));
  const samples = body.samples;
  return Object.freeze({
    sampleCount: samples.length,
    firstValue: samples[0].state.value,
    lastValue: samples.at(-1).state.value,
    minimumValue: Math.min(...samples.map((sample) => sample.state.value)),
    maximumValue: Math.max(...samples.map((sample) => sample.state.value)),
    valueChanges: samples.filter(
      (sample, index) => index > 0 && sample.state.value !== samples[index - 1].state.value
    ).length,
    observationClockRegressions: samples.filter(
      (sample, index) => index > 0 && sample.observedAt < samples[index - 1].observedAt
    ).length,
    receiptClockRegressions: samples.filter(
      (sample, index) => index > 0 && sample.receivedAt < samples[index - 1].receivedAt
    ).length,
    firstObservedAt: samples[0].observedAt,
    lastObservedAt: samples.at(-1).observedAt,
    startedAt: body.startedAt,
    lastReceivedAt: body.lastReceivedAt,
    endReason: body.end?.reason ?? null,
    endedAt: body.end?.at ?? null
  });
}

// examples/counter-evidence/inspect.mjs
async function readBoundedFile(path) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await file.stat()).isFile()) throw new Error("Unsupported input.");
    const buffer = Buffer.alloc(MAX_COUNTER_ARTIFACT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > MAX_COUNTER_ARTIFACT_BYTES) throw new Error("Input exceeds its limit.");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } finally {
    await file.close();
  }
}
var utc = (at) => at === null ? "unavailable" : new Date(at).toISOString();
async function main(args = process.argv.slice(2)) {
  if (args.length !== 1) {
    console.error("Usage: node <inspector.mjs> <local-artifact.json>");
    return 1;
  }
  try {
    const artifact = await importSamples(await readBoundedFile(args[0]));
    const summary = inspect(artifact);
    const source = artifact.source;
    console.log(
      [
        "EdgeLab counter read samples \u2014 offline inspection",
        `Source: ${source.example}@${source.commit}`,
        `Source file SHA-256: ${source.fileSHA256}`,
        `Adapter: ${source.adapterVersion}; producer: ${artifact.producerVersion}`,
        source.adapterVersion === 1 ? "Declared observation clock origin: Durable Object after the additional KV read." : "Declared observation clock origin: gateway after the existing counter read RPC returns.",
        `Coverage: ${artifact.coverage}; samples: ${summary.sampleCount}`,
        `Observed value: first ${summary.firstValue}; last ${summary.lastValue}; range ${summary.minimumValue}..${summary.maximumValue}`,
        `Observed value changes: ${summary.valueChanges}; these do not identify commands or causes.`,
        `Observation clock: first ${utc(summary.firstObservedAt)}; last ${utc(summary.lastObservedAt)}`,
        `Recorder receipt clock: first ${utc(summary.startedAt)}; last ${utc(summary.lastReceivedAt)}`,
        `Clock regressions: observation ${summary.observationClockRegressions}; receipt ${summary.receiptClockRegressions}. Sequence alone orders samples.`,
        "Source revision and source commit time: unavailable (null). Observation time is not commit time.",
        `Capture ended: ${summary.endReason}; recorder end time: ${utc(summary.endedAt)}`,
        `Content SHA-256: ${artifact.contentHash}`,
        "A matching hash detects content changes; it does not establish authenticity or a complete history.",
        "Inspection performs no network calls, command execution or mutation replay."
      ].join("\n")
    );
    return 0;
  } catch {
    console.error("The local counter artifact could not be read or validated.");
    return 1;
  }
}
var entryPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) process.exitCode = await main();
export {
  main,
  readBoundedFile
};
