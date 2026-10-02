# OT consumer boundary experiment

This local Node experiment tests two exact client modules from Cloudflare OS revision `1ef6020a42fbabb6d27dd1063db3a075ba95c974`. It is a preliminary boundary check for the [developer workflow hypothesis](../../docs/PRODUCT_VALUE.md#independent-application-assessment-stale-subscriptions). It does not run the full application, server producer, RPC transport, React or a browser, and it does not reproduce [issue #305](https://github.com/cloudflare/cloudflare-os/issues/305).

The question is deliberately narrow: **does callback completion or the client's applied revision prove that the consumer finished processing a code row?** The pinned client queues `pushRow()` work asynchronously. It updates its server-acked model revision before updating the display model and calling the editor delegate. A later failure can therefore leave an advanced revision while the client reports a fatal error. Neither internal model proves rendered state.

## Run the actual client under Node

From the EdgeLab repository root, after `npm ci`:

```sh
npm ci --prefix examples/subscription-evidence --ignore-scripts --no-audit --no-fund
npm --prefix examples/subscription-evidence test
```

Node 22.12+ is required. The fixture has its own package and lockfile; it does not change EdgeLab's application dependencies. Its CodeMirror state, fast-diff and transitive cluster-break versions match the pinned upstream lockfile. Installation downloads those packages; the consumer tests use synthetic data and controlled in-process delegates without Cloudflare account access.

`upstream/otClient.ts` and `upstream/code-change.ts` preserve the original source bytes. `upstream/provenance.json` records the source revision, URLs, byte hashes, license and dependency versions. The upstream Apache license is retained. The test build adds only two read-only probe methods to an in-memory copy: a snapshot of generation, server-acked model revision, ready/fatal/disposed flags, and an observer that awaits the actual queue. It does not alter the client algorithm, write private fields or disable its recovery. These methods are fixture instrumentation; the upstream client does not provide them as a public diagnostic API.

## What the test can establish

The controlled cases distinguish queued delivery from later model application, preserve missing-row ordering and duplicate replay, exercise application failures before and after model revision advancement, and retain generation gating. They also exercise the client's existing materialized-watermark recovery and recreation from an authoritative input snapshot. Snapshot inputs and base-file reads are controlled delegates; they are not actual server-storage reads.

The delegate failure is already exposed by the upstream client's `isReady()` and `onFatalError()`; these probes explain why revision alone is insufficient, rather than adding failure detection or recovery.

A position must be interpreted with its generation and lifecycle flags. An advanced model revision with a fatal client does not demonstrate completed editor processing. A ready, matching model position still does not demonstrate rendering or prove that all chat/tool activity was delivered. This experiment concerns code rows only.

The remaining paired-position experiment must execute the actual persisted producer path, preserve its existing retained-row replay and independently observe the relevant successful consumer boundary before refresh. It must compare its answer with ordinary reads, error notifications and native traces. This preliminary proof establishes neither that EdgeLab adds a new diagnostic answer nor that developers need or will reuse a product.
