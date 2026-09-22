/**
 * Records docs/duplicate-webhook.mp4: the same payment webhook delivered twice,
 * watched live in the n8n executions view.
 *
 * The two deliveries are fired from this script while the browser is recording,
 * so what the video shows is n8n reacting to real HTTP requests - not a replay
 * of something captured earlier.
 *
 *   node scripts/record-duplicate-video.cjs
 *
 * Needs ffmpeg on PATH to convert Playwright's webm to mp4.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { chromium } = require(process.env.PLAYWRIGHT_PATH ||
  '/Users/lekhrajsaini/Downloads/habit-tracker/node_modules/playwright');

const BASE = process.env.N8N_BASE || 'http://localhost:5678';
const SECRET = process.env.PAYMENT_WEBHOOK_SECRET || 'local-demo-webhook-signing-secret';
const RUN = JSON.parse(fs.readFileSync(path.join(__dirname, '.last-run.json'), 'utf8'));
const WORKFLOW_ID = RUN.payment.workflowId;

const DOCS = path.join(__dirname, '..', 'docs');
const TMP = path.join(DOCS, 'screenshots', '.tmp');

const OWNER = {
  email: process.env.N8N_OWNER_EMAIL || 'demo@localhost.test',
  password: process.env.N8N_OWNER_PASSWORD || 'DemoRun-2026!x',
};

/** One event id, delivered twice - which is exactly what a provider retry is. */
const EVENT = {
  id: 'evt_2026_09_22_replay',
  type: 'invoice.paid',
  data: {
    object: {
      id: 'in_replay_88',
      customer: 'cus_9931',
      customer_email: 'marcus.hale@example.com',
      customer_name: 'Marcus Hale',
      amount_paid: 149900,
      currency: 'aud',
      metadata: { course_id: 'course-2001' },
    },
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function deliver(label) {
  const raw = JSON.stringify(EVENT);
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
  const res = await fetch(`${BASE}/webhook/payments/provider-events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-provider-signature': `t=${t},v1=${v1}` },
    body: raw,
  });
  console.log(`  ${label}: HTTP ${res.status}`);
}

async function openNewestExecution(page) {
  const first = page.locator('[data-test-id="execution-preview-card"], .execution-card').first();
  await first.click({ timeout: 20_000 }).catch(() => {});
  await sleep(2500);
  await page.locator('.vue-flow__pane').click({ position: { x: 700, y: 480 } }).catch(() => {});
  await page.keyboard.press('1');
  await sleep(2500);
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    recordVideo: { dir: TMP, size: { width: 1600, height: 900 } },
  });
  const page = await context.newPage();

  await page.goto(`${BASE}/signin`, { waitUntil: 'networkidle' });
  await page.fill('input[name="emailOrLdapLoginId"], input[type="email"]', OWNER.email);
  await page.fill('input[type="password"]', OWNER.password);
  await page.click('button[type="submit"], [data-test-id="form-submit-button"]');
  await page.waitForURL(/\/home|\/workflow/, { timeout: 30_000 }).catch(() => {});
  await sleep(1500);

  await page.goto(`${BASE}/workflow/${WORKFLOW_ID}/executions`, { waitUntil: 'networkidle' });
  await sleep(4000);

  console.log('delivering:');
  await deliver('first delivery');
  await sleep(6000);
  await openNewestExecution(page);
  await sleep(5000);

  await deliver('second delivery, same event id');
  await sleep(6000);
  await page.goto(`${BASE}/workflow/${WORKFLOW_ID}/executions`, { waitUntil: 'networkidle' });
  await sleep(2500);
  await openNewestExecution(page);
  await sleep(6000);

  // Open the guard so the zero-row result the IF branches on is on screen.
  await page.locator('.vue-flow__node', { hasText: 'Idempotency Guard' }).first()
    .dblclick({ timeout: 15_000 }).catch(() => {});
  await sleep(7000);
  await page.keyboard.press('Escape');
  await sleep(3000);

  const video = page.video();
  await context.close();
  const webm = await video.path();
  await browser.close();

  const mp4 = path.join(DOCS, 'duplicate-webhook.mp4');
  execFileSync('ffmpeg', [
    '-y', '-i', webm,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-crf', '23',
    mp4,
  ], { stdio: 'inherit' });
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`wrote ${path.relative(process.cwd(), mp4)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
