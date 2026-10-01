# ADR 014: unique object names in evidence JSON

## Decision

Lab recording and counter sample imports reject duplicate object names anywhere in the bounded input text, including equivalent escaped spellings. Raw string frames and samples use the same rule before being added to a capture. A rejected frame/sample closes the existing valid prefix through the codec's existing error path.

The maintained observer passes original message text to the recorder before display normalization can discard members. An invalid initial recording frame closes the connection through the existing invalid-frame path; a later invalid frame preserves and stops the capture prefix. This wiring has source review and pure codec coverage; rendered interaction remains unverified.

The shared browser-safe `worker/unique-json.mjs` scanner compares decoded names using JavaScript string equality, with a separate set for each object. Arrays and quoted values do not introduce member names. It applies no Unicode normalization or case folding. The iterative scanner allows at most 64 nested containers and 192 KiB of UTF-8 input; each codec retains its narrower frame/sample/archive limits. Ordinary `JSON.parse` still validates the grammar and creates the returned value. All parser failures use one static message without rejected names or values.

Existing schema validation, canonical serialization and SHA-256 checks follow this scan. Whitespace and object member order remain immaterial to the content hash. Valid historical archives and their hashes remain unchanged.

## Reproduced problem

Both codecs previously parsed raw text before validating its exact schema. JavaScript parsing overwrites an earlier member when a later member has the same decoded name. An earlier known member containing a synthetic private value could therefore disappear before validation; the later legitimate member preserved the original canonical hash. Root and nested duplicates, including escaped aliases, were accepted in both codecs.

The returned data did not contain the discarded value. This was neither a SHA-256 collision nor a source-authentication bypass. It broke the stated raw archive rejection boundary and allowed different parsers to disagree about the same file. A reviver cannot recover overwritten members, and a regular expression cannot reliably distinguish nested object names from quoted values.

## Standards and limits

[RFC 8259 section 4](https://www.rfc-editor.org/rfc/rfc8259.html#section-4) recommends unique object names because duplicate handling differs between implementations; its grammar permits duplicates. This decision makes such files unsupported evidence archives. [Section 8.3](https://www.rfc-editor.org/rfc/rfc8259.html#section-8.3) describes comparison after decoding escapes. [ECMAScript's JSON.parse specification](https://tc39.es/ecma262/2026/multipage/structured-data.html#sec-json.parse) specifies overwriting earlier duplicate values.

[RFC 8785 section 3.1](https://www.rfc-editor.org/rfc/rfc8785.html#section-3.1) also excludes duplicate names and preserves strings without normalization. EdgeLab uses its own canonical serialization and does not claim JCS compliance.

The content hash verifies canonical validated data. It neither authenticates the source nor hashes the original file bytes. The scanner does not make unsafe source data shareable; producers must continue to export only their explicit allowlisted fields. Already-parsed objects cannot reveal members discarded by an earlier parser. Live observer normalization retains its separate existing policy.

## Validation

Regressions cover duplicates with identical and different values, root/nested members, escaped aliases, quoted JSON-looking values, separate sibling objects, byte/depth bounds, malformed input and sanitized errors. Codec checks preserve valid-prefix stopping, ordinary pretty/reordered imports and pinned historical hashes. Native local capture and offline inspection exercise the maintained codec imports. HTTP asset verification confirms deployed bytes separately from rendered UI behavior.

This fixes a demonstrated correctness gap in the evidence workflow. It does not establish external adoption, improved diagnosis time or unmet product demand.
