/**
 * Local stand-in for the three external services the workflows talk to:
 * the payment provider, Thinkific, and Slack.
 *
 * It exists so the workflows can be executed end to end - real n8n, real
 * Postgres, real HTTP - without anyone's production API keys. Nothing here is
 * a simulation of n8n; n8n does all of the work and this only answers the
 * calls n8n makes.
 *
 * Two listeners:
 *   :4000  plain HTTP - payment provider, Thinkific, transactional email,
 *          and the /__control endpoints the scenario script drives.
 *   :443   HTTPS with a self-signed certificate, serving the Slack Web API.
 *          n8n's Slack node has no base-URL setting, so the demo compose file
 *          maps slack.com to this container and turns off certificate
 *          verification. That is a demo-only shortcut and is documented as one.
 *
 * Node stdlib only. No dependencies, no build step.
 */
import http from 'node:http';
import https from 'node:https';
import { readFileSync, existsSync } from 'node:fs';

const HTTP_PORT = Number(process.env.MOCK_HTTP_PORT || 4000);
const TLS_PORT = Number(process.env.MOCK_TLS_PORT || 443);
const TLS_DIR = process.env.MOCK_TLS_DIR || '/tls';

/* --------------------------------------------------------------------------
 * State. Everything lives in memory and is reset between scenarios so each
 * recorded run starts from a known position.
 * ------------------------------------------------------------------------ */
const state = freshState();

function freshState() {
  return {
    users: new Map(),          // email -> { id, email, first_name, last_name }
    enrolments: new Map(),     // id -> { id, user_id, user_email, course_id, created_at, expired_at }
    enrolmentKeys: new Set(),  // `${user_id}:${course_id}` - the uniqueness Thinkific itself enforces
    invoices: new Map(),       // id -> { id, status, amount_due, currency }
    charges: [],               // reconciliation source data
    emails: [],                // every transactional email "sent"
    slack: [],                 // every Slack message "posted"
    calls: [],                 // request log, for asserting what was and was not called
    injections: [],            // forced failures
    nextUserId: 900_100,
    nextEnrolmentId: 700_100,
  };
}

function reset() {
  const fresh = freshState();
  for (const key of Object.keys(fresh)) state[key] = fresh[key];
}

/* --------------------------------------------------------------------------
 * Forced failures.
 *
 * { target: 'thinkific_users', status: 500, times: 9 } makes the next nine
 * calls to that endpoint fail. `times` matters: it is how the recorded run
 * shows an outage that lasts exactly long enough to exhaust a node's retry
 * budget and then clears, rather than a service that is down forever.
 * ------------------------------------------------------------------------ */
function takeInjection(target) {
  const hit = state.injections.find((i) => i.target === target && i.remaining > 0);
  if (!hit) return null;
  hit.remaining -= 1;
  return hit;
}

/* --------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------ */
function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(Object.fromEntries(new URLSearchParams(raw)));
      }
    });
  });
}

function log(kind, detail) {
  state.calls.push({ at: new Date().toISOString(), kind, ...detail });
}

const lower = (v) => String(v || '').toLowerCase().trim();

/* --------------------------------------------------------------------------
 * Payment provider
 * ------------------------------------------------------------------------ */
function payments(url, req, res) {
  const path = url.pathname.replace(/^\/payments\/v1/, '');

  const invoiceMatch = path.match(/^\/invoices\/([^/]+)$/);
  if (invoiceMatch && req.method === 'GET') {
    const id = decodeURIComponent(invoiceMatch[1]);
    log('payment.invoice.get', { invoice_id: id });

    const forced = takeInjection('payment_invoice');
    if (forced) return send(res, forced.status, { error: { message: 'injected failure' } });

    const invoice = state.invoices.get(id);
    if (!invoice) return send(res, 404, { error: { message: `no such invoice: ${id}` } });
    return send(res, 200, invoice);
  }

  if (path === '/charges' && req.method === 'GET') {
    const gte = Number(url.searchParams.get('created[gte]') || 0);
    const lte = Number(url.searchParams.get('created[lte]') || Number.MAX_SAFE_INTEGER);
    log('payment.charges.list', { gte, lte });

    const forced = takeInjection('payment_charges');
    if (forced) return send(res, forced.status, { error: { message: 'injected failure' } });

    const data = state.charges.filter((c) => c.created >= gte && c.created <= lte);
    return send(res, 200, { object: 'list', data, has_more: false });
  }

  return send(res, 404, { error: { message: `payment mock: no route for ${req.method} ${path}` } });
}

/* --------------------------------------------------------------------------
 * Thinkific
 * ------------------------------------------------------------------------ */
