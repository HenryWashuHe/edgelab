export const MAX_UNIQUE_JSON_BYTES = 196608;
export const MAX_UNIQUE_JSON_DEPTH = 64;

const INVALID_JSON = 'Invalid JSON input.';

/** Parse bounded JSON while rejecting duplicate decoded names within each object. */
export function parseUniqueJson(text) {
  try {
    // Every UTF-16 code unit requires at least one UTF-8 byte. Check this first
    // so encoding an oversized input cannot allocate another oversized buffer.
    if (
      typeof text !== 'string' ||
      text.length > MAX_UNIQUE_JSON_BYTES ||
      new TextEncoder().encode(text).byteLength > MAX_UNIQUE_JSON_BYTES
    ) {
      throw new SyntaxError(INVALID_JSON);
    }

    const stack = [];
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (char === '"') {
        const start = index;
        let closed = false;
        while (++index < text.length) {
          if (text[index] === '\\') {
            index++;
          } else if (text[index] === '"') {
            closed = true;
            break;
          }
        }
        if (!closed) throw new SyntaxError(INVALID_JSON);

        const object = stack[stack.length - 1];
        if (object?.kind === 'object' && object.expectingKey) {
          // Native decoding makes escaped aliases equal without normalizing
          // Unicode or folding case. Value strings never enter the key sets.
          const name = JSON.parse(text.slice(start, index + 1));
          if (object.keys.has(name)) throw new SyntaxError(INVALID_JSON);
          object.keys.add(name);
          object.expectingKey = false;
        }
      } else if (char === '{' || char === '[') {
        stack.push(
          char === '{'
            ? { kind: 'object', keys: new Set(), expectingKey: true }
            : { kind: 'array' },
        );
        if (stack.length > MAX_UNIQUE_JSON_DEPTH) throw new SyntaxError(INVALID_JSON);
      } else if (char === '}' || char === ']') {
        const container = stack.pop();
        if (!container || container.kind !== (char === '}' ? 'object' : 'array')) {
          throw new SyntaxError(INVALID_JSON);
        }
      } else if (char === ',') {
        const object = stack[stack.length - 1];
        if (object?.kind === 'object') object.expectingKey = true;
      }
    }

    // The scan identifies names and nesting only; native parsing remains the
    // authority for complete JSON grammar and preserves its ordinary values.
    return JSON.parse(text);
  } catch {
    // Never expose input, decoded names, or native parser diagnostics.
    throw new SyntaxError(INVALID_JSON);
  }
}
