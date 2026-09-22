/**
 * Drives the five executions the screenshots in docs/screenshots record.
 *
 * Nothing in here simulates a workflow. Every step posts a real, correctly
 * signed webhook to the running n8n instance, or asks n8n to run a workflow,
 * and then reads back what n8n and Postgres did about it. The assertions are
 * the point: each scenario fails loudly if the behaviour being claimed is not
 * the behaviour that happened.
 *
 *   node scripts/run-scenarios.mjs             # all scenarios
 *   node scripts/run-scenarios.mjs duplicate   # one, by name
 */
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { login, api } from './n8n-client.mjs';
import { DUNNING_DEMO_NAME } from './demo-constants.mjs';

const run = promisify(execFile);

const N8N = process.env.N8N_BASE || 'http://127.0.0.1:5678';
const MOCK = process.env.MOCK_BASE || 'http://127.0.0.1:4100';
const SECRET = process.env.PAYMENT_WEBHOOK_SECRET || 'local-demo-webhook-signing-secret';
const OWNER = {
  email: process.env.N8N_OWNER_EMAIL || 'demo@localhost.test',
  password: process.env.N8N_OWNER_PASSWORD || 'DemoRun-2026!x',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- helpers */

/** Sign exactly the bytes we send, the way the Code node recomputes them. */
function postSigned(path, event) {
  const raw = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
  return fetch(`${N8N}/webhook/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-provider-signature': `t=${t},v1=${v1}` },
    body: raw,
  });
}

const mock = {
  reset: () => fetch(`${MOCK}/__control/reset`, { method: 'POST' }),
  seed: (body) => fetch(`${MOCK}/__control/seed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  inject: (body) => fetch(`${MOCK}/__control/inject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  invoice: (body) => fetch(`${MOCK}/__control/invoice`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  state: () => fetch(`${MOCK}/__control/state`).then((r) => r.json()),
};

/**
 * Runs a query through psql in the Postgres container, so the script needs no
 * database driver and the proof queries are the same ones a person would type.
 */
async function sql(text, params = []) {
  let statement = text;
  params.forEach((p, i) => {
    statement = statement.replaceAll(`$${i + 1}`, `'${String(p).replace(/'/g, "''")}'`);
  });
  const { stdout } = await run('docker', [
    'exec', '-e', 'PGPASSWORD=local-demo-password', 'n8n-revenue-postgres-1',
    'psql', '-U', 'n8n', '-d', 'revenue_ops', '-t', '-A', '-F', '|', '-c', statement,
  ]);
  return stdout.trim().split('\n').filter(Boolean).map((line) => line.split('|'));
}

/** Wait until n8n has finished the newest execution of a workflow. */
async function waitForExecution(workflowId, { after = 0, timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await api(`/executions?filter=${encodeURIComponent(JSON.stringify({ workflowId }))}`);
    const items = list.results ?? list.data ?? list;
    const candidate = (items || []).filter((e) => Number(e.id) > after).sort((a, b) => Number(b.id) - Number(a.id))[0];
    if (candidate && candidate.status !== 'running' && candidate.status !== 'waiting' && candidate.status !== 'new') {
      return candidate;
    }
    await sleep(1500);
  }
  throw new Error(`no finished execution for workflow ${workflowId} within ${timeoutMs}ms`);
}

async function latestExecutionId(workflowId) {
  const list = await api(`/executions?filter=${encodeURIComponent(JSON.stringify({ workflowId }))}`);
  const items = list.results ?? list.data ?? list;
  return (items || []).reduce((max, e) => Math.max(max, Number(e.id)), 0);
}

async function workflows() {
  const list = await api('/workflows');
  const items = list.data ?? list;
  return Object.fromEntries(items.map((w) => [w.name, w]));
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`    ok: ${message}`);
}

/* -------------------------------------------------------------- scenarios */

const PAID_EVENT = {
  id: 'evt_2026_09_22_0001',
  type: 'invoice.paid',
  data: {
    object: {
      id: 'in_9f21c4',
      customer: 'cus_8812',
      customer_email: 'priya.raman@example.com',
      customer_name: 'Priya Raman',
      amount_paid: 149900,
      currency: 'aud',
      metadata: { course_id: 'course-2001' },
    },
  },
};

