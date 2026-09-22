-- ---------------------------------------------------------------------------
-- Operations schema for the n8n revenue automation stack.
--
-- This is a SEPARATE database from the one n8n uses for its own executions and
-- credentials. Keep them apart: you will want to drop and reload this one while
-- testing, and you never want to do that to n8n's internal tables.
--
--   createdb revenue_ops
--   psql -d revenue_ops -f sql/schema.sql
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- processed_events - the idempotency ledger
--
-- WHY THE UNIQUE CONSTRAINT IS THE WHOLE POINT
--
-- Payment providers guarantee at-least-once delivery. The same event id will be
-- delivered again if your endpoint is slow, returns 5xx, or the provider simply
-- decides to retry. Under load, two deliveries of the same event can be *in
-- flight at the same moment*, handled by two different n8n workers.
--
-- The obvious guard - "SELECT to see if we've handled this, then INSERT" - does
-- not work, because both workers can run the SELECT before either runs the
-- INSERT. Both see "not processed", both proceed, the student is enrolled twice
-- and, depending on the provider, billed twice. That window is small; at a few
-- thousand events a day it is not small enough.
--
-- A UNIQUE constraint closes the window because the check and the write are the
-- same operation, adjudicated by Postgres under a row lock. Exactly one of the
-- concurrent INSERTs creates the row. The other gets zero rows back from
-- ON CONFLICT DO NOTHING, which the workflow reads as "someone else already has
-- this" and exits cleanly. There is no interval between check and write for a
-- second worker to slip into.
--
-- (provider, provider_event_id) rather than provider_event_id alone, so that
-- adding a second payment processor later cannot collide with the first.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS processed_events (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider            text        NOT NULL,
    provider_event_id   text        NOT NULL,
    event_type          text        NOT NULL,
    status              text        NOT NULL DEFAULT 'received'
                                    CHECK (status IN ('received', 'completed', 'failed')),
    payload             jsonb       NOT NULL,
    received_at         timestamptz NOT NULL DEFAULT now(),
    completed_at        timestamptz,

    -- The line that prevents double enrolment.
    CONSTRAINT processed_events_provider_event_uniq UNIQUE (provider, provider_event_id)
);

-- Rows left at 'received' are events that were accepted but never finished:
-- the money arrived and the enrolment did not. Workflow 04 reads them nightly.
CREATE INDEX IF NOT EXISTS processed_events_open_idx
    ON processed_events (received_at)
    WHERE status = 'received';

-- ---------------------------------------------------------------------------
-- enrolments - what we actually granted, and to whom
--
-- provider_event_id is unique here too. Workflow 01 writes this row with
-- ON CONFLICT (provider_event_id) DO UPDATE, so a replayed or manually retried
-- execution corrects the existing row instead of creating a second enrolment
-- record for the same payment.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS enrolments (
    id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider_event_id       text        NOT NULL UNIQUE,
    email                   text        NOT NULL,
    course_id               text        NOT NULL,
    thinkific_user_id       bigint,
    thinkific_enrolment_id  bigint,
    state                   text        NOT NULL DEFAULT 'created'
                                        CHECK (state IN ('created', 'already_enrolled', 'revoked')),
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS enrolments_email_course_idx ON enrolments (lower(email), course_id);
CREATE INDEX IF NOT EXISTS enrolments_state_idx        ON enrolments (state);

-- ---------------------------------------------------------------------------
-- failures - every execution that died, written by workflow 03
--
-- Slack is for the person on shift; this table is for the Monday review. Slack
-- history is not a dataset - you cannot ask it "which node failed most often
-- last month", and it is where post-incident detail goes to be forgotten.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS failures (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workflow_id         text,
    workflow_name       text,
    execution_id        text,
    execution_url       text,
    failed_node         text,
    error_name          text,
    error_message       text,
    error_description   text,
    error_stack         text,
    execution_mode      text,
    retry_of            text,
    input_excerpt       text,
    occurred_at         timestamptz NOT NULL DEFAULT now(),
    reviewed_at         timestamptz
);

CREATE INDEX IF NOT EXISTS failures_unreviewed_idx
    ON failures (occurred_at DESC)
    WHERE reviewed_at IS NULL;

CREATE INDEX IF NOT EXISTS failures_workflow_idx ON failures (workflow_name, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- reconciliation_runs - the nightly proof that webhooks and reality agree
--
-- One row per business date, upserted, so re-running the job for a date
-- overwrites rather than duplicates. An absent row for yesterday is itself a
-- signal: the safety net did not run.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reconciliation_runs (
    id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    business_date            date        NOT NULL UNIQUE,
    timezone                 text        NOT NULL,
    payments_checked         integer     NOT NULL DEFAULT 0,
    enrolments_checked       integer     NOT NULL DEFAULT 0,
    missing_enrolment_count  integer     NOT NULL DEFAULT 0,
    orphan_enrolment_count   integer     NOT NULL DEFAULT 0,
    details                  jsonb       NOT NULL DEFAULT '{}'::jsonb,
    ran_at                   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reconciliation_runs_dirty_idx
    ON reconciliation_runs (business_date DESC)
    WHERE missing_enrolment_count > 0 OR orphan_enrolment_count > 0;

COMMIT;

-- ---------------------------------------------------------------------------
-- Useful checks once this is live.
-- ---------------------------------------------------------------------------

-- Events accepted but never completed in the last day - money in, access not granted.
--   SELECT provider_event_id, event_type, received_at
--     FROM processed_events
--    WHERE status = 'received'
--      AND received_at < now() - interval '15 minutes'
--    ORDER BY received_at;

-- Which node breaks most often.
--   SELECT workflow_name, failed_node, count(*)
--     FROM failures
--    WHERE occurred_at > now() - interval '7 days'
--    GROUP BY 1, 2
--    ORDER BY 3 DESC;

-- Nights where the books did not balance.
--   SELECT business_date, missing_enrolment_count, orphan_enrolment_count
--     FROM reconciliation_runs
--    WHERE missing_enrolment_count > 0 OR orphan_enrolment_count > 0
--    ORDER BY business_date DESC;
