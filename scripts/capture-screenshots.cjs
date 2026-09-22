/**
 * Screenshots the real n8n execution views for the runs scripts/run-scenarios.mjs
 * just produced, into docs/screenshots/.
 *
 * Headless Chromium against http://localhost:5678, logged in as the demo owner.
 * Nothing is drawn or mocked up: every image is the view n8n renders for an
 * execution id that exists in its own database, cropped to the canvas so the
 * node labels are readable rather than lost in empty grid.
 *
 *   node scripts/run-scenarios.mjs && node scripts/capture-screenshots.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const { chromium } = require(process.env.PLAYWRIGHT_PATH ||
  '/Users/lekhrajsaini/Downloads/habit-tracker/node_modules/playwright');

const BASE = process.env.N8N_BASE || 'http://localhost:5678';
const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const RUN = JSON.parse(fs.readFileSync(path.join(__dirname, '.last-run.json'), 'utf8'));

const OWNER = {
  email: process.env.N8N_OWNER_EMAIL || 'demo@localhost.test',
  password: process.env.N8N_OWNER_PASSWORD || 'DemoRun-2026!x',
};

const VIEWPORT = { width: 1920, height: 1080 };
/**
 * Crop from just above the breadcrumb, so every workflow screenshot carries the
 * workflow's own name and the "Succeeded in 316ms | ID#1" line. Those two are
 * what make the image evidence rather than decoration.
 */
const HEADER_TOP = 16;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dismissOverlays(page) {
  for (let i = 0; i < 4; i += 1) {
    const close = page.locator('.el-dialog__headerbtn, [data-test-id="close-button"]').first();
    if (await close.isVisible().catch(() => false)) {
      await close.click().catch(() => {});
      await sleep(400);
      continue;
    }
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(250);
  }
}

async function openExecution(page, workflowId, executionId) {
  await page.goto(`${BASE}/workflow/${workflowId}/executions/${executionId}`, {
    waitUntil: 'networkidle',
  });
  await page.waitForSelector('.vue-flow__node', { timeout: 30_000 });
  await dismissOverlays(page);
  await page.locator('.vue-flow__pane').click({ position: { x: 700, y: 500 } }).catch(() => {});
  await page.keyboard.press('1'); // zoom to fit
  await sleep(1800);
}

/** Crop to the band the workflow actually occupies, header included. */
async function canvasClip(page) {
  const bottom = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.vue-flow__node')];
    if (!nodes.length) return null;
    return Math.max(...nodes.map((n) => n.getBoundingClientRect().bottom));
  });
  if (!bottom) return undefined;
  return {
    x: 0,
    y: HEADER_TOP,
    width: VIEWPORT.width,
    height: Math.min(VIEWPORT.height, bottom + 56) - HEADER_TOP,
  };
}

async function shoot(page, name, options = {}) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, ...options });
  console.log(`  wrote ${path.relative(process.cwd(), file)}`);
}

async function shootCanvas(page, name) {
  await shoot(page, name, { clip: await canvasClip(page) });
}

async function openNode(page, label) {
  const node = page.locator('.vue-flow__node', { hasText: label }).first();
  await node.dblclick({ timeout: 15_000 });
  await sleep(2200);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 3 });
  const page = await context.newPage();

  await page.goto(`${BASE}/signin`, { waitUntil: 'networkidle' });
  await page.fill('input[name="emailOrLdapLoginId"], input[type="email"]', OWNER.email);
  await page.fill('input[type="password"]', OWNER.password);
  await page.click('button[type="submit"], [data-test-id="form-submit-button"]');
  await page.waitForURL(/\/home|\/workflow/, { timeout: 30_000 }).catch(() => {});
  await sleep(2000);
  await dismissOverlays(page);

  console.log('capturing:');

  await openExecution(page, RUN.payment.workflowId, RUN.payment.executionId);
  await shootCanvas(page, '01-payment-success.png');

  await openExecution(page, RUN.duplicate.workflowId, RUN.duplicate.executionId);
  await shootCanvas(page, '02-duplicate-ignored.png');

  // The same duplicate execution with the Idempotency Guard opened, so the
  // zero-row result the IF reads is visible rather than asserted.
  await openNode(page, 'Idempotency Guard');
  await shoot(page, '03-duplicate-guard-zero-rows.png');
  await page.keyboard.press('Escape');

  await openExecution(page, RUN.dunning.workflowId, RUN.dunning.executionId);
  await shootCanvas(page, '04-dunning-stopped-on-payment.png');

  await openExecution(page, RUN.outage.workflowId, RUN.outage.executionId);
  await shootCanvas(page, '05-thinkific-500-retries.png');
  await openNode(page, 'Find Student By Email');
  await shoot(page, '06-thinkific-500-node-error.png');
  await page.keyboard.press('Escape');

  await openExecution(page, RUN.outage.errorWorkflowId, RUN.outage.errorExecutionId);
  await shootCanvas(page, '07-error-trigger-fired.png');

  await openExecution(page, RUN.reconciliation.workflowId, RUN.reconciliation.executionId);
  await shootCanvas(page, '08-reconciliation-discrepancy.png');

  await page.goto(`${BASE}/home/executions`, { waitUntil: 'networkidle' });
  await sleep(2500);
  await dismissOverlays(page);
  await shoot(page, '09-executions-list.png', {
    clip: { x: 0, y: 0, width: VIEWPORT.width, height: 760 },
  });

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
