/**
 * Structural checks on every workflow in workflows/.
 *
 * These catch the mistakes that only show up after you have imported a file
 * into a live instance: a connection pointing at a node that was renamed, an
 * HTTP call with no retry, a workflow with no error workflow set, a credential
 * id copied out of someone else's instance, a secret pasted into a parameter.
 *
 *   node --test test/validate.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = join(ROOT, 'workflows');

const FILES = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

/** 03 is the error workflow. Pointing it at itself would loop on its own failures. */
const NO_ERROR_WORKFLOW = new Set(['03-error-trigger-alerts.json']);

const TRIGGER_TYPES = new Set([
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.errorTrigger',
  'n8n-nodes-base.executeWorkflowTrigger',
  'n8n-nodes-base.manualTrigger',
]);

const SECRET_PATTERNS = [
  [/\bsk_(live|test)_[A-Za-z0-9]{8,}/, 'Stripe secret key'],
  [/\bwhsec_[A-Za-z0-9]{8,}/, 'webhook signing secret'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bghp_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, 'JWT'],
  [/"(password|apiKey|api_key|token|secret)"\s*:\s*"(?!=\{\{)[^"{}\s]{8,}"/i, 'literal credential value'],
];

const raw = new Map();
const parsed = new Map();

for (const file of FILES) {
  raw.set(file, readFileSync(join(WORKFLOW_DIR, file), 'utf8'));
}

test('there are four workflow files', () => {
  assert.equal(FILES.length, 4, `expected 4 workflows, found ${FILES.length}: ${FILES.join(', ')}`);
});

