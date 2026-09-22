/**
 * Imports a runnable copy of workflow 02.
 *
 * The real dunning sequence waits 24 hours and then a further 48. That is the
 * correct interval and it is also three days per recorded execution, so this
 * takes workflows/02-failed-payment-recovery.json exactly as committed and
 * changes two things:
 *
 *   - the two Wait nodes go from 24h / 48h to 5 seconds each
 *   - the webhook path becomes payments/failed-demo, so it does not collide
 *     with the real workflow 02, which stays imported and active
 *
 * Nothing else is touched: same invoice re-check before every send, same
 * branches, same SQL. The copy is named so that a screenshot of it cannot be
 * mistaken for the production file.
 *
 *   node scripts/make-dunning-demo.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { login, api } from './n8n-client.mjs';
import { DUNNING_DEMO_NAME } from './demo-constants.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'workflows', '02-failed-payment-recovery.json');

const OWNER = {
  email: process.env.N8N_OWNER_EMAIL || 'demo@localhost.test',
  password: process.env.N8N_OWNER_PASSWORD || 'DemoRun-2026!x',
};

async function main() {
  await login(OWNER);

  const list = await api('/workflows');
  const items = list.data ?? list;
  const existing = items.find((w) => w.name === DUNNING_DEMO_NAME);
  if (existing) {
    console.log(`already present: ${DUNNING_DEMO_NAME} (${existing.id})`);
    return;
  }

  const real = items.find((w) => w.name === '02 - Failed Payment Recovery (Dunning)');
  if (!real) throw new Error('workflow 02 is not imported yet');
  const credentialSource = await api(`/workflows/${real.id}`);

  // Credential selections are copied off the already-configured workflow 02, so
  // the copy points at the same five credentials rather than new ones.
  const credentialsByNode = new Map(
    credentialSource.nodes.map((n) => [n.name, n.credentials]),
  );

  const wf = JSON.parse(readFileSync(SOURCE, 'utf8'));
  wf.name = DUNNING_DEMO_NAME;

  for (const node of wf.nodes) {
    if (node.type === 'n8n-nodes-base.wait') {
      node.parameters = { ...node.parameters, amount: 10, unit: 'seconds' };
    }
    if (node.type === 'n8n-nodes-base.webhook') {
      node.parameters = { ...node.parameters, path: 'payments/failed-demo' };
      node.webhookId = 'f2b9a0d1-5c44-4a90-9e21-failed-demo';
    }
    if (credentialsByNode.get(node.name)) node.credentials = credentialsByNode.get(node.name);
  }

  wf.settings = { ...wf.settings, errorWorkflow: credentialSource.settings.errorWorkflow };

  const created = await api('/workflows', {
    method: 'POST',
    body: JSON.stringify({ name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings }),
  });
  const saved = await api(`/workflows/${created.id}`);
  await api(`/workflows/${created.id}/activate`, {
    method: 'POST',
    body: JSON.stringify({ versionId: saved.versionId }),
  });

  console.log(`created and activated: ${wf.name} (${created.id})`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
