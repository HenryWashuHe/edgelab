import { Globe2, Cloud, Database, ArrowRight, Server, Code2, Check } from 'lucide-react';
export function Architecture() {
  return (
    <div className="docs-layout">
      <section className="panel doc-panel">
        <div className="eyebrow">OPERATIONS / THE PERSISTENT PATH</div>
        <h2>One schedule. Durable evidence.</h2>
        <p>
          A one-minute Cron Trigger drives a SQLite monitoring coordinator for up to five approved
          services. It runs independently of the browser. The public dashboard reads checks and
          incidents; authenticated operators edit policies, acknowledge incidents, and inspect the
          audit trail.
        </p>
        <pre>{`Cron → claim durable job lease → bounded probe
  → verify lease token + policy revision
  → atomically store check and incident transition`}</pre>
        <p>
          Each service and scheduled minute has a unique key. Duplicate deliveries cannot
          double-count observations. A 30-second lease recovers abandoned work; revision fencing
          rejects results from outdated policies. Missing checks reduce coverage and never become
          healthy samples.
        </p>
        <p>
          Monitoring history has 30-day retention, with open incidents and policies preserved.
          Acknowledgement records ownership; only measured recovery resolves an incident. The
          monitor shares Cloudflare with its targets and does not establish global uptime.
        </p>
        <hr />
        <div className="eyebrow">LABORATORY / THE REQUEST PATH</div>
        <h2>Stateless at the edge. Consistent at the coordinator.</h2>
        <p>
          The Worker validates the request and routes the lab's opaque session ID to one Durable
          Object. That object owns admission, circuit state, the last successful catalog response,
          and a bounded SQLite event log.
        </p>
        <div className="architecture-strip">
          <span>
            <Globe2 />
            Browser
          </span>
          <ArrowRight />
          <span>
            <Cloud />
            Worker
          </span>
          <ArrowRight />
          <span>
            <Database />
            Durable Object
            <br />+ SQLite
          </span>
          <ArrowRight />
          <span>
            <Server />
            Origin Worker
          </span>
        </div>
        <p>
          The coordinator calls a separate, private origin Worker through a service binding. Its
          catalog data and failures are controlled, but the service call, timeout, and cached
          payload are real. The UI shows server elapsed time, not browser round-trip latency or
          multi-region benchmarks.
        </p>
        <hr />
        <div className="eyebrow">02 / WHY A DURABLE OBJECT?</div>
        <h2>One budget, even under concurrent traffic.</h2>
        <p>
          A per-Worker in-memory bucket would split the budget across isolates. An eventually
          consistent store can admit too many concurrent requests. A Durable Object coordinates each
          lab's state; synchronous SQLite transactions persist each admission before the handler
          awaits origin work.
        </p>
        <pre>{`Client → validate session → Durable Object\n  1. Refill and reserve a token\n  2. Check circuit / reserve recovery probe\n  3. Persist admission synchronously\n  4. Call origin Worker with timeout\n  5. Record result + circuit transition atomically`}</pre>
        <hr />
        <div className="eyebrow">03 / THE SUBTLE PART</div>
        <h2>Recovery is a concurrency problem.</h2>
        <p>
          Only one request enters half-open recovery. Other requests get a bounded-age cached
          response or HTTP 503. Each permit carries a circuit generation: a late success from an
          older generation cannot close a circuit that just tripped. A run ID prevents old in-flight
          requests from repopulating a reset lab.
        </p>
        <p>
          A persisted 10-second probe lease allows recovery if a probe is interrupted. Multiple
          calls admitted before a failure threshold may still reach the origin; a breaker cannot
          recall work already in flight.
        </p>
        <hr />
        <div className="eyebrow">04 / NOTHING LIVES FOREVER</div>
        <h2>Expiry is part of correctness.</h2>
        <p>
          Every API request renews the lab’s 24-hour idle deadline. An alarm checks the latest
          deadline before deleting storage. A completion arriving after deletion cannot recreate the
          old run. Local runtime tests exercise actual alarms and eviction, including cached payload
          persistence.
        </p>
      </section>
      <aside className="doc-side">
        <div className="panel doc-panel">
          <h3>Deliberate boundaries</h3>
          <ul>
            <li>
              One monitor coordinator for five services; separate isolated coordinators for
              experimental labs.
            </li>
            <li>Latest 180 events retained; counters cover the full run.</li>
            <li>
              The cache stores the actual catalog response and replays its revision for at most 60
              seconds.
            </li>
            <li>
              Opaque session IDs isolate demos; this is not an authenticated multi-tenant gateway.
            </li>
            <li>A public deployment needs account-level abuse controls and quota monitoring.</li>
            <li>An alarm clears all lab state after 24 hours without an API request.</li>
          </ul>
        </div>
        <div className="insight-card">
          <span className="insight-label">THE TRADEOFF</span>
          <p>
            Strong coordination adds a network hop to the object location. Measure it before
            claiming global low latency.
          </p>
        </div>
      </aside>
    </div>
  );
}
export function Notes() {
  return (
    <div className="docs-layout">
      <section className="panel doc-panel">
        <div className="eyebrow">A TWO-MINUTE WALKTHROUGH</div>
        <h2>Show the evidence. Explain the decisions.</h2>
        <p>
          Start with Operations: real scheduled observations, missing-data coverage, incident
          history, and authenticated policy changes. Explain lease fencing and why acknowledgement
          is separate from recovery. Then use the lab to reproduce a failure safely.
        </p>
        <ol className="walkthrough">
          <li>
            <b>Start with the problem.</b>
            <p>
              “Retries can turn a partial outage into an overload. I built a lab to make admission
              control and recovery visible.”
            </p>
          </li>
          <li>
            <b>Run a burst.</b>
            <p>
              Send 24 concurrent requests and show the shared token budget. Explain HTTP 429 and why
              rejected traffic gets Retry-After.
            </p>
          </li>
          <li>
            <b>Break the origin.</b>
            <p>
              Warm the cache, inject failures, and show the circuit opening after three failures.
              Cached responses preserve availability for up to 60 seconds.
            </p>
          </li>
          <li>
            <b>Recover deliberately.</b>
            <p>
              Restore health, wait for cooldown, and send a probe. Explain why only one recovery
              request may reach the origin.
            </p>
          </li>
          <li>
            <b>Make the tradeoff explicit.</b>
            <p>
              Strong consistency costs a coordinator hop. Cached data may be stale. This lab
              measures a synthetic origin, not production capacity.
            </p>
          </li>
        </ol>
        <hr />
        <div className="eyebrow">RESUME STARTER</div>
        <blockquote>
          Built an interactive API resilience lab using Cloudflare Workers, SQLite-backed Durable
          Objects, and TypeScript; implemented coordinated token-bucket rate limiting, circuit
          breaking with single-probe recovery, and bounded-age cached fallback.
        </blockquote>
        <p>
          Use this once you can explain and reproduce the behavior. Add measured numbers only after
          running and saving your own experiments.
        </p>
        <hr />
        <h2>Make the next improvement yours.</h2>
        <p>
          Compare protected and unprotected traffic using the same workload; add a rolling-window
          error-rate breaker; or implement signed session issuance to control public demo usage.
          Document the result and one thing your original design got wrong.
        </p>
      </section>
      <aside className="doc-side">
        <div className="panel doc-panel">
          <Code2 size={24} />
          <h3>Be ready for these questions</h3>
          <ul>
            <li>Why not use KV for the bucket?</li>
            <li>What happens when two recovery probes arrive at once?</li>
            <li>Can an old response close a newly opened circuit?</li>
            <li>What survives an object eviction?</li>
            <li>When is a stale response unacceptable?</li>
            <li>Where are the bottlenecks and trust boundaries?</li>
          </ul>
        </div>
        <div className="insight-card">
          <span className="insight-label">
            <Check size={15} /> WHAT COUNTS
          </span>
          <p>
            A working demo, reproducible tests, and a clear explanation of tradeoffs. No project
            guarantees an interview—but these give an interviewer something concrete to evaluate.
          </p>
        </div>
      </aside>
    </div>
  );
}
