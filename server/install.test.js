/*
 * node server/install.test.js
 *
 * Boots the real server against throwaway data directories and checks what a
 * stranger and an existing install each get:
 *
 *   - FRESH: nothing is reachable until the owner is created from the one-time
 *     setup link printed to stdout; then the session cookie works, a bearer
 *     token works for machine callers, and every outside link (AI, Totem bridge,
 *     WHOOP, digest file) is off and says so instead of failing.
 *   - PROXY: KRAKATOA_AUTH=proxy asks for no sign-in at all.
 *   - EXISTING: a data dir that already holds a log behaves as it did before
 *     sign-in existed, with no new env.
 *
 * HOME and PATH point at empty places, so no real `claude` or Totem is found.
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const SERVER = path.join(__dirname, 'server.js')
let passed = 0
const procs = []

function boot(env = {}, seed = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krakatoa-install-'))
  if (seed) for (const [f, body] of Object.entries(seed)) fs.writeFileSync(path.join(dir, f), body)
  const child = spawn(process.execPath, [SERVER], {
    env: {
      KRAKATOA_DATA_DIR: dir,
      KRAKATOA_PORT: '0',
      KRAKATOA_BIND: '127.0.0.1',
      HOME: dir,
      PATH: path.join(dir, 'no-bin'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  procs.push(child)
  let out = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 10000)
    const onData = (c) => {
      out += c
      const m = out.match(/listening on [^\s]+:(\d+)/)
      // The startup lines (and the setup link, if any) are written in the same
      // tick as this one; a moment later they are all in `out`.
      if (m) {
        setTimeout(() => {
          clearTimeout(timer)
          const token = (out.match(/setup\?token=([A-Za-z0-9_-]+)/) || [])[1] || null
          resolve({ dir, base: `http://127.0.0.1:${m[1]}`, token, log: () => out })
        }, 150)
        child.stdout.off('data', onData)
        child.stdout.on('data', c2 => { out += c2 })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', c => { out += c })
    child.on('exit', code => reject(new Error(`server exited ${code}:\n${out}`)))
  })
}

async function http(base, p, { method, body, form, cookie, headers = {} } = {}) {
  method = method || (body !== undefined || form ? 'POST' : 'GET')
  const h = { ...headers }
  if (cookie) h.cookie = cookie
  let payload
  if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString() }
  else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body) }
  const res = await fetch(base + p, { method, headers: h, body: payload, redirect: 'manual' })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* html */ }
  const setCookie = res.headers.get('set-cookie') || ''
  return { status: res.status, clearSiteData: res.headers.get('clear-site-data'), json, text, setCookie, location: res.headers.get('location'), cookie: setCookie.split(';')[0] }
}

const steps = []
const test = (name, fn) => steps.push([name, fn])
const mode = (f) => (fs.statSync(f).mode & 0o777).toString(8)

/* ------------------------------------------------------------------ fresh */

