import { describe, expect, it } from 'vitest';
import {
  MAX_UNIQUE_JSON_BYTES,
  MAX_UNIQUE_JSON_DEPTH,
  parseUniqueJson,
} from '../worker/unique-json.mjs';

const invalidMessage = 'Invalid JSON input.';

function rejected(text: unknown) {
  let failure: unknown;
  try {
    parseUniqueJson(text as string);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(SyntaxError);
  expect((failure as SyntaxError).message).toBe(invalidMessage);
}

describe('bounded JSON with unique decoded object names', () => {
  it('rejects root duplicates even when their values are identical', () => {
    rejected('{"a":1,"a":1}');
    rejected('{"a":{"private":"hidden"},"a":1}');
  });

  it('rejects duplicates inside objects nested in objects and arrays', () => {
    rejected('{"outer":{"a":1,"a":2}}');
    rejected('[{"a":1,"a":2}]');
    rejected('{"outer":[{"a":1,"a":2}]}');
  });

  it('rejects escaped aliases at the root and within nested objects', () => {
    rejected(String.raw`{"a":1,"\u0061":2}`);
    rejected(String.raw`{"outer":{"st\u0061te":{"private":"hidden"},"state":{}}}`);
    rejected(String.raw`{"😀":1,"\ud83d\ude00":2}`);
  });

  it('rejects duplicate names with escaped quotes and backslashes', () => {
    rejected(String.raw`{"a\"b":1,"a\"b":2}`);
    rejected(String.raw`{"a\\b":1,"a\u005cb":2}`);
  });

  it('allows the same name in distinct sibling and nested objects', () => {
    const text = '{"a":{"a":1},"b":{"a":2},"list":[{"a":3},{"a":4}]}';
    expect(parseUniqueJson(text)).toEqual(JSON.parse(text));
  });

  it('compares names without Unicode normalization or case folding', () => {
    const text = String.raw`{"A":1,"a":2,"é":3,"e\u0301":4,"\\u0061":5}`;
    expect(parseUniqueJson(text)).toEqual(JSON.parse(text));
  });

  it('ignores JSON-looking text, punctuation, and escaped quotes in values', () => {
    const input = {
      message: '{"a":1,"a":2}',
      escaped: '\\"[,]{}',
      list: ['{"private":1,"private":2}', '"key": "value"'],
      nested: { value: 'closing } and comma , do not change the object' },
    };
    expect(parseUniqueJson(JSON.stringify(input))).toEqual(input);
  });

  it('preserves ordinary scalar, array, and object parsing', () => {
    for (const text of ['null', 'true', 'false', '1.25e-2', '"text"', '[]', '{}']) {
      expect(parseUniqueJson(text)).toEqual(JSON.parse(text));
    }
  });

  it('permits whitespace and key reordering without changing parsed values', () => {
    const text = ' \r\n { "z" : [1, 2], "a" : { "b" : null } } \t ';
    expect(parseUniqueJson(text)).toEqual({ a: { b: null }, z: [1, 2] });
  });

  it('retains native handling of special object names without prototype mutation', () => {
    const value = parseUniqueJson('{"__proto__":{"test":1},"constructor":2}') as Record<
      string,
      unknown
    >;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.hasOwn(value, '__proto__')).toBe(true);
    expect(value.__proto__).toEqual({ test: 1 });
    rejected('{"__proto__":1,"__proto__":2}');
  });

  it('accepts exactly 64 nested containers and rejects the 65th', () => {
    const nested = (depth: number) => '['.repeat(depth) + '0' + ']'.repeat(depth);
    expect(parseUniqueJson(nested(MAX_UNIQUE_JSON_DEPTH))).toEqual(
      JSON.parse(nested(MAX_UNIQUE_JSON_DEPTH)),
    );
    rejected(nested(MAX_UNIQUE_JSON_DEPTH + 1));
  });

  it('counts both object and array containers toward the depth bound', () => {
    const nested = (depth: number) => {
      let text = 'null';
      for (let index = 0; index < depth; index++) {
        text = index % 2 ? `{"value":${text}}` : `[${text}]`;
      }
      return text;
    };
    expect(parseUniqueJson(nested(MAX_UNIQUE_JSON_DEPTH))).toEqual(
      JSON.parse(nested(MAX_UNIQUE_JSON_DEPTH)),
    );
    rejected(nested(MAX_UNIQUE_JSON_DEPTH + 1));
  });

  it('does not count JSON-looking containers in strings as nesting', () => {
    const text = JSON.stringify('['.repeat(MAX_UNIQUE_JSON_DEPTH + 1));
    expect(parseUniqueJson(text)).toBe('['.repeat(MAX_UNIQUE_JSON_DEPTH + 1));
  });

  it('accepts the exact UTF-8 byte cap and rejects an additional ASCII byte', () => {
    const text = '"' + 'a'.repeat(MAX_UNIQUE_JSON_BYTES - 2) + '"';
    expect(new TextEncoder().encode(text).byteLength).toBe(MAX_UNIQUE_JSON_BYTES);
    expect(parseUniqueJson(text)).toBe('a'.repeat(MAX_UNIQUE_JSON_BYTES - 2));
    rejected(text + ' ');
  });

  it('enforces UTF-8 bytes rather than JavaScript string length', () => {
    const text = '"' + 'é'.repeat((MAX_UNIQUE_JSON_BYTES - 2) / 2) + '"';
    expect(text.length).toBeLessThan(MAX_UNIQUE_JSON_BYTES);
    expect(new TextEncoder().encode(text).byteLength).toBe(MAX_UNIQUE_JSON_BYTES);
    expect(parseUniqueJson(text)).toEqual(JSON.parse(text));
    rejected(text.slice(0, -1) + 'é"');
    rejected('"' + '😀'.repeat(MAX_UNIQUE_JSON_BYTES / 4) + '"');
  });

  it('leaves complete grammar validation to native parsing with safe errors', () => {
    for (const text of [
      '',
      '{"a":1,}',
      '[1,]',
      '{"a" 1}',
      '{a:1}',
      '{"a":undefined}',
      '01',
      'true false',
      '[}',
      '"unfinished',
      String.raw`{"\q":1}`,
      '"literal\nnewline"',
    ]) {
      rejected(text);
    }
  });

  it('uses static errors for wrong types and does not echo private input', () => {
    for (const text of [
      null,
      undefined,
      1,
      {},
      ['text'],
      '{private-secret:',
      String.raw`"\q-secret"`,
    ]) {
      rejected(text);
    }
  });
});
