import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { format } from 'prettier';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(`Project pinned public controlled examples; no Worker, account or AI calls.
  node scripts/brief-examples.mjs          Check the existing presentation JSON.
  node scripts/brief-examples.mjs --check  Check the existing presentation JSON.
  node scripts/brief-examples.mjs --write  Explicitly regenerate presentation JSON.

Source: docs/evidence/releases/3.3.2-brief-evaluation.json
Output: src/brief-examples-data.json
The source version is immutable evidence, not the current deployed capability.`);
  process.exit(0);
}
assert(
  args.length === 0 || (args.length === 1 && ['--check', '--write'].includes(args[0])),
  'Only --check and explicit --write are supported. There is no native mode.',
);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(root, 'docs/evidence/releases/3.3.2-brief-evaluation.json');
const outputPath = resolve(root, 'src/brief-examples-data.json');
const pinnedCommit = '67b27d01aacefdae1d6b5918240d54b9ddeb4769';
const report = JSON.parse(await readFile(sourcePath, 'utf8'));

assert.equal(report.projectVersion, '3.3.2');
assert.equal(report.reportVersion, 1);
assert.equal(report.suiteVersion, 1);
assert.equal(report.promptVersion, 1);
assert.equal(report.schemaVersion, 1);
assert.equal(report.model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
assert.equal(report.mode, 'offline');
assert.equal(report.sourceKind, 'controlled-fixtures-only');
for (const key of ['nativeInferenceCalls', 'cloudflareAccountQueries', 'productionWrites'])
  assert.equal(report.execution[key], 0);
for (const key of ['modelQualityMeasured', 'nativeProviderVerified', 'rootCauseProven'])
  assert.equal(report.interpretation[key], false);
assert.deepEqual(
  report.cases.map((entry) => entry.id),
  ['http-recovery', 'timeout-gaps', 'insufficient-history'],
);

// Pick every nested public field deliberately; never spread raw source objects.
// Counts and hashes are copied verbatim. Production-domain tests establish their
// provenance; this projection does not implement hashing or monitoring maths.
const pick = (value, fields) => {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  const result = {};
  for (const key of fields) {
    assert(Object.hasOwn(value, key), `Missing pinned presentation field: ${key}`);
    result[key] = structuredClone(value[key]);
  }
  return result;
};
function publicEvidence(value) {
  return {
    ...pick(value, ['schemaVersion', 'capturedAt']),
    incident: pick(value.incident, ['id', 'service', 'opened', 'resolved', 'acknowledged']),
    range: pick(value.range, ['fromSlot', 'toSlot', 'retentionStart', 'limitedByRetention']),
    checks: value.checks.map((check) =>
      pick(check, [
        'id',
        'service',
        'slot',
        'at',
        'outcome',
        'status',
        'latency',
        'revision',
        'observedAt',
        'timing',
      ]),
    ),
    versions: value.versions.map((version) => ({
      ...pick(version, [
        'id',
        'service',
        'revision',
        'recordedAt',
        'name',
        'transport',
        'assertion',
        'provenance',
      ]),
      policy: pick(version.policy, [
        'paused',
        'timeoutMs',
        'latencyObjectiveMs',
        'availabilityTarget',
        'failureThreshold',
        'recoveryThreshold',
      ]),
    })),
    lifecycle: value.lifecycle.map((event) => pick(event, ['id', 'action', 'at'])),
    facts: {
      ...pick(value.facts, [
        'recordedChecks',
        'verifiedChecks',
        'goodChecks',
        'badChecks',
        'maintenanceChecks',
        'legacyChecks',
        'invalidTimingChecks',
        'missingMinutesWithinSlice',
        'selectedFromSlot',
        'selectedToSlot',
        'finishedExpectedMinutesWithinSlice',
        'finishedEligibleMinutesWithinSlice',
        'verifiedCoveragePercentWithinFinishedSlice',
      ]),
      outcomes: pick(value.facts.outcomes, [
        'good',
        'http-error',
        'timeout',
        'network-error',
        'invalid-body',
        'slow',
        'maintenance',
      ]),
    },
    limits: pick(value.limits, [
      'checkLimit',
      'checksOmitted',
      'olderPagesAvailable',
      'limitedByRetention',
      'missingPolicyRevisions',
      'recoveredPolicyRevisions',
      'includesCurrentMinute',
      'measurement',
      'responseBodiesAvailable',
      'privateNotesIncluded',
    ]),
    references: value.references.map((reference) =>
      pick(reference, ['id', 'kind', 'label', 'detail', 'allowedKinds']),
    ),
  };
}
const examples = report.cases.map((entry) => {
  assert.equal(entry.sourceKind, 'controlled-fixture');
  assert.match(entry.label, /^CONTROLLED:/);
  assert.equal(entry.validation.causalConclusion, 'unverified');
  const common = {
    ...pick(entry, ['id', 'label', 'description', 'sourceKind', 'evidenceHash']),
    nativeInferenceCalls: 0,
    rootCauseProven: false,
    capturedAt: entry.evidence.capturedAt,
    evidence: publicEvidence(entry.evidence),
  };
  if (entry.preparation === null) {
    assert.equal(entry.validation.outcome, 'skipped-insufficient-evidence');
    assert.equal(entry.validation.fakeAdapterDispatches, 0);
    assert.equal(entry.validation.generated, null);
    return {
      ...common,
      responseOrigin: 'none',
      disposition: 'insufficient-evidence',
      inputHash: null,
      suppliedCitationIds: [],
      omittedEvidenceCount: null,
      messageBytes: null,
      inputBytes: null,
      generated: null,
    };
  }
  assert.equal(entry.validation.outcome, 'accepted-canned-response');
  assert.equal(entry.validation.responseOrigin, 'human-authored-canned-envelope');
  assert.equal(entry.validation.fakeAdapterDispatches, 1);
  return {
    ...common,
    responseOrigin: entry.validation.responseOrigin,
    disposition: 'validated-canned-response',
    ...pick(entry.preparation, ['inputHash', 'omittedEvidenceCount', 'messageBytes', 'inputBytes']),
    suppliedCitationIds: [...entry.preparation.citationIds],
    generated: {
      hypotheses: entry.validation.generated.hypotheses.map((hypothesis) =>
        pick(hypothesis, ['kind', 'explanation', 'evidenceIds', 'nextChecks']),
      ),
    },
  };
});
const projected = {
  source: {
    sourceProjectVersion: report.projectVersion,
    sourceArtifactURL: `https://github.com/HenryWashuHe/edgelab/blob/${pinnedCommit}/docs/evidence/releases/3.3.2-brief-evaluation.json`,
    evaluationGuideURL: `https://github.com/HenryWashuHe/edgelab/blob/${pinnedCommit}/docs/BRIEF_EVALUATION.md`,
    ...pick(report, [
      'reportVersion',
      'suiteVersion',
      'promptVersion',
      'schemaVersion',
      'model',
      'mode',
      'sourceKind',
    ]),
    responseOrigin: 'human-authored-canned-envelope',
    ...pick(report.execution, [
      'nativeInferenceCalls',
      'cloudflareAccountQueries',
      'productionWrites',
    ]),
    ...pick(report.interpretation, [
      'modelQualityMeasured',
      'nativeProviderVerified',
      'rootCauseProven',
    ]),
    ...pick(report.limits, ['maxMessageBytes', 'maxInputBytes', 'maxOutputTokens']),
  },
  examples,
};
if (args[0] === '--write') {
  const style = JSON.parse(await readFile(resolve(root, '.prettierrc.json'), 'utf8'));
  const formatted = await format(JSON.stringify(projected), { ...style, parser: 'json' });
  await writeFile(outputPath, formatted);
  console.log('Wrote src/brief-examples-data.json from the fixed public 3.3.2 artifact.');
} else {
  const existing = JSON.parse(await readFile(outputPath, 'utf8'));
  assert(
    isDeepStrictEqual(existing, projected),
    'Public examples differ from the pinned projection; inspect the change before an explicit --write.',
  );
  console.log('PASS pinned public examples match the whitelisted 3.3.2 projection.');
}