async function scenarioPayment(wfs) {
  console.log('\n[1] clean payment -> enrolment');
  await mock.reset();
  await sql('TRUNCATE processed_events, enrolments, failures, reconciliation_runs;');

  const wf = wfs['01 - Payment to Thinkific Enrolment'];
  const before = await latestExecutionId(wf.id);
  const res = await postSigned('payments/provider-events', PAID_EVENT);
  console.log(`    webhook HTTP ${res.status}`);

  const execution = await waitForExecution(wf.id, { after: before });
  console.log(`    execution ${execution.id}: ${execution.status}`);
  assert(execution.status === 'success', 'workflow 01 finished successfully');

  const state = await mock.state();
  assert(state.users.length === 1, 'Thinkific mock created exactly one student');
  assert(state.enrolments.length === 1, 'Thinkific mock recorded exactly one enrolment');
  assert(state.slack.length === 1, 'exactly one Slack message was posted');

  const rows = await sql("SELECT state, email, course_id FROM enrolments;");
  assert(rows.length === 1, 'one row in enrolments');
  assert(rows[0][0] === 'created', `enrolment state is "created" (got "${rows[0][0]}")`);

  const ledger = await sql("SELECT status FROM processed_events;");
  assert(ledger.length === 1 && ledger[0][0] === 'completed', 'the ledger row is closed out as completed');

  return { executionId: execution.id, workflowId: wf.id };
}

async function scenarioDuplicate(wfs) {
  console.log('\n[2] the same webhook delivered a second time');
  const wf = wfs['01 - Payment to Thinkific Enrolment'];

  const stateBefore = await mock.state();
  const before = await latestExecutionId(wf.id);

  // Byte-identical payload, same provider event id. Only the signature
  // timestamp differs, because the provider re-signs each delivery attempt.
  const res = await postSigned('payments/provider-events', PAID_EVENT);
  console.log(`    webhook HTTP ${res.status}`);

  const execution = await waitForExecution(wf.id, { after: before });
  console.log(`    execution ${execution.id}: ${execution.status}`);
  assert(execution.status === 'success', 'the duplicate finishes green - a replay is not an error');

  const stateAfter = await mock.state();
  assert(
    stateAfter.enrolments.length === stateBefore.enrolments.length,
    'no second enrolment call reached Thinkific',
  );
  assert(
    !stateAfter.calls.slice(stateBefore.calls.length).some((c) => c.kind.startsWith('thinkific')),
    'no Thinkific call of any kind was made on the replay',
  );
  assert(
    stateAfter.slack.length === stateBefore.slack.length,
    'no second Slack confirmation was posted',
  );

  const rows = await sql("SELECT count(*) FROM enrolments WHERE provider_event_id = $1;", [PAID_EVENT.id]);
  assert(rows[0][0] === '1', `exactly one enrolment row exists for ${PAID_EVENT.id} (count = ${rows[0][0]})`);

  const ledger = await sql("SELECT count(*) FROM processed_events WHERE provider_event_id = $1;", [PAID_EVENT.id]);
  assert(ledger[0][0] === '1', `exactly one ledger row exists for ${PAID_EVENT.id} (count = ${ledger[0][0]})`);

  return { executionId: execution.id, workflowId: wf.id };
}

