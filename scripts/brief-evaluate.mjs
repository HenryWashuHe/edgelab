import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { build, version as esbuildVersion } from 'esbuild';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(`Offline incident-brief evaluation only.
  node scripts/brief-evaluate.mjs           Generate and verify the controlled report.
  node scripts/brief-evaluate.mjs --verify  Recompute and compare the existing report.

No live mode, account queries, credential reads, network inference or retries.
Report: output/brief-evaluation-offline.json`);
  process.exit(0);
}
assert(
  args.length === 0 || (args.length === 1 && args[0] === '--verify'),
  'Only offline evaluation and --verify are supported. Native execution is not implemented.',
);
const verifyOnly = args[0] === '--verify';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = resolve(root, 'output/brief-evaluation-offline.json');
const packageVersion = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;
const counts = { fakeAdapterDispatches: 0, blockedFetches: 0 };
// A future accidental fetch fails closed, including during source imports.
globalThis.fetch = async () => {
  counts.blockedFetches++;
  throw new Error('This controlled evaluation is offline; fetch is disabled.');
};

// Bundle the real production exports in memory. No Worker, server or binding
// connector is started, and no Wrangler authentication files are accessed.
const compiled = await build({
  stdin: {
    contents: `export * from './worker/incident-brief-domain.ts';
export * from './worker/incident-brief-ai.ts';
export * from './tests/fixtures/brief-evaluation-data.ts';`,
    resolveDir: root,
    sourcefile: 'brief-evaluation-offline.ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  target: 'esnext',
});
const suite = await import(
  `data:text/javascript;base64,${Buffer.from(`${compiled.outputFiles[0].text}\n//# sourceURL=brief-evaluation-offline.bundle.mjs\n`).toString('base64')}`
);
const {
  BRIEF_MODEL,
  BRIEF_PROMPT_VERSION,
  BRIEF_SCHEMA_VERSION,
  BRIEF_MAX_OUTPUT_TOKENS,
  MAX_BRIEF_MESSAGE_BYTES,
  MAX_BRIEF_INPUT_BYTES,
  MAX_BRIEF_OUTPUT_BYTES,
  BRIEF_EVALUATION_SUITE_VERSION,
  BRIEF_EVALUATION_CASES,
  CONTROLLED_CAPTURE_AT,
  CONTROLLED_PRIVATE_SENTINEL,
  captureBriefEvidence,
  hashBriefEvidence,
  buildBriefInput,
  decodeBriefResponse,
  runIncidentBriefAI,
  validateBriefOutput,
} = suite;
const copy = (value) => JSON.parse(JSON.stringify(value));
const bytes = (value) =>
  Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
assert.equal(BRIEF_EVALUATION_CASES.length, 3, 'Keep the controlled suite explicitly bounded.');
assert.equal(new Set(BRIEF_EVALUATION_CASES.map((entry) => entry.id)).size, 3);

const results = [];
for (const fixture of BRIEF_EVALUATION_CASES) {
  const sourceBefore = JSON.stringify(fixture.detail);
  const captured = await captureBriefEvidence(fixture.detail, CONTROLLED_CAPTURE_AT);
  const repeated = await captureBriefEvidence(copy(fixture.detail), CONTROLLED_CAPTURE_AT);
  assert.equal(captured.evidenceHash, repeated.evidenceHash, `${fixture.id}: stable capture hash`);
  assert.equal(await hashBriefEvidence(captured.evidence), captured.evidenceHash);
  assert.equal(JSON.stringify(fixture.detail), sourceBefore, `${fixture.id}: source not mutated`);
  assert(Object.isFrozen(captured.evidence) && Object.isFrozen(captured.evidence.checks));
  for (const [key, expected] of Object.entries(fixture.expectedFacts))
    assert.equal(captured.evidence.facts[key], expected, `${fixture.id}: hand-counted ${key}`);
  assert(!JSON.stringify(captured).includes(CONTROLLED_PRIVATE_SENTINEL));

  // Match the production eligibility gate before any preparation or dispatch.
  // The insufficient fixture must not touch even the fake provider adapter.
  if (captured.evidence.facts.badChecks === 0) {
    assert.equal(fixture.expectedDisposition, 'skip-insufficient-evidence');
    assert.equal(fixture.cannedEnvelope, null);
    results.push({
      id: fixture.id,
      label: fixture.label,
      description: fixture.description,
      sourceKind: 'controlled-fixture',
      evidenceHash: captured.evidenceHash,
      evidenceBytes: bytes(captured.evidence),
      evidence: captured.evidence,
      preparation: null,
      validation: {
        outcome: 'skipped-insufficient-evidence',
        reason: 'No verified bad observation; no prompt preparation or adapter dispatch.',
        fakeAdapterDispatches: 0,
        generated: null,
        causalConclusion: 'unverified',
      },
    });
    continue;
  }

  assert.equal(fixture.expectedDisposition, 'validate-canned-response');
  assert(fixture.cannedEnvelope);
  const prepared = buildBriefInput(captured.evidence);
  const serializedInput = JSON.stringify(prepared.input);
  assert.equal(prepared.inputBytes, bytes(serializedInput));
  assert.equal(
    prepared.messageBytes,
    bytes(prepared.input.messages.map((message) => message.content).join('')),
  );
  assert(prepared.messageBytes <= MAX_BRIEF_MESSAGE_BYTES);
  assert(prepared.inputBytes <= MAX_BRIEF_INPUT_BYTES);
  assert(!serializedInput.includes(CONTROLLED_PRIVATE_SENTINEL));
  assert(!serializedInput.includes(fixture.detail.versions[0].name));
  const prompt = JSON.parse(prepared.input.messages.find((entry) => entry.role === 'user').content);
  assert.deepEqual(
    prompt.references.map((entry) => entry.id),
    prepared.citationIds,
    `${fixture.id}: allowed citations match the references actually supplied`,
  );
  assert.equal(prompt.omittedReferences, prepared.omittedEvidenceCount);
  assert.equal(
    prepared.omittedEvidenceCount,
    captured.evidence.references.length - prepared.citationIds.length,
  );
  assert.equal(prompt.limits.rootCauseProven, false);

  let fixtureDispatches = 0;
  const controller = new AbortController();
  const fakeBinding = {
    async run(model, input, options) {
      counts.fakeAdapterDispatches++;
      fixtureDispatches++;
      assert.equal(fixtureDispatches, 1, 'Never retry the fake or future native adapter.');
      assert.equal(model, BRIEF_MODEL);
      assert.equal(input, prepared.input);
      assert.equal(input.max_tokens, BRIEF_MAX_OUTPUT_TOKENS);
      assert.equal(input.stream, false);
      assert.equal(input.temperature, 0);
      assert.equal(options.signal, controller.signal);
      assert.equal(options.rejectIfBusy, true);
      return copy(fixture.cannedEnvelope);
    },
  };
  const envelope = await runIncidentBriefAI(fakeBinding, prepared, controller.signal);
  const generated = validateBriefOutput(
    decodeBriefResponse(envelope),
    captured.evidence,
    prepared.citationIds,
  );
  assert.deepEqual(generated, decodeBriefResponse(fixture.cannedEnvelope));
  assert.equal(fixtureDispatches, 1);
  results.push({
    id: fixture.id,
    label: fixture.label,
    description: fixture.description,
    sourceKind: 'controlled-fixture',
    evidenceHash: captured.evidenceHash,
    evidenceBytes: bytes(captured.evidence),
    evidence: captured.evidence,
    preparation: {
      model: prepared.model,
      promptVersion: BRIEF_PROMPT_VERSION,
      schemaVersion: BRIEF_SCHEMA_VERSION,
      inputHash: sha256(serializedInput),
      inputBytes: prepared.inputBytes,
      messageBytes: prepared.messageBytes,
      citationIds: prepared.citationIds,
      omittedEvidenceCount: prepared.omittedEvidenceCount,
      input: prepared.input,
    },
    validation: {
      outcome: 'accepted-canned-response',
      responseOrigin: 'human-authored-canned-envelope',
      responseEnvelopeBytes: bytes(envelope),
      fakeAdapterDispatches: fixtureDispatches,
      generated,
      causalConclusion: 'unverified',
    },
  });
}

const base = results.find((entry) => entry.id === 'http-recovery');
assert(base?.preparation);
const validOutput = base.validation.generated;
const guards = [];
function rejectGuard(id, mutateEnvelope, expectedError) {
  const envelope = mutateEnvelope({ response: copy(validOutput) });
  assert.throws(
    () =>
      validateBriefOutput(
        decodeBriefResponse(envelope),
        base.evidence,
        base.preparation.citationIds,
      ),
    expectedError,
    `${id}: adversarial output must be rejected`,
  );
  guards.push({ id, outcome: 'rejected-as-expected', nativeInferenceCalls: 0 });
}
rejectGuard(
  'invented-citation',
  (envelope) => {
    envelope.response.hypotheses[0].evidenceIds = ['check:99999999999999'];
    return envelope;
  },
  /Citation was not supplied/,
);
rejectGuard(
  'wrong-symptom-citation',
  (envelope) => {
    envelope.response.hypotheses[0].kind = 'transport-failure';
    return envelope;
  },
  /Citations do not support the hypothesis symptom kind/,
);
const omitted = base.evidence.references.find(
  (entry) => !base.preparation.citationIds.includes(entry.id),
);
if (omitted)
  rejectGuard(
    'retained-but-not-supplied-citation',
    (envelope) => {
      envelope.response.hypotheses[0].evidenceIds = [omitted.id];
      return envelope;
    },
    /Citation was not supplied/,
  );
rejectGuard(
  'unexpected-root-field',
  (envelope) => {
    envelope.response.rootCause = 'A fabricated certainty';
    return envelope;
  },
  /Unexpected or missing brief fields/,
);
rejectGuard(
  'html-explanation',
  (envelope) => {
    envelope.response.hypotheses[0].explanation = '<b>Untrusted model markup</b>';
    return envelope;
  },
  /plain text/,
);
rejectGuard(
  'provider-tool-call',
  (envelope) => ({ ...envelope, tool_calls: [{ name: 'execute-command' }] }),
  /Tool calls are not permitted/,
);

assert.equal(counts.fakeAdapterDispatches, 2);
assert.equal(
  counts.blockedFetches,
  0,
  'No code in the offline evaluation should request a network.',
);
assert.equal(results.filter((entry) => entry.validation.fakeAdapterDispatches === 0).length, 1);
const report = {
  reportVersion: 1,
  suiteVersion: BRIEF_EVALUATION_SUITE_VERSION,
  projectVersion: packageVersion,
  mode: 'offline',
  sourceKind: 'controlled-fixtures-only',
  capturedAt: CONTROLLED_CAPTURE_AT,
  model: BRIEF_MODEL,
  promptVersion: BRIEF_PROMPT_VERSION,
  schemaVersion: BRIEF_SCHEMA_VERSION,
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    esbuildVersion,
  },
  limits: {
    maxMessageBytes: MAX_BRIEF_MESSAGE_BYTES,
    maxInputBytes: MAX_BRIEF_INPUT_BYTES,
    maxOutputEnvelopeBytes: MAX_BRIEF_OUTPUT_BYTES,
    maxOutputTokens: BRIEF_MAX_OUTPUT_TOKENS,
    controlledCaseCap: 3,
    automaticRetries: 0,
  },
  execution: {
    fakeAdapterDispatches: counts.fakeAdapterDispatches,
    nativeInferenceCalls: 0,
    cloudflareAccountQueries: 0,
    productionWrites: 0,
    blockedFetches: counts.blockedFetches,
  },
  interpretation: {
    purpose:
      'Exercise production evidence preparation, native-envelope decoding and strict validation offline.',
    modelQualityMeasured: false,
    nativeProviderVerified: false,
    rootCauseProven: false,
    warning:
      'Canned acceptance checks schema and relevant citations; every proposed cause remains unverified.',
  },
  cases: results,
  adversarialGuards: guards,
};
assert(!JSON.stringify(report).includes(CONTROLLED_PRIVATE_SENTINEL));
if (verifyOnly) {
  const saved = JSON.parse(await readFile(reportPath, 'utf8'));
  assert(
    isDeepStrictEqual(saved, report),
    'Saved report differs from a fresh offline replay. Regenerate it.',
  );
} else {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(
  `${verifyOnly ? 'Verified' : 'Saved verified'} offline report: 3 controlled cases, 2 canned responses accepted, 1 inference skipped, ${guards.length} adversarial guards rejected; native inference calls: 0.\n${reportPath}`,
);
