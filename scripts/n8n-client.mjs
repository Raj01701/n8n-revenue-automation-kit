/**
 * Thin client for the n8n internal REST API, used by the demo scripts.
 *
 * The internal API (/rest) rather than the public one (/api/v1) because the
 * public API needs an API key that itself has to be created through the UI,
 * and because /rest is what the editor uses - if a call works here it works
 * when a person clicks the same button.
 */
const BASE = process.env.N8N_BASE || 'http://127.0.0.1:5678';

let cookie = null;

export async function login({ email, password }) {
  const res = await fetch(`${BASE}/rest/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'browser-id': 'demo-script' },
    body: JSON.stringify({ emailOrLdapLoginId: email, password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return cookie;
}

export async function setupOwner({ email, password, firstName, lastName }) {
  const res = await fetch(`${BASE}/rest/owner/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'browser-id': 'demo-script' },
    body: JSON.stringify({ email, password, firstName, lastName }),
  });
  const text = await res.text();
  if (res.ok) {
    cookie = (res.headers.get('set-cookie') || '').split(';')[0];
    return { created: true };
  }
  // Already set up on a previous run - fall back to logging in.
  if (/already|setup/i.test(text)) {
    await login({ email, password });
    return { created: false };
  }
  throw new Error(`owner setup failed: ${res.status} ${text}`);
}

export async function api(path, options = {}) {
  const res = await fetch(`${BASE}/rest${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'browser-id': 'demo-script',
      cookie,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${options.method || 'GET'} ${path} -> ${res.status} ${text.slice(0, 600)}`);
  return text ? JSON.parse(text).data ?? JSON.parse(text) : null;
}

export const cookieHeader = () => cookie;
export const baseUrl = () => BASE;