async function scenarioDunning(wfs) {
  console.log('\n[3] dunning, with the invoice paid mid-sequence');
  await mock.reset();
  // A fresh ledger, or the idempotency guard correctly refuses to start the
  // sequence a second time for the same provider event id.
  await sql('TRUNCATE processed_events;');

  const INVOICE = 'in_dunning_7731';
  await mock.seed({ invoices: [{ id: INVOICE, status: 'open', amount_due: 149900, currency: 'aud' }] });

  const wf = wfs[DUNNING_DEMO_NAME];
  if (!wf) throw new Error(`"${DUNNING_DEMO_NAME}" does not exist - run scripts/make-dunning-demo.mjs`);
  const before = await latestExecutionId(wf.id);

  const failedEvent = {
    id: 'evt_2026_09_22_0002',
    type: 'invoice.payment_failed',
    data: {
      object: {
        id: INVOICE,
        invoice: INVOICE,
        customer: 'cus_4410',
        customer_email: 'daniel.okoro@example.com',
        customer_name: 'Daniel Okoro',
        amount_due: 149900,
        currency: 'aud',
        metadata: { course_id: 'course-2001' },
      },
    },
  };

  const res = await postSigned('payments/failed-demo', failedEvent);
  console.log(`    webhook HTTP ${res.status}`);

  // The customer fixes their card while the sequence is between sends.
  await sleep(4000);
  await mock.invoice({ id: INVOICE, status: 'paid', amount_due: 0, currency: 'aud' });
  console.log(`    invoice ${INVOICE} marked paid while the sequence was waiting`);

  const execution = await waitForExecution(wf.id, { after: before, timeoutMs: 180_000 });
  console.log(`    execution ${execution.id}: ${execution.status}`);
  assert(execution.status === 'success', 'the dunning execution finished successfully');

  const state = await mock.state();
  const stages = state.emails.map((e) => e.stage);
  console.log(`    emails sent: ${JSON.stringify(stages)}`);
  assert(stages.length === 1 && stages[0] === 'hour-0', 'only the hour-0 email was sent');
  assert(!stages.includes('hour-24') && !stages.includes('hour-72'), 'the 24h and 72h sends were skipped');
  assert(
    !state.calls.some((c) => c.kind === 'thinkific.enrolments.update'),
    'course access was never revoked',
  );
  assert(
    state.slack.some((m) => /recovered/i.test(m.text)),
    'Slack was told the payment was recovered',
  );

  return { executionId: execution.id, workflowId: wf.id };
}

async function scenarioThinkificOutage(wfs) {
  console.log('\n[4] Thinkific returns 500 -> retries -> Error Trigger fires');
  await mock.reset();
  await sql('TRUNCATE processed_events, enrolments, failures;');

  const wf = wfs['01 - Payment to Thinkific Enrolment'];
  const errorWf = wfs['03 - Error Trigger Alerts'];
  const before = await latestExecutionId(wf.id);
  const beforeError = await latestExecutionId(errorWf.id);

  // A provider-side outage wide enough to cover the whole alerting path:
  // Thinkific is down, and so is Slack, so the workflow's own error branch
  // cannot report it either. That is what makes workflow 01 actually fail,
  // which is the only thing an Error Trigger reacts to.
  // 9 = three attempts x three nodes; 3 = exactly the Slack node's retry budget,
  // so Slack is back up by the time workflow 03 posts its alert.
  await mock.inject({ target: 'thinkific_users', status: 500, times: 9 });
  await mock.inject({ target: 'slack', status: 503, times: 3 });

  const outageEvent = { ...PAID_EVENT, id: 'evt_2026_09_22_0003' };
  const res = await postSigned('payments/provider-events', outageEvent);
  console.log(`    webhook HTTP ${res.status}`);

  const execution = await waitForExecution(wf.id, { after: before, timeoutMs: 180_000 });
  console.log(`    execution ${execution.id}: ${execution.status}`);
  assert(execution.status === 'error', 'workflow 01 failed rather than reporting success');

  const state = await mock.state();
  const lookups = state.calls.filter((c) => c.kind === 'thinkific.users.search').length;
  console.log(`    Thinkific user lookups attempted: ${lookups}`);
  assert(lookups === 3, 'the Thinkific call was retried up to maxTries (3 attempts, not 1)');

  const errorExecution = await waitForExecution(errorWf.id, { after: beforeError, timeoutMs: 120_000 });
  console.log(`    error workflow execution ${errorExecution.id}: ${errorExecution.status}`);
  assert(errorExecution.status === 'success', 'workflow 03 ran off the Error Trigger');

  const failures = await sql("SELECT workflow_name, failed_node, error_message FROM failures ORDER BY id DESC LIMIT 1;");
  assert(failures.length === 1, 'workflow 03 wrote a row into failures');
  console.log(`    failures row: ${failures[0].join(' | ').slice(0, 160)}`);

  const ledger = await sql("SELECT status FROM processed_events WHERE provider_event_id = $1;", [outageEvent.id]);
  assert(
    ledger.length === 1 && ledger[0][0] === 'received',
    "the ledger row stays at 'received' - money in, access not granted, and workflow 04 will re-report it",
  );

  return { executionId: execution.id, workflowId: wf.id, errorExecutionId: errorExecution.id, errorWorkflowId: errorWf.id };
}

