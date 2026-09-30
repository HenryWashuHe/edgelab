import { describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import report from '../docs/evidence/releases/3.3.2-brief-evaluation.json';
import presentation from '../src/brief-examples-data.json';
import {
  briefExamples,
  briefExamplesSource,
  examples,
  source,
  type BriefExample,
} from '../src/brief-examples';
import {
  BRIEF_MODEL,
  BRIEF_PROMPT_VERSION,
  BRIEF_SCHEMA_VERSION,
  buildBriefInput,
  captureBriefEvidence,
  hashBriefEvidence,
  validateBriefOutput,
  type BriefEvidence,
} from '../worker/incident-brief-domain';
import { decodeBriefResponse } from '../worker/incident-brief-ai';
import {
  BRIEF_EVALUATION_CASES,
  CONTROLLED_CAPTURE_AT,
  CONTROLLED_PRIVATE_SENTINEL,
} from './fixtures/brief-evaluation-data';

const pinnedCommit = '67b27d01aacefdae1d6b5918240d54b9ddeb4769';
async function inputHash(value: unknown) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function mutableClone(example: BriefExample): BriefEvidence {
  // A clone of the typed, whitelisted snapshot is mutable; no raw JSON is cast.
  return structuredClone(example.evidence) as BriefEvidence;
}
function keysDeep(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...keysDeep(child)]);
}

