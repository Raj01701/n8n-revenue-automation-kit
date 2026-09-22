# n8n Revenue Automation Kit

Four importable n8n workflows and the self-hosting setup around them, for the
stack an online education business ends up with when it outgrows Zapier:
payments in, Thinkific access out, Slack for anything a human needs to see, and
a dunning sequence for cards that fail.

**What this is, honestly:** reference workflows I built for exactly this
Zapier → self-hosted n8n migration shape. They are not an export from a private
client account — I do not publish other people's instances. They import cleanly,
they encode the decisions that matter (idempotency, retries, error routing,
reconciliation), and they are meant to be adapted to your provider, your course
ids and your channels rather than dropped in untouched.

Verified against n8n 2.40.5 (current stable). Every SQL statement the workflows
run has been executed against Postgres 16; the structural checks in
`test/validate.mjs` pass.

```
workflows/   four workflow JSON files, n8n export format
infra/       docker-compose, Caddy, .env.example, backup + restore
sql/         schema for the idempotency ledger and the audit tables
test/        structural validator - node --test test/validate.mjs
```

---

## Why a webhook firing twice cannot double-enrol

This is the screening question, so here is the actual answer, walked through the
actual nodes in `01-payment-to-enrolment.json`.

**Why check-then-create is not enough.** The obvious guard is: look the event up,
and if you have not seen it, process it. In one n8n worker, at low volume, that
appears to work. It is a race, and the race is lost at exactly the moment you
care about — a burst of traffic, a launch, a provider retrying because your
endpoint was slow.

```
worker A                      worker B
--------                      --------
SELECT ... WHERE event='evt_1'
  -> 0 rows                   SELECT ... WHERE event='evt_1'
                                -> 0 rows          <- B ran before A wrote
enrol the student
INSERT ledger row             enrol the student    <- second enrolment
                              INSERT ledger row
```

Both workers observe "not processed" because neither has written yet. Widening
the SELECT, adding a Redis flag, or checking "is this student already enrolled"
in Thinkific first all have the same shape: a gap between deciding and acting,
into which a second delivery fits. The gap is milliseconds. Payment providers
retry in milliseconds.

**What actually closes it.** In `sql/schema.sql`:

```sql
CONSTRAINT processed_events_provider_event_uniq UNIQUE (provider, provider_event_id)
```

and in the **Idempotency Guard** node, the third node of the workflow:

```sql
INSERT INTO processed_events (provider, provider_event_id, event_type, payload)
VALUES ($1, $2, $3, $4::jsonb)
ON CONFLICT (provider, provider_event_id) DO NOTHING
RETURNING id, received_at;
```

The check and the write are now one statement, adjudicated by Postgres under a
row lock. Two concurrent deliveries both run it; exactly one creates the row and
gets an `id` back. The other gets **zero rows**. There is no interval between
deciding and acting for the second delivery to slip into — that is the whole
difference, and it is not something application logic can reproduce.

**How the workflow reads that.** The Postgres node has `alwaysOutputData: true`,
so a zero-row result still emits one (empty) item rather than ending the branch
silently. The next node, **First Delivery Of This Event?**, is an IF on whether
`$json.id` exists:

- `id` present → first delivery → continue to Thinkific.
- `id` absent → someone else has this event → **Duplicate Event - Exit Cleanly**,
  a No-Op. The execution finishes green. A duplicate is not an error and should
  not page anyone.

**The rest of the path is idempotent too**, because the ledger only proves the
*event* is new — it does not prove the downstream calls have not partly run.

- **Find Student By Email** → **Student Already Exists?** → **Create Student**.
  Creation only happens on the branch where the lookup found nothing.
- **Enrol In Course** runs with `neverError` and `fullResponse`, so Thinkific's
  `422` for a repeat enrolment comes back as data instead of throwing.
  **Interpret Enrolment Response** treats `2xx` as `created` and a 422 matching
  `already enrolled` as `already_enrolled` — both successes, because both leave
  the student with access, which was the goal. Anything else throws.
  (`neverError` only suppresses HTTP *status* errors. Timeouts, DNS failures and
  socket resets still throw, so `retryOnFail` on that node is still doing work.)
- **Record Enrolment** writes the enrolment and closes out the ledger row in one
  statement, via a CTE, so a crash between the two cannot leave an event marked
  processed with no enrolment behind it. The enrolment row is itself upserted on
  a unique `provider_event_id`.

**And if it fails anyway.** A failed enrolment leaves `processed_events.status`
at `received`. Workflow 04 reports that as *paid but not enrolled* the same
night. The guarantee is not "nothing ever fails" — it is that nothing fails
silently and nothing is done twice.