async function scenarioReconciliation(wfs) {
  console.log('\n[5] nightly reconciliation finds a one-sided payment');
  await mock.reset();
  await sql('TRUNCATE reconciliation_runs;');

  // "Yesterday" in the business timezone, which is what the workflow computes.
  const zone = 'Australia/Sydney';
  const nowSydney = new Date(new Date().toLocaleString('en-US', { timeZone: zone }));
  const yesterdayNoon = new Date(nowSydney);
  yesterdayNoon.setDate(yesterdayNoon.getDate() - 1);
  yesterdayNoon.setHours(12, 0, 0, 0);
  const offsetMs = nowSydney.getTime() - Date.now();
  const createdUnix = Math.floor((yesterdayNoon.getTime() - offsetMs) / 1000);
  const createdIso = new Date((yesterdayNoon.getTime() - offsetMs)).toISOString();

  await mock.seed({
    charges: [
      { id: 'ch_reconciled_01', status: 'succeeded', paid: true, created: createdUnix, amount: 149900, currency: 'aud', billing_details: { email: 'priya.raman@example.com' } },
      // The one-sided payment: money taken, nothing in the course platform.
      { id: 'ch_orphan_02', status: 'succeeded', paid: true, created: createdUnix + 120, amount: 149900, currency: 'aud', billing_details: { email: 'lost.student@example.com' } },
    ],
    users: [{ id: 900_001, email: 'priya.raman@example.com', first_name: 'Priya', last_name: 'Raman' }],
    enrolments: [{ id: 700_001, user_id: 900_001, user_email: 'priya.raman@example.com', course_id: 'course-2001', created_at: createdIso, expired_at: null }],
  });

  const wf = wfs['04 - Nightly Payment / Enrolment Reconciliation'];
  const before = await latestExecutionId(wf.id);

  // Run the schedule now instead of waiting for 02:15. This is the same call
  // the editor's "Execute workflow" button makes, starting from the trigger.
  const workflowData = await api(`/workflows/${wf.id}`);
  await api(`/workflows/${wf.id}/run`, {
    method: 'POST',
    body: JSON.stringify({
      workflowData,
      startNodes: [],
      triggerToStartFrom: { name: 'Nightly At 02:15' },
    }),
  });

  const execution = await waitForExecution(wf.id, { after: before, timeoutMs: 120_000 });
  console.log(`    execution ${execution.id}: ${execution.status}`);
  assert(execution.status === 'success', 'workflow 04 finished successfully');

  const rows = await sql('SELECT business_date, payments_checked, enrolments_checked, missing_enrolment_count, orphan_enrolment_count FROM reconciliation_runs;');
  assert(rows.length === 1, 'exactly one reconciliation_runs row for the business date');
  const [businessDate, payments, enrolments, missing, orphan] = rows[0];
  console.log(`    ${businessDate}: payments=${payments} enrolments=${enrolments} missing=${missing} orphan=${orphan}`);
  assert(payments === '2', 'both of yesterday\'s payments were read');
  assert(missing === '1', 'the one-sided payment was reported as paid-but-not-enrolled');
  assert(orphan === '0', 'nothing was misreported as enrolled-without-payment');

  const details = await sql("SELECT details->'missing_enrolments'->0->>'email' FROM reconciliation_runs;");
  assert(details[0][0] === 'lost.student@example.com', 'the reported email is the seeded one-sided payment');

  const state = await mock.state();
  assert(state.slack.some((m) => /reconciliation/i.test(m.text)), 'Slack was told about the discrepancy');

  return { executionId: execution.id, workflowId: wf.id };
}

/* ------------------------------------------------------------------- main */

const SCENARIOS = {
  payment: scenarioPayment,
  duplicate: scenarioDuplicate,
  dunning: scenarioDunning,
  outage: scenarioThinkificOutage,
  reconciliation: scenarioReconciliation,
};

async function main() {
  await login(OWNER);
  const wfs = await workflows();

  const requested = process.argv.slice(2);
  const names = requested.length ? requested : Object.keys(SCENARIOS);

  const results = {};
  for (const name of names) {
    const fn = SCENARIOS[name];
    if (!fn) throw new Error(`unknown scenario "${name}". Known: ${Object.keys(SCENARIOS).join(', ')}`);
    results[name] = await fn(wfs);
  }

  console.log('\nexecutions recorded:');
  console.log(JSON.stringify(results, null, 2));
  writeFileSync(new URL('./.last-run.json', import.meta.url), JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error('\n' + err.message);
  process.exit(1);
});