test('fresh install: setup token, owner, session, bearer, everything off', async () => {
  const s = await boot()
  const settingsFile = path.join(s.dir, 'settings.json')
  assert.ok(s.token, 'a setup link is printed')
  assert.equal(mode(settingsFile), '600')
  const stored = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  assert.equal(stored.totem, undefined)
  assert.equal(stored.digestFile, undefined)

  // Nothing is reachable before setup.
  let r = await http(s.base, '/api/state')
  assert.equal(r.status, 401)
  assert.equal(r.json.setup, true)
  assert.equal((await http(s.base, '/')).status, 503)
  assert.equal((await http(s.base, '/mcp', { method: 'POST', body: {} })).status, 401)
  assert.equal((await http(s.base, '/icon-192.png')).status !== 401, true, 'icons are public')

  // Only the printed link opens /setup.
  assert.equal((await http(s.base, '/setup')).status, 403)
  assert.equal((await http(s.base, '/setup?token=guess')).status, 403)
  assert.equal((await http(s.base, `/setup?token=${s.token}`)).status, 200)
  r = await http(s.base, '/api/auth/setup', { body: { token: 'guess', username: 'me', password: 'long enough pw' } })
  assert.equal(r.status, 403)
  r = await http(s.base, '/api/auth/setup', { form: { token: s.token, username: 'me', password: 'long enough pw', confirm: 'different pw!!' } })
  assert.equal(r.status, 400)
  assert.match(r.text, /do not match/)
  r = await http(s.base, '/api/auth/setup', { form: { token: s.token, username: 'me', password: 'long enough pw', confirm: 'long enough pw' } })
  assert.equal(r.status, 303)
  assert.equal(r.location, '/?settings=ai')
  assert.match(r.setCookie, /HttpOnly/)
  assert.match(r.setCookie, /SameSite=Lax/)
  assert.doesNotMatch(r.setCookie, /Secure/, 'plain http')
  const cookie = r.cookie
  assert.equal(mode(path.join(s.dir, 'owner.json')), '600')
  assert.ok(!fs.readFileSync(path.join(s.dir, 'owner.json'), 'utf8').includes('long enough pw'))

  // The link is spent.
  assert.equal((await http(s.base, `/setup?token=${s.token}`)).status, 303)
  assert.equal((await http(s.base, '/api/auth/setup', { body: { token: s.token, username: 'x', password: 'long enough pw' } })).status, 403)

  // Signed in.
  r = await http(s.base, '/api/me', { cookie })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { user: 'me', authMode: 'builtin', features: { ai: false, whoop: false, totem: false, usda: false, nutritionix: false } })
  assert.equal((await http(s.base, '/', { cookie })).status !== 401, true)

  // Signed out, a page goes to /login and keeps where it was going.
  r = await http(s.base, '/day?d=1')
  assert.equal(r.status, 303)
  assert.equal(r.location, '/login?next=%2Fday%3Fd%3D1')

  // A blank canvas: an empty log, and no outside link tried.
  r = await http(s.base, '/api/state', { cookie })
  assert.deepEqual(r.json.state.entries, {})
  r = await http(s.base, '/api/whoop', { cookie })
  assert.deepEqual(r.json, { fetchedAt: null, burn: {}, error: null, configured: false })
  r = await http(s.base, '/api/whoop/pull', { method: 'POST', cookie })
  assert.equal(r.json.configured, false)
  r = await http(s.base, '/api/entry', { method: 'POST', cookie, body: { entry: { id: 'e1', kind: 'food', date: '2026-10-01', updatedAt: '2026-10-01T10:00:00Z', data: { name: 'Egg', kcal: 72 } } } })
  assert.equal(r.status, 200)
  await new Promise(res => setTimeout(res, 200))
  assert.equal(fs.existsSync(path.join(s.dir, 'digest.json')), false, 'no digest file unless switched on')

  // AI off is a "set up AI" answer, not a crash.
  r = await http(s.base, '/api/ask', { method: 'POST', cookie, body: { text: 'two eggs' } })
  assert.equal(r.status, 503)
  assert.equal(r.json.setup, 'ai')
  assert.match(r.json.error, /Settings/)
  r = await http(s.base, '/api/settings/test', { method: 'POST', cookie, body: { what: 'totem' } })
  assert.equal(r.json.ok, false)

  // Settings: secrets go in and never come back out.
  r = await http(s.base, '/api/settings', { method: 'PUT', cookie, body: { usda: { key: 'usda-secret-123456' }, auth: { mode: 'proxy' } } }) // gitleaks:allow (test fixture)
  assert.equal(r.status, 200)
  assert.ok(!r.text.includes('usda-secret-123456'))
  assert.equal(r.json.usda.key.set, true)
  assert.equal(r.json.auth.mode, 'builtin', 'auth mode cannot be changed from the browser')
  assert.equal((await http(s.base, '/api/me', { cookie })).json.features.usda, true)

  // Bearer: a token from Settings opens the API and the MCP, not the pages.
  r = await http(s.base, '/api/settings/token', { method: 'POST', cookie, body: {} })
  const token = r.json.token
  assert.ok(token.length > 30)
  assert.ok(!(await http(s.base, '/api/settings', { cookie })).text.includes(token))
  r = await http(s.base, '/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
  assert.equal(r.status, 200)
  assert.ok(r.json.result.tools.length > 5)
  assert.equal((await http(s.base, '/api/state', { headers: { authorization: 'Bearer wrong' } })).status, 401)

  // Login: wrong, right, and Secure behind an https proxy.
  r = await http(s.base, '/api/auth/login', { body: { username: 'me', password: 'nope nope nope' } })
  assert.equal(r.status, 401)
  r = await http(s.base, '/api/auth/login', { form: { username: 'ME', password: 'long enough pw', next: '//evil.example' } })
  assert.equal(r.status, 303)
  assert.equal(r.location, '/', 'no open redirect')
  r = await http(s.base, '/api/auth/login', { body: { username: 'me', password: 'long enough pw' }, headers: { 'x-forwarded-proto': 'https' } })
  assert.match(r.setCookie, /; Secure/)

  // A tampered cookie is no cookie.
  assert.equal((await http(s.base, '/api/state', { cookie: `${cookie}x` })).status, 401)

  // Change password: the old session ends, the new one works.
  r = await http(s.base, '/api/auth/password', { method: 'POST', cookie, body: { current: 'long enough pw', next: 'a brand new password' } })
  assert.equal(r.status, 200)
  const fresh = r.cookie
  assert.equal((await http(s.base, '/api/state', { cookie })).status, 401)
  assert.equal((await http(s.base, '/api/state', { cookie: fresh })).status, 200)

  // Settings changes need a browser session: never the API token, which
  // stays good for everything else. Paths the server runs are not writable.
  const bearer = { authorization: `Bearer ${token}` }
  assert.equal((await http(s.base, '/api/settings', { method: 'PUT', headers: bearer, body: { usda: { key: 'nope-nope-nope' } } })).status, 403)
  assert.equal((await http(s.base, '/api/settings/test', { method: 'POST', headers: bearer, body: { what: 'usda' } })).status, 403)
  assert.equal((await http(s.base, '/api/settings/token', { method: 'POST', headers: bearer, body: {} })).status, 403)
  assert.equal((await http(s.base, '/api/settings', { headers: bearer })).status, 200, 'reading is fine')
  r = await http(s.base, '/api/settings', { method: 'PUT', cookie: fresh, body: { ai: { bin: '/bin/sh' }, totem: { envFile: '/etc/passwd' } } })
  assert.equal(r.status, 200)
  assert.notEqual(r.json.ai.bin.value, '/bin/sh')
  assert.equal(r.json.ai.bin.readOnly, true)
  const after = JSON.parse(fs.readFileSync(path.join(s.dir, 'settings.json'), 'utf8'))
  assert.equal(after.ai?.bin, undefined)
  assert.equal(after.totem?.envFile, undefined)

  // CSRF: a non-GET from another origin is refused, cookie or not; a JSON body
  // must say it is JSON; a bearer client that sends no Origin is unaffected.
  const entry = { entry: { id: 'e2', kind: 'food', date: '2026-10-01', updatedAt: '2026-10-01T11:00:00Z', data: { name: 'Toast', kcal: 80 } } }
  assert.equal((await http(s.base, '/api/entry', { cookie: fresh, body: entry, headers: { origin: 'https://evil.example' } })).status, 403)
  assert.equal((await http(s.base, '/api/entry', { cookie: fresh, body: entry, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
  assert.equal((await http(s.base, '/api/auth/logout', { cookie: fresh, form: {}, headers: { origin: 'null' } })).status, 403)
  assert.equal((await http(s.base, '/mcp', { headers: { ...bearer, origin: 'https://evil.example' }, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } })).status, 403)
  assert.equal((await http(s.base, '/api/entry', { cookie: fresh, body: entry, headers: { origin: s.base, 'sec-fetch-site': 'same-origin' } })).status, 200)
  r = await fetch(`${s.base}/api/entry`, { method: 'POST', headers: { cookie: fresh, 'content-type': 'text/plain' }, body: JSON.stringify(entry) })
  assert.equal(r.status, 415)
  r = await fetch(`${s.base}/mcp`, { method: 'POST', headers: { ...bearer, 'content-type': 'text/plain' }, body: '{"jsonrpc":"2.0","id":3,"method":"tools/list"}' })
  assert.equal(r.status, 415)
  assert.equal((await http(s.base, '/mcp', { headers: bearer, body: { jsonrpc: '2.0', id: 4, method: 'tools/list' } })).status, 200)

  // Open redirects: every form of "somewhere else" lands on /.
  for (const next of ['/\\evil.example', '//evil.example', '/\\/evil.example', 'https://evil.example', '/api/state']) {
    r = await http(s.base, '/api/auth/login', { form: { username: 'me', password: 'a brand new password', next } })
    assert.equal(r.location, '/', next)
  }
  r = await http(s.base, '/api/auth/login', { form: { username: 'me', password: 'a brand new password', next: '/day?d=1#x' } })
  assert.equal(r.location, '/day?d=1#x')

  // A malformed cookie is not a 500 anywhere.
  assert.equal((await http(s.base, '/login', { cookie: 'x=%E0%A4%A; krakatoa_session=%' })).status, 200)
  assert.equal((await http(s.base, '/api/state', { cookie: 'krakatoa_session=%E0%A4%A' })).status, 401)

  // Sign out ends the session itself: the cookie stops working even if kept.
  r = await http(s.base, '/api/auth/logout', { method: 'POST', cookie: fresh, body: {} })
  assert.match(r.setCookie, /Max-Age=0/)
  assert.equal(r.headers?.get?.('clear-site-data') ?? r.clearSiteData, '"cache"', 'HTTP-cached photos are dropped too')
  assert.equal((await http(s.base, '/api/state', { cookie: fresh })).status, 401)
})

test('the sign-in lockout cannot be dodged with forged forwarding headers', async () => {
  const s = await boot({ KRAKATOA_TRUST_PROXY: '0' })
  await http(s.base, '/api/auth/setup', { body: { token: s.token, username: 'me', password: 'long enough pw' } })
  for (let i = 0; i < 10; i++) {
    const r = await http(s.base, '/api/auth/login', { body: { username: 'me', password: 'wrong wrong' }, headers: { 'x-forwarded-for': `203.0.113.${i}`, 'cf-connecting-ip': `198.51.100.${i}` } })
    assert.equal(r.status, 401)
  }
  const r = await http(s.base, '/api/auth/login', { body: { username: 'me', password: 'long enough pw' }, headers: { 'x-forwarded-for': '203.0.113.99' } })
  assert.equal(r.status, 429, 'the socket address is what counts')
})

/* ------------------------------------------------------------------ proxy */

test('KRAKATOA_AUTH=proxy: no sign-in, no setup link', async () => {
  const s = await boot({ KRAKATOA_AUTH: 'proxy' })
  assert.equal(s.token, null)
  assert.match(s.log(), /left to the proxy/)
  assert.equal((await http(s.base, '/api/state')).status, 200)
  assert.equal((await http(s.base, '/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status, 200)
  assert.equal((await http(s.base, '/setup?token=x')).location, '/')
  const me = (await http(s.base, '/api/me')).json
  assert.equal(me.authMode, 'proxy')
  assert.equal(me.features.whoop, false)
})

/* --------------------------------------------------------------- existing */

test('existing install: same behaviour as before, with no new env', async () => {
  const s = await boot({}, { 'state.json': JSON.stringify({ version: 1, entries: { a: { id: 'a', kind: 'food', date: '2026-09-30', updatedAt: '2026-09-30T08:00:00Z', data: { name: 'Oats', kcal: 300 } } } }) })
  assert.equal(s.token, null)
  const stored = JSON.parse(fs.readFileSync(path.join(s.dir, 'settings.json'), 'utf8'))
  assert.equal(stored.auth.mode, 'proxy')
  assert.equal(stored.totem.enabled, true)
  assert.equal(stored.digestFile, true)
  let r = await http(s.base, '/api/state')
  assert.equal(r.status, 200)
  assert.ok(r.json.state.entries.a)
  r = await http(s.base, '/api/entry', { method: 'POST', body: { entry: { id: 'b', kind: 'food', date: '2026-10-01', updatedAt: '2026-10-01T08:00:00Z', data: { name: 'Egg', kcal: 72 } } } })
  assert.equal(r.status, 200)
  await new Promise(res => setTimeout(res, 300))
  assert.ok(fs.existsSync(path.join(s.dir, 'digest.json')), 'the digest file is still written')
})

test('proxy mode: settings change only from this machine, and a public bind is warned about', async () => {
  const nonLoopback = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)
  const s = await boot({ KRAKATOA_AUTH: 'proxy', KRAKATOA_BIND: '0.0.0.0' })
  assert.match(s.log(), /WARNING: proxy mode, but listening on 0\.0\.0\.0/)
  // From loopback (where cloudflared connects from): allowed.
  assert.equal((await http(s.base, '/api/settings', { method: 'PUT', body: { usda: { key: 'loopback-key-1' } } })).status, 200)
  if (!nonLoopback) { console.log('  (no non-loopback interface: skipped the LAN half)'); return }
  const lan = s.base.replace('127.0.0.1', nonLoopback.address)
  assert.equal((await http(lan, '/api/state')).status, 200, 'the log is readable, as before')
  assert.equal((await http(lan, '/api/settings')).status, 200, 'settings can be read')
  assert.equal((await http(lan, '/api/settings', { method: 'PUT', body: { usda: { key: 'lan-key-12345' } } })).status, 403) // gitleaks:allow (test fixture)
  assert.equal((await http(lan, '/api/settings/test', { method: 'POST', body: { what: 'usda' } })).status, 403)
  assert.equal((await http(lan, '/api/settings/token', { method: 'POST', body: {} })).status, 403)
})

test('existing install that already has an owner keeps built-in sign-in', async () => {
  const s = await boot({}, { 'state.json': '{"entries":{}}', 'owner.json': JSON.stringify({ username: 'me', passwordHash: 'scrypt$16384$8$1$AAAA$AAAA', sessionKey: 'k', sessionVersion: 1 }) })
  const stored = JSON.parse(fs.readFileSync(path.join(s.dir, 'settings.json'), 'utf8'))
  assert.equal(stored.auth, undefined)
  assert.equal((await http(s.base, '/api/state')).status, 401)
  assert.equal(s.token, null, 'there is an owner, so no setup link')
})

test('no chain menu file: the server, the menus and the MCP all work without it', async () => {
  const s = await boot({ KRAKATOA_AUTH: 'proxy', KRAKATOA_RESTAURANTS_FILE: path.join(os.tmpdir(), 'krakatoa-no-such-menus.json') })
  let r = await http(s.base, '/api/restaurants')
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { chains: [], built: false })
  r = await http(s.base, '/api/restaurants')
  assert.equal(r.status, 200, 'and again')
  const call = async (name, args = {}) => (await http(s.base, '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } })).json.result
  const menu = await call('get_menu')
  assert.deepEqual(menu.structuredContent.chains, [])
  assert.match(menu.structuredContent.note, /No chain menus/)
  const found = await call('search_foods', { query: 'egg' })
  assert.ok(!found.isError, 'search still works from the basics')
  const list = (await http(s.base, '/mcp', { body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } })).json.result.tools
  assert.ok(!/Chipotle|McDonald|Panera|Culver|Bibibop/.test(JSON.stringify(list)), 'no tool promises a chain that is not there')
  assert.doesNotMatch(s.log(), /restaurants|ENOENT|Error/i, 'nothing logged about the missing file')
})

test('existing install with KRAKATOA_AUTH=builtin asks for setup', async () => {
  const s = await boot({ KRAKATOA_AUTH: 'builtin' }, { 'state.json': '{"entries":{}}' })
  assert.ok(s.token)
  assert.equal((await http(s.base, '/api/state')).status, 401)
})

;(async () => {
  for (const [name, fn] of steps) {
    try { await fn(); passed++ } catch (e) {
      console.error(`FAIL  ${name}\n      ${e.stack || e.message}`)
      process.exitCode = 1
    }
  }
  for (const p of procs) p.kill()
  console.log(`install (fresh, proxy, existing): ${passed} passed`)
})()