describe('pinned public incident brief examples', () => {
  it('declares controlled/canned provenance and pins source docs without claiming live capability', () => {
    expect(briefExamples).toBe(examples);
    expect(briefExamplesSource).toBe(source);
    expect(examples.map((example) => example.id)).toEqual([
      'http-recovery',
      'timeout-gaps',
      'insufficient-history',
    ]);
    expect(source).toMatchObject({
      sourceProjectVersion: '3.3.2',
      reportVersion: 1,
      suiteVersion: 1,
      model: BRIEF_MODEL,
      promptVersion: BRIEF_PROMPT_VERSION,
      schemaVersion: BRIEF_SCHEMA_VERSION,
      mode: 'offline',
      sourceKind: 'controlled-fixtures-only',
      responseOrigin: 'human-authored-canned-envelope',
      nativeInferenceCalls: 0,
      cloudflareAccountQueries: 0,
      productionWrites: 0,
      modelQualityMeasured: false,
      nativeProviderVerified: false,
      rootCauseProven: false,
    });
    expect(source.sourceArtifactURL).toBe(
      `https://github.com/HenryWashuHe/edgelab/blob/${pinnedCommit}/docs/evidence/releases/3.3.2-brief-evaluation.json`,
    );
    expect(source.evaluationGuideURL).toBe(
      `https://github.com/HenryWashuHe/edgelab/blob/${pinnedCommit}/docs/BRIEF_EVALUATION.md`,
    );
    examples.forEach((example) => {
      expect(example.label).toMatch(/^CONTROLLED:/);
      expect(example.sourceKind).toBe('controlled-fixture');
      expect(example.nativeInferenceCalls).toBe(0);
      expect(example.rootCauseProven).toBe(false);
      expect(example.capturedAt).toBe(CONTROLLED_CAPTURE_AT);
    });
  });

  for (const fixture of BRIEF_EVALUATION_CASES) {
    it(`${fixture.id}: matches current production capture, full snapshot hash, prompt provenance and strict output validation`, async () => {
      const example = examples.find((entry) => entry.id === fixture.id)!;
      const archived = report.cases.find((entry) => entry.id === fixture.id)!;
      const captured = await captureBriefEvidence(fixture.detail, CONTROLLED_CAPTURE_AT);
      expect(example.evidence).toEqual(captured.evidence);
      expect(example.evidence).toEqual(archived.evidence);
      expect(example.evidenceHash).toBe(captured.evidenceHash);
      expect(await hashBriefEvidence(mutableClone(example))).toBe(example.evidenceHash);
      expect(example.evidence.facts).toMatchObject(fixture.expectedFacts);

      if (fixture.expectedDisposition === 'skip-insufficient-evidence') {
        expect(captured.evidence.facts.badChecks).toBe(0);
        expect(example).toMatchObject({
          disposition: 'insufficient-evidence',
          responseOrigin: 'none',
          inputHash: null,
          suppliedCitationIds: [],
          omittedEvidenceCount: null,
          messageBytes: null,
          inputBytes: null,
          generated: null,
        });
        return;
      }

      const prepared = buildBriefInput(captured.evidence);
      expect(example.disposition).toBe('validated-canned-response');
      expect(example.responseOrigin).toBe('human-authored-canned-envelope');
      expect(example.inputHash).toBe(await inputHash(prepared.input));
      expect(example.suppliedCitationIds).toEqual(prepared.citationIds);
      expect(example.omittedEvidenceCount).toBe(prepared.omittedEvidenceCount);
      expect(example.messageBytes).toBe(prepared.messageBytes);
      expect(example.inputBytes).toBe(prepared.inputBytes);
      expect(prepared.messageBytes).toBeLessThanOrEqual(source.maxMessageBytes);
      expect(prepared.inputBytes).toBeLessThanOrEqual(source.maxInputBytes);
      const accepted = validateBriefOutput(
        decodeBriefResponse(fixture.cannedEnvelope),
        captured.evidence,
        prepared.citationIds,
      );
      expect(example.generated).toEqual(accepted);
      expect(example.generated).toEqual(archived.validation.generated);
      expect(
        example.evidence.references.filter(
          (reference) => !example.suppliedCitationIds.includes(reference.id),
        ),
      ).toHaveLength(example.omittedEvidenceCount!);
    });
  }

  it('changes the local content hash for a tampered clone while preserving frozen evidence and facts', async () => {
    const example = examples[0];
    const before = JSON.stringify(example);
    const factsBefore = structuredClone(example.evidence.facts);
    const changed = mutableClone(example);
    changed.checks[0].latency += 1;
    expect(await hashBriefEvidence(changed)).not.toBe(example.evidenceHash);
    expect(await hashBriefEvidence(mutableClone(example))).toBe(example.evidenceHash);
    expect(example.evidence.facts).toEqual(factsBefore);
    expect(JSON.stringify(example)).toBe(before);
    expect(Object.isFrozen(examples)).toBe(true);
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(example)).toBe(true);
    expect(Object.isFrozen(example.evidence.checks[0])).toBe(true);
    expect(Object.isFrozen(example.evidence.versions[0].policy)).toBe(true);
    expect(Object.isFrozen(example.evidence.references[0].allowedKinds)).toBe(true);
    expect(Object.isFrozen(example.evidence.facts.outcomes)).toBe(true);
    expect(Object.isFrozen(example.generated!.hypotheses[0].evidenceIds)).toBe(true);
    expect(Reflect.set(example.evidence.checks[0], 'latency', 999)).toBe(false);
    expect(JSON.stringify(example)).toBe(before);
  });

  it('keeps retained references inspectable but rejects omitted and invented citations', () => {
    const example = examples[0];
    const evidence = mutableClone(example);
    const omitted = evidence.references.find(
      (reference) => !example.suppliedCitationIds.includes(reference.id),
    )!;
    expect(omitted).toBeDefined();
    for (const id of [omitted.id, 'check:invented']) {
      const changed = structuredClone(example.generated)!;
      // This is a mutable clone of a typed canned response, not provider output.
      const invalid = {
        hypotheses: changed.hypotheses.map((hypothesis) => ({
          ...hypothesis,
          evidenceIds: [id],
        })),
      };
      expect(() => validateBriefOutput(invalid, evidence, example.suppliedCitationIds)).toThrow(
        /Citation was not supplied/,
      );
    }
  });

  it('exports only whitelisted public presentation fields, with no private sentinel, target URLs or raw prompts', () => {
    const publicData = { examples, source };
    expect(publicData).toEqual(presentation);
    const serialized = JSON.stringify(publicData);
    expect(serialized).not.toContain(CONTROLLED_PRIVATE_SENTINEL);
    expect(serialized).not.toContain('private-target');
    expect(serialized).not.toContain('Authorization');
    const forbidden = [
      'notes',
      'acknowledgementNote',
      'target',
      'url',
      'token',
      'requestId',
      'leaseToken',
      'capability',
      'quota',
      'admission',
      'environment',
      'response',
      'responseEnvelopeBytes',
      'fakeAdapterDispatches',
      'input',
      'messages',
      'response_format',
      'provider',
      'body',
    ];
    const publicKeys = keysDeep(publicData);
    forbidden.forEach((key) => expect(publicKeys).not.toContain(key));
    expect(serialized.match(/https?:\/\//g)).toHaveLength(2);
    expect(examples.map((example) => example.evidenceHash)).toEqual(
      report.cases.map((entry) => entry.evidenceHash),
    );
  });

  it('has no browser runtime dependency on a Worker, provider, fixture module or private brief API', async () => {
    const compiled = await build({
      entryPoints: ['src/brief-examples.ts'],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'esm',
      metafile: true,
    });
    expect(Object.keys(compiled.metafile!.inputs).sort()).toEqual([
      'src/brief-examples-data.json',
      'src/brief-examples.ts',
    ]);
    expect(compiled.outputFiles[0].text).not.toContain(CONTROLLED_PRIVATE_SENTINEL);
    expect(compiled.outputFiles[0].text).not.toContain('/api/ops/incident-brief');
    expect(compiled.outputFiles[0].text).not.toContain('response_format');
    expect(compiled.outputFiles[0].text).not.toContain('json_schema');
    expect(compiled.outputFiles[0].text).not.toMatch(/\bmessages\s*:/);
    const fetch = vi.fn(() => {
      throw new Error('Examples must not perform backend or inference requests');
    });
    vi.stubGlobal('fetch', fetch);
    try {
      vi.resetModules();
      const reloaded = await import('../src/brief-examples');
      expect(reloaded.examples).toEqual(examples);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