function thinkific(url, req, res, body) {
  const path = url.pathname.replace(/^\/thinkific\/v1/, '');

  if (path === '/users' && req.method === 'GET') {
    const email = lower(url.searchParams.get('query[email]'));
    log('thinkific.users.search', { email });

    const forced = takeInjection('thinkific_users');
    if (forced) {
      return send(res, forced.status, { error: 'injected Thinkific failure on user lookup' });
    }

    const user = state.users.get(email);
    return send(res, 200, {
      items: user ? [user] : [],
      meta: { pagination: { current_page: 1, total_items: user ? 1 : 0 } },
    });
  }

  if (path === '/users' && req.method === 'POST') {
    const email = lower(body.email);
    log('thinkific.users.create', { email });

    const forced = takeInjection('thinkific_users');
    if (forced) return send(res, forced.status, { error: 'injected Thinkific failure on user create' });

    if (state.users.has(email)) {
      // Thinkific's real response when the email is taken.
      return send(res, 422, { errors: { email: ['has already been taken'] } });
    }
    const user = {
      id: state.nextUserId++,
      email,
      first_name: body.first_name || 'Student',
      last_name: body.last_name || '-',
      created_at: new Date().toISOString(),
    };
    state.users.set(email, user);
    return send(res, 201, user);
  }

  if (path === '/enrollments' && req.method === 'GET') {
    const since = url.searchParams.get('query[created_since]');
    log('thinkific.enrolments.list', { since });

    const forced = takeInjection('thinkific_enrolments_list');
    if (forced) return send(res, forced.status, { error: 'injected Thinkific failure on enrolment list' });

    const cutoff = since ? Date.parse(since) : 0;
    const items = [...state.enrolments.values()].filter((e) => Date.parse(e.created_at) >= cutoff);
    return send(res, 200, { items, meta: { pagination: { total_items: items.length } } });
  }

  if (path === '/enrollments' && req.method === 'POST') {
    const userId = Number(body.user_id);
    const courseId = String(body.course_id);
    log('thinkific.enrolments.create', { user_id: userId, course_id: courseId });

    const forced = takeInjection('thinkific_enrol');
    if (forced) return send(res, forced.status, { error: 'injected Thinkific failure on enrolment' });

    const key = `${userId}:${courseId}`;
    if (state.enrolmentKeys.has(key)) {
      // The response the workflow deliberately treats as success.
      return send(res, 422, {
        errors: { user_id: ['is already enrolled in this course'] },
        message: 'User has already been enrolled in this course',
      });
    }

    const owner = [...state.users.values()].find((u) => u.id === userId);
    const enrolment = {
      id: state.nextEnrolmentId++,
      user_id: userId,
      user_email: owner ? owner.email : null,
      course_id: courseId,
      created_at: new Date().toISOString(),
      activated_at: body.activated_at || new Date().toISOString(),
      expired_at: null,
    };
    state.enrolmentKeys.add(key);
    state.enrolments.set(enrolment.id, enrolment);
    return send(res, 201, enrolment);
  }

  const enrolMatch = path.match(/^\/enrollments\/([^/]+)$/);
  if (enrolMatch && req.method === 'PUT') {
    const id = Number(enrolMatch[1]);
    log('thinkific.enrolments.update', { enrolment_id: id, expired_at: body.expired_at });

    const forced = takeInjection('thinkific_enrol_update');
    if (forced) return send(res, forced.status, { error: 'injected Thinkific failure on revoke' });

    const enrolment = state.enrolments.get(id);
    if (!enrolment) return send(res, 404, { error: `no such enrolment: ${id}` });
    enrolment.expired_at = body.expired_at || new Date().toISOString();
    return send(res, 200, enrolment);
  }

  return send(res, 404, { error: `thinkific mock: no route for ${req.method} ${path}` });
}

/* --------------------------------------------------------------------------
 * Transactional email
 * ------------------------------------------------------------------------ */
function email(url, req, res, body) {
  const path = url.pathname.replace(/^\/email\/v1/, '');

  if (path === '/messages' && req.method === 'POST') {
    const stage = body?.variables?.stage || null;
    log('email.send', { to: body.to, template: body.template, stage });

    const forced = takeInjection('email');
    if (forced) return send(res, forced.status, { error: 'injected email failure' });

    const message = {
      id: `msg_${state.emails.length + 1}`,
      to: body.to,
      template: body.template,
      stage,
      sent_at: new Date().toISOString(),
    };
    state.emails.push(message);
    return send(res, 202, { ...message, accepted: true });
  }

  return send(res, 404, { error: `email mock: no route for ${req.method} ${path}` });
}

/* --------------------------------------------------------------------------
 * Slack Web API
 * ------------------------------------------------------------------------ */