for (const file of FILES) {
  test(`${file}: parses as JSON with the keys n8n expects`, () => {
    const wf = JSON.parse(raw.get(file));
    parsed.set(file, wf);

    assert.equal(typeof wf.name, 'string', 'name must be a string');
    assert.ok(wf.name.length > 0, 'name must not be empty');
    assert.ok(Array.isArray(wf.nodes), 'nodes must be an array');
    assert.ok(wf.nodes.length > 0, 'nodes must not be empty');
    assert.equal(typeof wf.connections, 'object', 'connections must be an object');
    assert.equal(typeof wf.settings, 'object', 'settings must be an object');
  });

  test(`${file}: every node has the required fields`, () => {
    const wf = parsed.get(file);

    for (const node of wf.nodes) {
      const where = `node "${node.name ?? '(unnamed)'}"`;
      assert.equal(typeof node.id, 'string', `${where}: id must be a string`);
      assert.equal(typeof node.name, 'string', `${where}: name must be a string`);
      assert.match(node.type, /^n8n-nodes-base\./, `${where}: unexpected node type ${node.type}`);
      assert.equal(typeof node.typeVersion, 'number', `${where}: typeVersion must be a number`);
      assert.ok(
        Array.isArray(node.position) && node.position.length === 2,
        `${where}: position must be [x, y]`,
      );
      assert.equal(typeof node.parameters, 'object', `${where}: parameters must be an object`);
    }
  });

  test(`${file}: node names and ids are unique`, () => {
    const wf = parsed.get(file);

    const names = wf.nodes.map((n) => n.name);
    const duplicateNames = names.filter((n, i) => names.indexOf(n) !== i);
    assert.deepEqual(duplicateNames, [], 'connections are keyed by name, so names must be unique');

    const ids = wf.nodes.map((n) => n.id);
    const duplicateIds = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepEqual(duplicateIds, [], 'duplicate node ids');
  });

  test(`${file}: every connection points at a node that exists`, () => {
    const wf = parsed.get(file);
    const names = new Set(wf.nodes.map((n) => n.name));

    for (const [source, outputs] of Object.entries(wf.connections)) {
      assert.ok(names.has(source), `connections key "${source}" is not a node in this workflow`);

      for (const branch of outputs.main ?? []) {
        for (const link of branch ?? []) {
          assert.ok(
            names.has(link.node),
            `"${source}" connects to "${link.node}", which does not exist`,
          );
          assert.equal(link.type, 'main', `"${source}" -> "${link.node}": type must be "main"`);
          assert.equal(typeof link.index, 'number', `"${source}" -> "${link.node}": index missing`);
        }
      }
    }
  });

  test(`${file}: has exactly one trigger and no unreachable nodes`, () => {
    const wf = parsed.get(file);

    const triggers = wf.nodes.filter((n) => TRIGGER_TYPES.has(n.type));
    assert.equal(triggers.length, 1, `expected one trigger, found ${triggers.length}`);

    const reached = new Set([triggers[0].name]);
    const queue = [triggers[0].name];
    while (queue.length) {
      const current = queue.shift();
      for (const branch of wf.connections[current]?.main ?? []) {
        for (const link of branch ?? []) {
          if (!reached.has(link.node)) {
            reached.add(link.node);
            queue.push(link.node);
          }
        }
      }
    }

    const orphans = wf.nodes.map((n) => n.name).filter((n) => !reached.has(n));
    assert.deepEqual(orphans, [], 'nodes not reachable from the trigger - a dangling branch');
  });

  test(`${file}: every HTTP Request retries and routes its errors`, () => {
    const wf = parsed.get(file);
    const httpNodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest');

    for (const node of httpNodes) {
      const where = `"${node.name}"`;
      assert.equal(node.retryOnFail, true, `${where}: retryOnFail must be true`);
      assert.ok(
        Number.isInteger(node.maxTries) && node.maxTries >= 2,
        `${where}: maxTries must be at least 2`,
      );
      assert.ok(
        Number.isInteger(node.waitBetweenTries) && node.waitBetweenTries >= 1000,
        `${where}: waitBetweenTries must be at least 1000ms - immediate retries hit the same failure`,
      );
      assert.equal(
        node.onError,
        'continueErrorOutput',
        `${where}: onError must route to the error output, not stop the workflow silently`,
      );

      const errorBranch = wf.connections[node.name]?.main?.[1] ?? [];
      assert.ok(
        errorBranch.length > 0,
        `${where}: has an error output with nothing wired to it`,
      );
    }
  });

  test(`${file}: settings are production settings`, () => {
    const wf = parsed.get(file);

    assert.equal(
      wf.settings.executionOrder,
      'v1',
      'executionOrder must be v1 - v0 runs branches in an order you cannot predict',
    );

    if (NO_ERROR_WORKFLOW.has(file)) {
      assert.equal(
        wf.settings.errorWorkflow,
        undefined,
        'the error workflow must not point at itself',
      );
    } else {
      assert.equal(
        typeof wf.settings.errorWorkflow,
        'string',
        'settings.errorWorkflow must be set so failures reach workflow 03',
      );
      assert.ok(wf.settings.errorWorkflow.length > 0, 'settings.errorWorkflow must not be empty');
    }
  });

  test(`${file}: no secrets and no hard-coded endpoints`, () => {
    const text = raw.get(file);

    for (const [pattern, label] of SECRET_PATTERNS) {
      const hit = text.match(pattern);
      assert.equal(hit, null, `looks like a ${label} was committed: ${hit?.[0]?.slice(0, 24)}`);
    }

    // Every external call must go through {{ $env.X }} so the same file can be
    // imported into staging and production without editing node parameters.
    const literalUrls = text.match(/https?:\/\/[^"\\\s]+/g) ?? [];
    assert.deepEqual(literalUrls, [], 'hard-coded URL - use {{ $env.SOMETHING_API_BASE }} instead');
  });

  test(`${file}: credentials are placeholders, not ids from another instance`, () => {
    const wf = parsed.get(file);

    for (const node of wf.nodes) {
      for (const [type, cred] of Object.entries(node.credentials ?? {})) {
        const where = `"${node.name}" (${type})`;
        assert.equal(cred.id, null, `${where}: credential id must be null, not an instance id`);
        assert.equal(typeof cred.name, 'string', `${where}: credential name missing`);
        assert.ok(cred.name.length > 0, `${where}: credential name is empty`);
      }
    }
  });
}

test('webhook paths are unique across the kit', () => {
  const seen = new Map();

  for (const file of FILES) {
    const wf = parsed.get(file) ?? JSON.parse(raw.get(file));
    for (const node of wf.nodes) {
      if (node.type !== 'n8n-nodes-base.webhook') continue;
      const path = node.parameters.path;
      assert.ok(path, `"${node.name}" in ${file} has no webhook path`);
      assert.ok(
        !seen.has(path),
        `webhook path "${path}" is used by both ${seen.get(path)} and ${file} - they would collide`,
      );
      seen.set(path, file);
    }
  }
});

test('the webhook workflows verify the signature before touching the database', () => {
  for (const file of ['01-payment-to-enrolment.json', '02-failed-payment-recovery.json']) {
    const wf = parsed.get(file) ?? JSON.parse(raw.get(file));
    const webhook = wf.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');

    assert.equal(
      webhook.parameters.options?.rawBody,
      true,
      `${file}: the webhook must capture the raw body, or the HMAC cannot be recomputed`,
    );

    const next = wf.connections[webhook.name].main[0][0].node;
    assert.equal(next, 'Verify Signature', `${file}: the webhook must feed Verify Signature first`);
  }
});

test('the idempotency guard relies on the unique constraint, not a prior SELECT', () => {
  for (const file of ['01-payment-to-enrolment.json', '02-failed-payment-recovery.json']) {
    const wf = parsed.get(file) ?? JSON.parse(raw.get(file));
    const guard = wf.nodes.find((n) => n.name === 'Idempotency Guard');

    assert.ok(guard, `${file}: no Idempotency Guard node`);
    assert.equal(guard.type, 'n8n-nodes-base.postgres');

    const query = guard.parameters.query;
    assert.match(query, /INSERT INTO processed_events/, `${file}: the guard must INSERT`);
    assert.match(query, /ON CONFLICT \(provider, provider_event_id\) DO NOTHING/, `${file}`);
    assert.match(query, /RETURNING/, `${file}: it must return rows so a duplicate is detectable`);
    assert.equal(
      guard.alwaysOutputData,
      true,
      `${file}: without alwaysOutputData a duplicate emits nothing and the IF never runs`,
    );
  }
});
