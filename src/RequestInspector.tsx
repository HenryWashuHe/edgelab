import { useEffect, useRef } from 'react';
import { X, ArrowRight, Database, Server } from 'lucide-react';
import type { LabEvent } from '../worker/engine';
export function RequestInspector({
  event,
  onClose,
}: {
  event: LabEvent | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (event) ref.current?.showModal();
    else ref.current?.close();
  }, [event]);
  return (
    <dialog
      className="request-dialog"
      ref={ref}
      aria-labelledby="inspect-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {event && (
        <>
          <div className="dialog-heading">
            <div>
              <div className="eyebrow">FOLLOW ONE REQUEST</div>
              <h2 id="inspect-title">Request #{event.id}</h2>
            </div>
            <button className="icon-button" onClick={onClose} aria-label="Close request details">
              <X size={20} />
            </button>
          </div>
          <div className="decision-banner">
            <span className={`status-code ${event.status === 200 ? 'status-ok' : 'status-error'}`}>
              {event.status}
            </span>
            <p>{event.message}</p>
          </div>
          <div className="inspect-path">
            <span>Edge guard</span>
            <ArrowRight size={16} />
            <span>
              {event.originAttempted === undefined ? (
                'Origin path not recorded in v1'
              ) : event.originAttempted ? (
                <>
                  <Server size={15} /> Origin Worker
                </>
              ) : (
                <>
                  <Database size={15} /> Origin bypassed
                </>
              )}
            </span>
          </div>
          <dl className="request-facts">
            <div>
              <dt>Request ID</dt>
              <dd className="mono">{event.requestId ?? 'Not recorded in v1'}</dd>
            </div>
            <div>
              <dt>Recorded at</dt>
              <dd>{new Date(event.at).toISOString()}</dd>
            </div>
            <div>
              <dt>Server elapsed</dt>
              <dd>{event.latencyMs} ms</dd>
            </div>
            <div>
              <dt>Circuit after request</dt>
              <dd>{event.circuit}</dd>
            </div>
            <div>
              <dt>Cached response age</dt>
              <dd>
                {event.cacheAgeMs === undefined
                  ? 'Not served from cache'
                  : `${(event.cacheAgeMs / 1000).toFixed(2)} seconds`}
              </dd>
            </div>
            <div>
              <dt>Retry-After</dt>
              <dd>
                {event.retryAfter === undefined ? 'Not required' : `${event.retryAfter} seconds`}
              </dd>
            </div>
          </dl>
          {event.payload && (
            <>
              <h3>Response payload</h3>
              <p className="inspector-help">
                A cached response keeps the same revision and generatedAt as the original. Server
                elapsed time does not include browser network latency.
              </p>
              <pre>{JSON.stringify(event.payload, null, 2)}</pre>
            </>
          )}
          <button className="button full" onClick={onClose}>
            Back to the lab
          </button>
        </>
      )}
    </dialog>
  );
}