---

## Importing the workflows

In n8n: **Workflows → ⋯ → Import from File**, one file at a time. Import `03`
first — the other three reference it as their error workflow.

After importing `03`, copy its workflow id from the URL
(`/workflow/<id>`) and set it in the other three: **⋯ → Settings → Error
Workflow**. They ship with the placeholder `REPLACE_WITH_ERROR_WORKFLOW_ID`,
which n8n will not resolve to anything until you do.

Then create the credentials below and re-select them on each node. Credential
ids are deliberately `null` in these files — an id from my instance would be
meaningless in yours.

### Credentials

| Credential name in the files | Type | Used by |
|---|---|---|
| `Postgres - n8n operations DB` | Postgres | 01, 02, 03, 04 |
| `Slack - Revenue Bot` | Slack API (bot token, `chat:write`) | all four |
| `Thinkific API - header auth` | Header Auth | 01, 02, 04 |
| `Payment provider API - header auth` | Header Auth | 02, 04 |
| `Transactional email API - header auth` | Header Auth | 02 |

The Postgres credential points at `REVENUE_OPS_DB` (the tables in
`sql/schema.sql`), **not** at n8n's own database.

### Environment variables the workflow expressions read

Every external URL in these files is `{{ $env.SOMETHING }}` rather than a
literal, so the same JSON imports into staging and production unedited. The
validator enforces that — it fails on any hard-coded `http(s)://`.

`PAYMENT_PROVIDER_NAME`, `PAYMENT_API_BASE`, `PAYMENT_WEBHOOK_SECRET`,
`THINKIFIC_API_BASE`, `THINKIFIC_TEMP_PASSWORD`, `DEFAULT_COURSE_ID`,
`EMAIL_API_BASE`, `BILLING_PORTAL_URL`, `SLACK_ENROLMENTS_CHANNEL`,
`SLACK_ALERTS_CHANNEL`, `RECONCILIATION_TIMEZONE`.

All of them are described in `infra/.env.example` and wired through in
`infra/docker-compose.yml`.

Two container settings are **required**, not optional, and are already in the
compose file:

- `NODE_FUNCTION_ALLOW_BUILTIN=crypto` — the signature-verification Code nodes
  `require('crypto')`. Without it they throw on the first line.
- `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` — newer n8n blocks `$env` inside Code
  nodes by default, which would make `$env.PAYMENT_WEBHOOK_SECRET` undefined.

### The workflows

**`01-payment-to-enrolment.json`** — webhook (raw body) → HMAC signature
verification with a 5-minute replay window → idempotency guard → find or create
the Thinkific user → enrol, treating "already enrolled" as success → write the
enrolment and close the ledger row in one statement → Slack confirmation. Every
external call retries three times and routes its error output to a Slack alert
that names the student and the event id.

**`02-failed-payment-recovery.json`** — `payment.failed` webhook → same
verification and same idempotency guard → dunning email at 0h → Wait 24h →
**re-check the invoice** → email at 24h → Wait 48h → **re-check again** → final
notice at 72h → revoke course access → Slack summary. The re-check before each
send is the point: a customer who has already paid drops out of the sequence at
the next checkpoint and is never chased, and never loses access. A *failed*
check routes to the error output and stops — an API error must never be read as
"still unpaid".

The Wait nodes exceed 65 seconds, so n8n takes the execution out of memory and
resumes it from the database later. That requires execution data to be saved
(it is, in the compose file) and it survives a restart — but it does mean a
dunning sequence is a three-day-long execution, which is worth knowing before
you prune aggressively.

**`03-error-trigger-alerts.json`** — Error Trigger → format workflow name,
failing node, error message, execution mode, whether it was a retry, the
execution URL and the item that was in flight → post to Slack and append to
`failures` in Postgres, in parallel. Slack is for the person on shift; the table
is for the Monday review, where you can actually ask which node breaks most
often. This workflow deliberately has **no** error workflow of its own — pointing
it at itself would loop on its own failures.

**`04-nightly-reconciliation.json`** — schedule at 02:15 in the business's
timezone → compute yesterday's window in that timezone (not UTC) → pull
yesterday's successful payments → pull Thinkific enrolments → compare both
directions → upsert one row per business date into `reconciliation_runs` → Slack
only if something does not match. Paid-but-not-enrolled is the expensive case;
enrolled-without-payment is the one that quietly costs you revenue. This is the
net under the webhooks, and it is the reason a failed enrolment is embarrassing
for a night rather than discovered in a refund request.

---

## Self-hosting

