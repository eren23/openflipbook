# Full operator backup and restore

`apps/web/scripts/operator-backup.ts` preserves every application collection
and every object in the configured private bucket. That includes ownership and
recovery secrets, private notes, job/provider receipts, spend ledgers, scene
history, accepted media, `world_publications`, `publication_libraries` and
`publication_forks`. Metadata uses BSON Extended JSON so dates, ObjectIds,
binary values and 64-bit ledger numbers survive. Collection options and indexes
are retained; database views are rejected explicitly.

This is separate from creator world ZIP export/import. Those archives share
content and immutable finalized path/walk evidence, omit operator/private
account records, and never resume imported jobs. Operator restore preserves
original IDs and job states, so services must remain stopped until the operator
has reconciled queued/submitted jobs against provider receipts. It does not
submit any provider calls or start a worker.

## Capture a backup

Stop incoming traffic and stop web/worker/backend writers with enough grace
for accepted operations to drain. The compose worker allows 360 seconds.
Confirm there are no outstanding local processes, scripts or provider callbacks
writing metadata or objects. `--quiesced` is the operator's explicit declaration
of this condition; the CLI cannot establish an external provider has drained.
Keep Mongo and the store running. Mongo TTL expiry may continue to remove
expired presence records while the application is stopped.

Use an operator-only environment file with the intended Mongo/S3 connection
settings. The URI must address this host (for local Compose,
`mongodb://127.0.0.1:27017/?directConnection=true`), not a container-only hostname.
Do not print its secrets or commit it. From the repository root:

```sh
pnpm --filter @openflipbook/web exec node --env-file=/secure/operator.env \
  --import tsx scripts/operator-backup.ts backup \
  --directory /secure/backups/first-release-001 --quiesced
```

The directory must be new. Files are private (0600), directories are 0700 and
`manifest.json` is written last. A failed capture has no complete manifest.
Each collection JSONL and object byte stream has a SHA-256 and byte count.
Objects retain their keys, content type, cache policy and custom metadata.
Encrypt the complete directory with your operator backup system and keep a
separate off-host copy. A bucket snapshot alone cannot recover owner access,
notes or the accounting ledger. Deployment environment secrets and external
provider accounts must be backed up separately.

The worker Docker target also includes this script. An operator can run a
one-shot worker container with an operator-owned backup bind mount while the
application services are stopped; do not start its normal worker command.

## Restore into fresh stores

Keep destination web, backend and workers stopped. Create an empty database
and an empty private bucket, then point the operator environment at those
destinations. Restore refuses to overwrite existing metadata or unrelated
objects. It validates every local SHA, length and BSON row before its first
destination mutation.

```sh
pnpm --filter @openflipbook/web exec node --env-file=/secure/restore.env \
  --import tsx scripts/operator-backup.ts restore \
  --directory /secure/backups/first-release-001 \
  --quiesced --empty-destination
```

A durable `operator_restore_receipts` marker binds retries to that manifest.
Interrupted object copies can be retried using the same command. Metadata
documents and the import marker commit together in a Mongo transaction;
indexes are installed afterward and can also be retried. A completed replay
does not import duplicate rows. A different backup cannot overwrite a partial
restore. Keep the backup directory unchanged until recovery completes.

Check owner reads, private notes, immutable media hashes, publication visibility
and ledger/job receipts before admitting traffic. Do not start workers until
queued/submitted jobs and uncertain provider submissions have been reconciled;
use the feature flags to keep new provider spend disabled during recovery.
Restore does not reassign ownership to the current browser. Use the existing
operator ownership recovery procedure for a verified creator who lost their
browser secret. TTL indexes retain their normal expiry behavior after restore.

## Verification

`lib/operator-backup.test.ts` checks BSON fidelity, notes/ownership/ledger and
publication inventory, exact blob bytes and metadata, corruption before any
write, nonempty destination rejection, retry after a partial object copy or
index failure, replay and unsafe file paths. `e2e/operator-backup.spec.ts` exercises
the actual Mongo transaction and S3 adapters, private notes/ownership/ledger and
publication records, restored indexes, exact object hashes, replay and anonymous
bucket denial. It uses separate fixture stores and never reads or replaces an
existing user database.
