# ADR 012: Load dashboard sections when selected

Status: accepted and deployed in 3.11.0. Complete CI, actual build-graph comparison and live asset/monitoring checks pass; rendered interaction verification remains unverified.

## Context

The 3.10.0 client eagerly includes Operations, observer, replay, Architecture and Fieldnotes in one JavaScript bundle. A reviewer opening Operations also receives the historical recording and controlled evidence panels. A smaller entry bundle is useful, but moving code must preserve private-state cleanup and offline recording provenance.

## Decision

Use module-level React lazy imports for Operations, observer, a replay wrapper and the shared Guide module. The replay wrapper owns its pinned raw recording import. Architecture and Fieldnotes intentionally remain in one Guide chunk. The app shell, navigation and owner laboratory remain eager; owner epochs and session rules stay in the stable App component.

Each deferred section is inside a boundary keyed by the selected page, above Suspense. Navigation uses ordinary immediate updates. Previous section instances unmount rather than remaining hidden while a new section loads. Existing Operations credential/read cleanup, observer socket/capture cleanup and replay import fencing stay in their original components. No loader creates a capability, makes an application API request, opens a socket or starts a timer. Static code and stylesheet downloads are expected.

Loading exposes a polite status while navigation remains outside the boundary. Failure exposes a generic message and explicit full-page reload. It does not display an exception, automatically reload, retry a mutation or replay an experiment. Reload discards credentials, drafts and recordings held in the page; completed server work remains possible. Every internal page-selection action updates the hash so reload has the same destination.

Shared entry-link styles move into a small eager stylesheet. Other section styles remain with their section. No manual vendor splitting, prefetching, retained hidden section or laboratory extraction is introduced.

## Verification

Measure actual production chunks with Vite in memory and compare them with the pinned 3.10.0 implementation under equivalent dependency content. Count the entry, selected section and all recursive static JavaScript and stylesheet dependencies. Compress each file independently for descriptive byte totals. Entry-only savings do not describe the default Operations route. Build sizes establish neither browser timing nor deployed transfer compression.

The build recipe checks maintained output bytes, complete module dependencies, the initial exclusion of deferred evidence and stable source hashes. The release verifier checks every built file, including deferred chunks and the favicon, for exact bytes, correct MIME type and required revalidation. Bounded fault tests reject a missing chunk, HTML fallback, modified bytes and stale-cache HTML. Runtime HTTP verification complements source review; it does not exercise browser loading, Back/Forward, fallback rendering or component cleanup.

The pinned 3.6.0 recording, its unsigned integrity hash and its trusted built-in loading action remain separate from the current deployment. Identical uploads remain generic. No route selection adds an application API or socket command to replay.

## Consequences

The first visit to a deferred section needs its static assets. A deployment can leave an older open page referring to a removed chunk; manual reload is the recovery path. React caches rejected lazy imports, so rerendering is not advertised as a reliable retry. Browser interaction and lifecycle behavior remain unverified until permitted rendered checks are available.

References: [React lazy](https://react.dev/reference/react/lazy), [Vite load errors](https://vite.dev/guide/build.html#load-error-handling), [Cloudflare static asset headers](https://developers.cloudflare.com/workers/static-assets/headers/).
