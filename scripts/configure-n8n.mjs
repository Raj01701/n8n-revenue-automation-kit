/**
 * Wires the imported workflows up to credentials so they can actually run.
 *
 * The files in workflows/ ship with `"id": null` on every credential and the
 * placeholder REPLACE_WITH_ERROR_WORKFLOW_ID as the error workflow, because a
 * credential id from someone else's instance is worse than no id at all. This
 * does, over the API, exactly what the README tells a human to do by hand:
 * create the five credentials, select them on each node, point 01/02/04 at 03
 * as their error workflow, and activate all four.
 *
 *   node scripts/configure-n8n.mjs
 */
import { setupOwner, api } from './n8n-client.mjs';

const OWNER = {
  email: process.env.N8N_OWNER_EMAIL || 'demo@localhost.test',
  password: process.env.N8N_OWNER_PASSWORD || 'DemoRun-2026!x',
  firstName: 'Demo',
  lastName: 'Operator',
};

/** Credential name in the workflow files -> what to create in n8n. */
const CREDENTIALS = [
  {
    name: 'Postgres - n8n operations DB',
    type: 'postgres',
    data: {
      host: 'postgres',
      port: 5432,
      database: process.env.REVENUE_OPS_DB || 'revenue_ops',
      user: process.env.POSTGRES_USER || 'n8n',
      password: process.env.POSTGRES_PASSWORD || 'local-demo-password',
      ssl: 'disable',
      allowUnauthorizedCerts: false,
      maxConnections: 100,
    },
  },
  { name: 'Slack - Revenue Bot', type: 'slackApi', data: { accessToken: 'xoxb-local-mock-token' } },
  {
    name: 'Thinkific API - header auth',
    type: 'httpHeaderAuth',
    data: { name: 'X-Auth-API-Key', value: 'local-mock-thinkific-key' },
  },
  {
    name: 'Payment provider API - header auth',
    type: 'httpHeaderAuth',
    data: { name: 'Authorization', value: 'Bearer local-mock-payment-key' },
  },
  {
    name: 'Transactional email API - header auth',
    type: 'httpHeaderAuth',
    data: { name: 'Authorization', value: 'Bearer local-mock-email-key' },
  },
];

const ERROR_WORKFLOW_NAME = '03 - Error Trigger Alerts';

async function ensureCredentials() {
  const existing = await api('/credentials');
  const byName = new Map((existing || []).map((c) => [c.name, c]));
  const resolved = new Map();

  for (const spec of CREDENTIALS) {
    if (byName.has(spec.name)) {
      resolved.set(spec.name, byName.get(spec.name).id);
      continue;
    }
    const created = await api('/credentials', { method: 'POST', body: JSON.stringify(spec) });
    resolved.set(spec.name, created.id);
    console.log(`  credential created: ${spec.name} (${spec.type}) -> ${created.id}`);
  }
  return resolved;
}

async function main() {
  const { created } = await setupOwner(OWNER);
  console.log(created ? 'owner account created' : 'owner account already existed, logged in');

  const credentialIds = await ensureCredentials();

  const list = await api('/workflows');
  const workflows = list.data ?? list;
  const errorWorkflow = workflows.find((w) => w.name === ERROR_WORKFLOW_NAME);
  if (!errorWorkflow) throw new Error(`"${ERROR_WORKFLOW_NAME}" is not imported - run the import first`);
  console.log(`error workflow: ${errorWorkflow.name} -> ${errorWorkflow.id}`);

  for (const summary of workflows) {
    const wf = await api(`/workflows/${summary.id}`);

    for (const node of wf.nodes) {
      for (const [type, cred] of Object.entries(node.credentials || {})) {
        const id = credentialIds.get(cred.name);
        if (!id) throw new Error(`no credential created for "${cred.name}" on node "${node.name}"`);
        node.credentials[type] = { id, name: cred.name };
      }
    }

    const settings = { ...wf.settings };
    if (settings.errorWorkflow === 'REPLACE_WITH_ERROR_WORKFLOW_ID') {
      settings.errorWorkflow = errorWorkflow.id;
    }

    await api(`/workflows/${wf.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: wf.name, nodes: wf.nodes, connections: wf.connections, settings, versionId: wf.versionId }),
    });
    // Activation is its own endpoint and wants the version it is activating, so
    // that two people saving the same workflow cannot activate each other's copy.
    const saved = await api(`/workflows/${wf.id}`);
    await api(`/workflows/${wf.id}/activate`, {
      method: 'POST',
      body: JSON.stringify({ versionId: saved.versionId }),
    });

    console.log(`  ${wf.name}: credentials attached, error workflow set, activated`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