function slack(url, req, res, body) {
  const method = url.pathname.replace(/^\/api\//, '');
  log('slack.' + method, { channel: body.channel });

  const forced = takeInjection('slack');
  if (forced) {
    // Slack signals application errors with HTTP 200 + ok:false, but it returns
    // real 5xx during an outage. The 5xx is what exercises the node's retries.
    return send(res, forced.status, { ok: false, error: 'injected_slack_outage' });
  }

  if (method === 'chat.postMessage') {
    const message = {
      ts: (Date.now() / 1000).toFixed(6),
      channel: body.channel,
      text: body.text || '',
      posted_at: new Date().toISOString(),
    };
    state.slack.push(message);
    return send(res, 200, { ok: true, channel: body.channel, ts: message.ts, message: { text: message.text } });
  }

  if (method === 'auth.test') {
    return send(res, 200, { ok: true, user: 'revenue-bot', user_id: 'U0MOCKBOT', team: 'mock-workspace' });
  }

  if (method === 'conversations.list') {
    return send(res, 200, {
      ok: true,
      channels: [
        { id: 'C0ENROLMENTS', name: 'enrolments' },
        { id: 'C0ALERTS', name: 'automation-alerts' },
      ],
      response_metadata: { next_cursor: '' },
    });
  }

  return send(res, 200, { ok: true });
}

/* --------------------------------------------------------------------------
 * Control plane - used by scripts/run-scenarios.mjs, never by n8n
 * ------------------------------------------------------------------------ */
function control(url, req, res, body) {
  const path = url.pathname.replace(/^\/__control/, '');

  if (path === '/reset' && req.method === 'POST') {
    reset();
    return send(res, 200, { ok: true });
  }

  if (path === '/inject' && req.method === 'POST') {
    const injection = {
      target: body.target,
      status: Number(body.status || 500),
      remaining: Number(body.times ?? 1),
    };
    state.injections.push(injection);
    return send(res, 200, { ok: true, injection });
  }

  if (path === '/injections' && req.method === 'GET') {
    return send(res, 200, { injections: state.injections });
  }

  if (path === '/seed' && req.method === 'POST') {
    for (const invoice of body.invoices || []) state.invoices.set(invoice.id, invoice);
    for (const charge of body.charges || []) state.charges.push(charge);
    for (const user of body.users || []) state.users.set(lower(user.email), user);
    for (const enrolment of body.enrolments || []) {
      state.enrolments.set(enrolment.id, enrolment);
      state.enrolmentKeys.add(`${enrolment.user_id}:${enrolment.course_id}`);
    }
    return send(res, 200, { ok: true });
  }

  if (path === '/invoice' && req.method === 'POST') {
    const invoice = state.invoices.get(body.id) || { id: body.id };
    Object.assign(invoice, body);
    state.invoices.set(body.id, invoice);
    return send(res, 200, invoice);
  }

  if (path === '/state' && req.method === 'GET') {
    return send(res, 200, {
      users: [...state.users.values()],
      enrolments: [...state.enrolments.values()],
      invoices: [...state.invoices.values()],
      charges: state.charges,
      emails: state.emails,
      slack: state.slack,
      calls: state.calls,
      injections: state.injections,
    });
  }

  return send(res, 404, { error: `control: no route for ${req.method} ${path}` });
}

/* --------------------------------------------------------------------------
 * Dispatch
 * ------------------------------------------------------------------------ */
async function handle(req, res) {
  const url = new URL(req.url, 'http://mock.local');
  const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readBody(req);

  try {
    if (url.pathname.startsWith('/__control')) return control(url, req, res, body);
    if (url.pathname.startsWith('/payments/v1')) return payments(url, req, res);
    if (url.pathname.startsWith('/thinkific/v1')) return thinkific(url, req, res, body);
    if (url.pathname.startsWith('/email/v1')) return email(url, req, res, body);
    if (url.pathname.startsWith('/api/')) return slack(url, req, res, body);
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    return send(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
  } catch (err) {
    return send(res, 500, { error: String(err && err.message) });
  }
}

http.createServer(handle).listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`[mock] http  :${HTTP_PORT}  payments | thinkific | email | control`);
});

const keyPath = `${TLS_DIR}/mock.key`;
const certPath = `${TLS_DIR}/mock.crt`;
if (existsSync(keyPath) && existsSync(certPath)) {
  https
    .createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, handle)
    .listen(TLS_PORT, '0.0.0.0', () => {
      console.log(`[mock] https :${TLS_PORT} slack web api (self-signed)`);
    });
} else {
  console.warn(`[mock] no certificate in ${TLS_DIR} - the Slack listener is disabled`);
}
