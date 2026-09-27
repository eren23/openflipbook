# Operator Ownership Recovery

OpenFlipbook normally recognizes a creator by the `ofb_owner` browser cookie.
Losing that cookie does not delete saved worlds, but it removes private access.
An installation operator with trusted database access can issue a short-lived
code for **one existing world**. The creator redeems it in My Worlds. No hosted
account, email service or paid generation is required.

This is an ownership transfer, not authentication of the person requesting it.
The operator must establish who is entitled to the world through their own
trusted process. Knowing a public world link or its title is not proof. Anyone
who obtains an unused code can redeem it. Deliver codes privately; never put
them in URLs, issue comments, screenshots, shared terminal logs or analytics.

## Operator Commands

Use the Docker configuration of the installation that owns the world. The
`place-worker` image includes the CLI and uses the same MongoDB configuration
as the application. Commands need a healthy transaction-capable replica set.
Running the CLI does not require a running queue worker; `run --rm --no-deps`
starts only the command container, and assumes MongoDB is already available.

Inspect the world without revealing the current browser token:

```sh
docker compose --profile world-build run --rm --no-deps place-worker \
  node --import tsx scripts/owner-recovery.ts inspect --world WORLD_ID
```

After verifying the intended creator, issue a code:

```sh
docker compose --profile world-build run --rm --no-deps place-worker \
  node --import tsx scripts/owner-recovery.ts issue --world WORLD_ID \
  --reason "Verified creator through a trusted channel" --minutes 15
```

The JSON response contains `grant_id`, `session_id`, `code` and `expires_at`.
Only this response contains the plaintext code. The database stores its hash,
expiry, operator reason and status, not the code or a copy of the old cookie.
Expiry defaults to 15 minutes; the supported range is 1 to 1,440 minutes.
There is no public HTTP endpoint for issuing codes. The CLI refuses to claim
a world that has no existing ownership record.

Issuing another code for the same world revokes its previous pending code.
It does not change access until someone successfully redeems the replacement.
Withdraw a pending code using its non-secret grant ID:

```sh
docker compose --profile world-build run --rm --no-deps place-worker \
  node --import tsx scripts/owner-recovery.ts revoke --grant GRANT_ID \
  --reason "Recovery request withdrawn"
```

Revocation is idempotent. It cannot undo a completed transfer. To correct a
completed transfer, verify the proper creator and issue another code.

For host development, run the same script from `apps/web`, explicitly loading
the intended environment (the CLI does not load `.env.local` implicitly):

```sh
node --env-file=.env.local --import tsx scripts/owner-recovery.ts \
  inspect --world WORLD_ID
```

## Creator Workflow

1. Open the intended installation in the browser that should own the world.
2. In My Worlds, select **Recover World** and enter the operator's code.
3. Select **Restore access**. The app first acknowledges the browser's owner
   cookie, then redeems the code. Existing worlds in that browser are retained.
4. Close the confirmation and open the restored world or its notebook. If the
   world was archived, it remains in **Archived**; recovery does not unarchive it.

Do not clear cookies during recovery. If the response is lost, retry in the
same browser with the same code. A used code acknowledges success only for
the recipient while they still own that world; it cannot transfer access again.
A different browser needs a newly issued code. Canceling the dialog clears its
input but does not revoke a code. The app does not put codes in browser storage
or URLs. Use HTTPS outside a trusted loopback-only development environment.

## Scope And Limits

- Transfer and grant consumption commit in one MongoDB transaction. Concurrent
  recipients cannot both acquire the world using one code.
- Only the chosen world's owner record changes. Both browsers retain their
  other worlds. Scene geometry, notes, assets and job records are not rewritten.
- Private notes follow ownership of that world. The previous browser loses
  subsequent owner-only access, including private notes and owner export. It
  may still view content that was explicitly published read-only.
- Previously downloaded data, open page contents and old exports cannot be
  remotely erased. Recovery does not revoke already issued storage links or
  change the installation's blob-storage policy.
- Requests already authorized and provider jobs already accepted may finish.
  Arrange a quiet handoff, review the queue, and handle cancellation through
  its existing controls. Recovery never submits or resubmits model work.
- The grant collection retains operator reasons and status/timestamps. This
  is operational metadata, not a tamper-proof audit log. Protect database and
  backup access; do not put sensitive identity evidence in the reason field.
- This does not recover deleted content, restore a lost database or migrate
  an installation. World ZIP import is still not a complete database/blob
  backup. Retain stores and backups independently of recovery codes.

## Verification

Focused unit tests cover hashing, expiry, supersession, revocation, transfer
scope, rollback and same-browser replay. Route tests bound incoming bytes and
check origin, JSON, cookie and private-response behavior. Browser checks in
`e2e/selfhost.spec.ts` exercise the CLI inside an isolated Docker installation
and the My Worlds dialog at desktop and narrow widths. Run them through
`node scripts/selfhost/check.mjs`; they never use the ordinary installation's
database, browser cookies or provider credentials.

See [LOCAL_DEV.md](LOCAL_DEV.md) for setup and [WORLD_BUILDING_PROGRESS.md](WORLD_BUILDING_PROGRESS.md)
for verified results and remaining release gates.
