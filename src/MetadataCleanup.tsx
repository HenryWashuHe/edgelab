import {
  readCleanupRecord,
  readPublicCleanupRecord,
  type CleanupBatch,
} from '../worker/metadata-cleanup';

type Props = {
  record: unknown;
  privateView?: boolean;
  unconfirmed?: boolean;
  unavailable: string;
};
const validDate = (at: number) => Number.isFinite(new Date(at).getTime());
const utc = (at: number) =>
  new Date(at)
    .toISOString()
    .replace('T', ' ')
    .replace(/(?:\.000)?Z$/, ' UTC');

/** Recorded cleanup evidence only; expanding this disclosure makes no request. */
export function MetadataCleanup({
  record: value,
  privateView = false,
  unconfirmed,
  unavailable,
}: Props) {
  const privateRecord = privateView ? readCleanupRecord(value) : null;
  const parsed = privateView ? privateRecord : readPublicCleanupRecord(value);
  const record =
    parsed &&
    validDate(parsed.at) &&
    validDate(parsed.slot * 60000) &&
    (!parsed.cleanup || validDate(parsed.cleanup.cutoff))
      ? parsed
      : null;
  const cleanup = record?.cleanup;
  return (
    <details className="ops-cleanup">
      <summary>{privateView ? 'Last metadata cleanup' : 'Last policy-version cleanup'}</summary>
      <div className="ops-cleanup-body">
        {record && (
          <p className="ops-cleanup-history">
            {unconfirmed
              ? 'Cached historical result. Current cleanup cannot be confirmed from this snapshot.'
              : 'Historical result from one recorded completed run.'}
          </p>
        )}
        {record && (
          <dl className="ops-cleanup-times">
            <div>
              <dt>Completed UTC</dt>
              <dd>
                <time dateTime={new Date(record.at).toISOString()}>{utc(record.at)}</time>
              </dd>
            </div>
            <div>
              <dt>Scheduled minute UTC</dt>
              <dd>
                <time dateTime={new Date(record.slot * 60000).toISOString()}>
                  {utc(record.slot * 60000)}
                </time>
              </dd>
            </div>
            {cleanup && (
              <div>
                <dt>Expiry cutoff UTC</dt>
                <dd>
                  <time dateTime={new Date(cleanup.cutoff).toISOString()}>
                    {utc(cleanup.cutoff)}
                  </time>
                </dd>
              </div>
            )}
          </dl>
        )}
        {cleanup ? (
          <>
            <div className="ops-cleanup-batches">
              <Batch title="Policy-version candidates" batch={cleanup.versions} />
              {privateRecord?.cleanup && (
                <Batch title="Orphan-note candidates" batch={privateRecord.cleanup.orphanNotes} />
              )}
            </div>
            <p className="ops-cleanup-key">
              Protected sources still have a reference. Missing sources were already absent; this
              count does not describe missing monitoring observations.
            </p>
          </>
        ) : (
          <p className="ops-cleanup-unavailable">
            {record
              ? 'No valid cleanup diagnostics were recorded for this completed run.'
              : unavailable}
          </p>
        )}
        <p className="ops-cleanup-limits">
          Candidate batches only. Age expiry, expired-parent deletion, and cold migration are
          excluded. Counts do not measure total cleanup cost or account quota.
        </p>
      </div>
    </details>
  );
}

function Batch({ title, batch }: { title: string; batch: CleanupBatch }) {
  return (
    <section className="ops-cleanup-batch">
      <h3>{title}</h3>
      <dl className="ops-cleanup-counts">
        <div>
          <dt>Examined</dt>
          <dd>
            {batch.examined} / {batch.limit}
          </dd>
        </div>
        <div>
          <dt>Deleted</dt>
          <dd>{batch.deleted}</dd>
        </div>
        <div>
          <dt>Protected</dt>
          <dd>{batch.protected}</dd>
        </div>
        <div>
          <dt>Missing source</dt>
          <dd>{batch.missing}</dd>
        </div>
      </dl>
      <p className={batch.mayRemain ? 'ops-cleanup-full' : undefined}>
        {batch.mayRemain
          ? 'Full batch examined; more work may remain.'
          : 'This batch did not reach its limit.'}
      </p>
    </section>
  );
}
