// Assignment grammar and value decoding adapted from dotenv 16.3.1, also
// bundled by Wrangler 4.143.0. Source:
// https://github.com/motdotla/dotenv/blob/v16.3.1/lib/main.js
//
// Copyright (c) 2015, Scott Motte
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// * Redistributions of source code must retain the above copyright notice, this
//   list of conditions and the following disclaimer.
// * Redistributions in binary form must reproduce the above copyright notice,
//   this list of conditions and the following disclaimer in the documentation
//   and/or other materials provided with the distribution.
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
// FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
// DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
// SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
// CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
// OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

const assignments =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*\`(?:\\\`|[^\`])*\`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/dgm;

export function operatorAssignment(content) {
  let found = null;
  for (const match of content.matchAll(assignments)) {
    if (match[1] !== 'OPERATOR_TOKEN') continue;
    if (found)
      throw new Error(
        'Multiple OPERATOR_TOKEN assignments; preserve the file and resolve them privately',
      );
    let value = (match[2] ?? '').trim();
    const quote = value[0];
    value = value.replace(/^(['"\`])([\s\S]*)\1$/, '$2');
    if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    const body = match.index + match[0].length - match[0].trimStart().length;
    const start =
      Math.max(content.lastIndexOf('\n', body - 1), content.lastIndexOf('\r', body - 1)) + 1;
    const keyEnd = match.indices[1][1];
    const delimiter = /^\s*(?:=|:)/.exec(content.slice(keyEnd));
    let end = match.indices[2]?.[1] ?? keyEnd + delimiter[0].length;
    // The dotenv match may consume a following comment. Remove only this
    // assignment and its own physical line ending, preserving the next line.
    while (end < content.length && !['\r', '\n'].includes(content[end])) end++;
    if (content[end] === '\r') end++;
    if (content[end] === '\n') end++;
    found = { value, start, end };
  }
  return found;
}

export function replaceOperatorToken(content, token) {
  const found = operatorAssignment(content);
  const rest = found ? content.slice(0, found.start) + content.slice(found.end) : content;
  return rest + (rest && !rest.endsWith('\n') ? '\n' : '') + 'OPERATOR_TOKEN=' + token + '\n';
}