`infra/docker-compose.yml` runs n8n + Postgres + Caddy. Postgres is on an
internal-only Docker network; n8n is not published on a host port at all and is
reachable only through Caddy over HTTPS.

```bash
cd infra
cp .env.example .env          # fill in every value
cp Caddyfile.example Caddyfile
docker compose up -d
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$REVENUE_OPS_DB" < ../sql/schema.sql
```

**Postgres, not SQLite.** SQLite is the default and it is fine until it isn't:
one writer at a time, and the failure mode under concurrent webhook load is a
locked database, not a slow one. Queue mode requires Postgres anyway. Moving
later means a migration you will do under pressure; do it on day one instead.

**Queue mode when volume needs it, not before.** Commented into the compose file
(Redis + an `n8n-worker` service + `EXECUTIONS_MODE=queue`). The signal to turn
it on is webhook responses queueing behind long executions, or Wait-node
executions blocking throughput. A worker needs the *same* `N8N_ENCRYPTION_KEY`
and the same database as the main instance, or it cannot decrypt the credentials
it is handed.

**Pinned versions.** `n8n:2.40.5`, `postgres:16.4-alpine`, `caddy:2.8-alpine`.
`latest` means an unattended restart can change node behaviour at 3am. Upgrade
deliberately, on staging first, after reading the release notes for node version
bumps.

**Staging.** The same compose file on a second host with its own `.env`, its own
encryption key, and sandbox API keys. Because every endpoint is `{{ $env.X }}`,
promoting a workflow is an import — no node parameters to edit and forget.

**Pruning.** `EXECUTIONS_DATA_PRUNE=true` with a 14-day age limit and a 50,000
execution ceiling. Without it the execution tables grow without bound and what
takes the business down is the disk, not the workflow.

**Backups, with a restore you have actually run.** `infra/backup.sh` writes a
dated archive containing `pg_dump -Fc` of both databases, a tar of the n8n data
volume, a copy of `.env` (because `N8N_ENCRYPTION_KEY` is what makes the
credentials in the dump readable again), and a MANIFEST with checksums. It fails
loudly on a zero-byte dump and prunes archives older than
`BACKUP_RETENTION_DAYS`.

```
15 3 * * * /opt/n8n/infra/backup.sh >> /var/log/n8n-backup.log 2>&1
```

`infra/restore.sh <archive> [--yes]` unpacks it, warns you if the encryption key
in the backup differs from the one in your current `.env`, drops and recreates
both databases, restores the volume, and prints the four checks that tell you
the restore actually worked. Run it on a scratch host monthly. The two things
that go wrong are always the same: a missing encryption key, so every credential
comes back as unreadable ciphertext, and a dump that has been zero bytes for six
weeks.

---

## What I would change on day one in your stack

1. **Set the error workflow globally**, not per workflow. n8n has a default error
   workflow setting for the instance; per-workflow settings are one checkbox
   away from being forgotten on the next workflow someone builds.
2. **Retries on every external call.** Zapier gives you nothing here. Three
   tries with a few seconds between them removes most of the noise that
   currently looks like "the integration is flaky".
3. **A reconciliation job from the start.** Webhooks are best-effort. Until
   something compares the payment ledger to the access system nightly, the first
   report of a missed enrolment is a refund request.
4. **Alert on silence, not only on errors.** A workflow that stopped being
   triggered raises nothing. Alert when the nightly reconciliation has not
   written a row for yesterday, and when `processed_events` has rows sitting at
   `received` for more than fifteen minutes — those are the failures that do not
   announce themselves.
5. **Move the Zapier Zaps over one revenue path at a time**, running both in
   parallel with the n8n side writing to Postgres but not yet acting, until the
   ledgers agree for a week.

---

## Validating before you import

```bash
node --test test/validate.mjs
```

Checks every file for: valid JSON; the fields n8n requires on each node; unique
node names and ids; every connection target existing; exactly one trigger and no
unreachable nodes; `retryOnFail`, `maxTries`, `waitBetweenTries` and a wired
error output on every HTTP Request; `executionOrder: v1` and an error workflow
(except on `03`); credential ids left null; no secret-shaped strings; no
hard-coded URLs; unique webhook paths across the kit; and that the idempotency
guard is still an `ON CONFLICT DO NOTHING ... RETURNING` insert rather than a
SELECT someone quietly replaced it with.

---

Built by **Lekhraj Saini**.

- n8n Flow Doctor — <https://n8n-flow-doctor.vercel.app>
- GHL Lead Intake & Routing — <https://ghl-lead-intake-routing.vercel.app>
