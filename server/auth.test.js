/*
 * node server/auth.test.js
 *
 * The sign-in and settings modules on their own, without a server: password
 * hashing, the session cookie, the one-time setup token, bearer tokens, the
 * lockout, and what Settings will and will not let the browser see or write.
 * server/install.test.js boots a real server for the end-to-end paths.
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const A = require('./auth.js')
const S = require('./settings.js')

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++ } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`)
    process.exitCode = 1
  }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'krakatoa-auth-'))
const mode = (f) => (fs.statSync(f).mode & 0o777).toString(8)
const req = (headers = {}) => ({ headers, socket: {} })

test('a password hash verifies the password and nothing else', () => {
  const h = A.hashPassword('correct horse battery')
  assert.match(h, /^scrypt\$16384\$8\$1\$/)
  assert.ok(!h.includes('correct'))
  assert.equal(A.verifyPassword('correct horse battery', h), true)
  assert.equal(A.verifyPassword('correct horse batterz', h), false)
  assert.equal(A.verifyPassword('anything', 'not-a-hash'), false)
  assert.notEqual(A.hashPassword('same'), A.hashPassword('same'), 'salted')
})

test('the setup token works once, and only before an owner exists', () => {
  const auth = A.makeAuth({ dataDir: tmp() })
  assert.equal(auth.hasOwner(), false)
  const t = auth.issueSetupToken()
  assert.ok(t.length >= 30)
  assert.equal(auth.checkSetupToken('wrong'), false)
  assert.equal(auth.checkSetupToken(''), false)
  assert.equal(auth.checkSetupToken(t), true)
  assert.throws(() => auth.createOwner({ token: 'wrong', username: 'me', password: 'long enough pw' }), /not valid/)
  assert.throws(() => auth.createOwner({ token: t, username: 'me', password: 'short' }), /10 characters/)
  auth.createOwner({ token: t, username: 'me', password: 'long enough pw' })
  assert.equal(auth.hasOwner(), true)
  assert.equal(auth.checkSetupToken(t), false, 'spent')
  assert.equal(auth.issueSetupToken(), null, 'no new token once there is an owner')
  assert.throws(() => auth.createOwner({ token: t, username: 'x', password: 'long enough pw' }), /already has an owner/)
})

test('the owner file is private and holds a hash, not the password', () => {
  const dir = tmp()
  const auth = A.makeAuth({ dataDir: dir })
  auth.createOwner({ token: auth.issueSetupToken(), username: 'me', password: 'long enough pw' })
  assert.equal(mode(auth.file), '600')
  const raw = fs.readFileSync(auth.file, 'utf8')
  assert.ok(!raw.includes('long enough pw'))
  assert.match(raw, /scrypt\$/)
})

test('login checks username (any case) and password', () => {
  const auth = A.makeAuth({ dataDir: tmp() })
  auth.createOwner({ token: auth.issueSetupToken(), username: 'Me', password: 'long enough pw' })
  assert.deepEqual(auth.login('me', 'long enough pw'), { username: 'Me' })
  assert.equal(auth.login('me', 'wrong password'), null)
  assert.equal(auth.login('someone', 'long enough pw'), null)
})

test('a session cookie round-trips, and a forged or expired one does not', () => {
  const auth = A.makeAuth({ dataDir: tmp() })
  auth.createOwner({ token: auth.issueSetupToken(), username: 'me', password: 'long enough pw' })
  const v = auth.issueSession('me')
  assert.deepEqual(auth.readSession(req({ cookie: `${A.COOKIE}=${v}` })), { username: 'me' })
  assert.equal(auth.readSession(req({ cookie: `${A.COOKIE}=${v}x` })), null, 'bad mac')
  const [payload, mac] = v.split('.')
  const forged = Buffer.from(JSON.stringify({ u: 'admin', exp: Date.now() + 1e9 })).toString('base64url')
  assert.equal(auth.readSession(req({ cookie: `${A.COOKIE}=${forged}.${mac}` })), null, 'payload swapped')
  assert.equal(auth.readSession(req({ cookie: `${A.COOKIE}=${payload}.${mac}` }), Date.now() + 31 * 864e5), null, 'expired')
  assert.equal(auth.readSession(req({})), null)
})

test("the iPhone app's session header is the same session as the cookie", () => {
  const auth = A.makeAuth({ dataDir: tmp() })
  auth.createOwner({ token: auth.issueSetupToken(), username: 'me', password: 'long enough pw' })
  const v = auth.issueSession('me')
  assert.deepEqual(auth.readSession(req({ [A.SESSION_HEADER]: v })), { username: 'me' })
  assert.equal(auth.readSession(req({ [A.SESSION_HEADER]: `${v}x` })), null, 'bad mac')
  assert.equal(auth.readSession(req({ [A.SESSION_HEADER]: '' })), null)
  // A cookie, when there is one, is what counts: a bad cookie is not rescued by a header.
  assert.equal(auth.readSession(req({ cookie: `${A.COOKIE}=nope`, [A.SESSION_HEADER]: v })), null)
  auth.revokeSessions()
  assert.equal(auth.readSession(req({ [A.SESSION_HEADER]: v })), null, 'sign-out ends it too')
  assert.equal(A.isNativeClient(req({ 'x-krakatoa-client': 'native' })), true)
  assert.equal(A.isNativeClient(req({})), false)
})

test('the cookie is httpOnly and SameSite=Lax, and Secure only when asked', () => {
  const auth = A.makeAuth({ dataDir: tmp() })
  const plain = auth.cookie('v', { secure: false })
  assert.match(plain, /HttpOnly/)
  assert.match(plain, /SameSite=Lax/)
  assert.match(plain, /Path=\//)
  assert.doesNotMatch(plain, /Secure/)
  assert.match(auth.cookie('v', { secure: true }), /; Secure/)
  assert.match(auth.cookie('', { clear: true }), /Max-Age=0/)
})

test('https is recognised directly, through a proxy header, or from the public URL', () => {
  assert.equal(A.isHttps(req({})), false)
  assert.equal(A.isHttps({ headers: {}, socket: { encrypted: true } }), true)
  assert.equal(A.isHttps(req({ 'x-forwarded-proto': 'https' })), true)
  assert.equal(A.isHttps(req({ 'x-forwarded-proto': 'http' })), false)
  assert.equal(A.isHttps(req({}), 'https://food.example.com'), true)
})

test('changing the password signs out every existing session', () => {
  const auth = A.makeAuth({ dataDir: tmp() })
  auth.createOwner({ token: auth.issueSetupToken(), username: 'me', password: 'long enough pw' })
  const before = auth.issueSession('me')
  assert.throws(() => auth.changePassword('wrong', 'a new long password'), /current password is wrong/)
  auth.changePassword('long enough pw', 'a new long password')
  assert.equal(auth.readSession(req({ cookie: `${A.COOKIE}=${before}` })), null)
  assert.equal(auth.login('me', 'long enough pw'), null)
  assert.ok(auth.login('me', 'a new long password'))
})

test('bearer tokens match exactly and only when one is configured', () => {
  const auth = A.makeAuth({ dataDir: tmp() })
  assert.equal(auth.bearerOk(req({ authorization: 'Bearer abc' }), ['abc']), true)
  assert.equal(auth.bearerOk(req({ authorization: 'bearer abc' }), ['abc']), true)
  assert.equal(auth.bearerOk(req({ authorization: 'Bearer abd' }), ['abc']), false)
  assert.equal(auth.bearerOk(req({ authorization: 'Bearer ' }), ['', null]), false)
  assert.equal(auth.bearerOk(req({}), ['abc']), false)
})

test('ten failed sign-ins lock an address out, and success forgives', () => {
  const lim = A.makeLimiter({ max: 3, windowMs: 1000 })
  for (let i = 0; i < 3; i++) lim.fail('a', 0)
  assert.equal(lim.blocked('a', 10), true)
  assert.equal(lim.blocked('b', 10), false)
  assert.equal(lim.blocked('a', 2000), false, 'the window passes')
  lim.fail('c', 0); lim.reset('c')
  assert.equal(lim.blocked('c', 1), false)
})

/* ------------------------------------------------------------- settings */

test('a fresh data dir gets settings with every outside link off', () => {
  const dir = tmp()
  const s = S.makeSettings({ dataDir: dir, env: { HOME: dir }, log: () => {} })
  assert.deepEqual(s.migrate(), { created: true, existing: false, auth: 'builtin' })
  assert.equal(mode(s.file), '600')
  const e = s.effective()
  assert.equal(e.auth.mode, 'builtin')
  assert.equal(e.totem.enabled.value, false)
  assert.equal(S.totemConfig(e), null)
  assert.equal(e.digestFile.value, false)
  assert.equal(e.usda.value, '')
})

test('an existing install keeps the bridge, the digest and proxy sign-in', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'state.json'), '{"entries":{}}')
  fs.writeFileSync(path.join(dir, 'totem.env'), 'OTHER=1\nBRIDGE_SECRET="s3cret"\n')
  const s = S.makeSettings({ dataDir: dir, env: { HOME: dir, KRAKATOA_TOTEM_ENV: path.join(dir, 'totem.env') }, log: () => {} })
  assert.equal(s.migrate().existing, true)
  const e = s.effective()
  assert.equal(e.auth.mode, 'proxy')
  assert.equal(e.digestFile.value, true)
  assert.deepEqual(S.totemConfig(e), { url: 'http://127.0.0.1:8787', secret: 's3cret', habit: 'krakatoa' })
  assert.equal(s.migrate().created, false, 'runs once')
})

test('the environment beats settings, which beat the old config.json', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'config.json'), '{"usdaKey":"from-config","nutritionixId":"i","nutritionixKey":"k"}')
  const s = S.makeSettings({ dataDir: dir, env: {}, log: () => {} })
  s.migrate()
  assert.deepEqual([s.effective().usda.value, s.effective().usda.from], ['from-config', 'config.json'])
  s.save({ usda: { key: 'from-settings' } })
  assert.equal(s.effective().usda.value, 'from-settings')
  const env = S.makeSettings({ dataDir: dir, env: { KRAKATOA_USDA_KEY: 'from-env', KRAKATOA_AUTH: 'proxy' }, log: () => {} }).effective()
  assert.deepEqual([env.usda.value, env.usda.from], ['from-env', 'env'])
  assert.equal(env.auth.mode, 'proxy')
  assert.equal(env.nutritionix.key.value, 'k')
})

test('KRAKATOA_AUTH=builtin forces sign-in even on a migrated install', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'state.json'), '{}')
  S.makeSettings({ dataDir: dir, env: {}, log: () => {} }).migrate()
  assert.equal(S.makeSettings({ dataDir: dir, env: { KRAKATOA_AUTH: 'builtin' } }).effective().auth.mode, 'builtin')
})

test('the browser sees secrets masked and where each value came from', () => {
  const dir = tmp()
  const s = S.makeSettings({ dataDir: dir, env: { KRAKATOA_NUTRITIONIX_ID: 'env-id' }, log: () => {} })
  s.migrate()
  s.save({ usda: { key: 'abcdefghijklmnop' }, ai: { apiKey: 'sk-ant-123456789' }, apiToken: 'tok-1234567890' }) // gitleaks:allow (test fixture)
  const v = S.publicView(s.effective())
  const all = JSON.stringify(v)
  for (const secret of ['abcdefghijklmnop', 'sk-ant-123456789', 'tok-1234567890']) assert.ok(!all.includes(secret), secret)
  assert.equal(v.usda.key.value, '••••mnop', 'only the last four characters')
  assert.equal(v.usda.key.set, true)
  assert.equal(v.nutritionix.id.locked, true)
  assert.equal(v.nutritionix.id.env, 'KRAKATOA_NUTRITIONIX_ID')
})

test('the browser can only write known fields, and a mask is not a new secret', () => {
  assert.deepEqual(S.cleanPatch({ auth: { mode: 'proxy' }, evil: 1, usda: { key: 'k1', other: 'x' } }), { usda: { key: 'k1' } })
  assert.deepEqual(S.cleanPatch({ usda: { key: '••••mnop' } }), {})
  assert.deepEqual(S.cleanPatch({ ai: { bin: '/tmp/evil', labelModel: 'm' }, totem: { envFile: '/etc/passwd' } }), { ai: { labelModel: 'm' } }, 'paths the server runs or reads are not browser-editable')
  assert.deepEqual(S.cleanPatch({ usda: { key: null } }), { usda: { key: null } })
  assert.deepEqual(S.cleanPatch({ totem: { enabled: 'yes' } }), {})
  assert.deepEqual(S.cleanPatch({ totem: { enabled: true } }), { totem: { enabled: true } })
  assert.deepEqual(S.cleanPatch({ ai: { askEffort: 'max' } }), {})
  assert.throws(() => S.cleanPatch({ publicUrl: 'javascript:alert(1)' }), /not a URL/)
  assert.deepEqual(S.cleanPatch({ publicUrl: 'https://food.example.com' }), { publicUrl: 'https://food.example.com' })
})

test('a stored API key reaches the CLI environment; none means the server env as is', () => {
  const dir = tmp()
  const s = S.makeSettings({ dataDir: dir, env: {}, log: () => {} })
  s.migrate()
  assert.equal(S.aiEnv(s.effective()), undefined)
  s.save({ ai: { apiKey: 'sk-ant-xyz' } })
  assert.equal(S.aiEnv(s.effective()).ANTHROPIC_API_KEY, 'sk-ant-xyz')
})

test('saving keeps the file private and clears a field given null', () => {
  const dir = tmp()
  const s = S.makeSettings({ dataDir: dir, env: {}, log: () => {} })
  s.migrate()
  s.save({ usda: { key: 'k' } })
  assert.equal(mode(s.file), '600')
  s.save({ usda: { key: null } })
  assert.equal(s.stored().usda.key, undefined)
})

test('a malformed cookie is no session, and never throws', () => {
  const auth = A.makeAuth({ dataDir: tmp() })
  auth.createOwner({ token: auth.issueSetupToken(), username: 'me', password: 'long enough pw' })
  assert.doesNotThrow(() => A.parseCookies('other=%E0%A4%A; x=%'))
  assert.equal(auth.readSession(req({ cookie: `other=%E0%A4%A; ${A.COOKIE}=%E0%A4%A` })), null)
  const good = auth.issueSession('me')
  assert.deepEqual(auth.readSession(req({ cookie: `junk=%; ${A.COOKIE}=${good}` })), { username: 'me' }, 'a bad neighbour does not break ours')
})

test('signing out ends every session, including copies of the cookie', () => {
  const auth = A.makeAuth({ dataDir: tmp() })
  auth.createOwner({ token: auth.issueSetupToken(), username: 'me', password: 'long enough pw' })
  const a = auth.issueSession('me')
  auth.revokeSessions()
  assert.equal(auth.readSession(req({ cookie: `${A.COOKIE}=${a}` })), null)
  const b = auth.issueSession('me')
  assert.deepEqual(auth.readSession(req({ cookie: `${A.COOKIE}=${b}` })), { username: 'me' }, 'a new sign-in works')
})

test('the lockout has a global cap and does not grow without bound', () => {
  const lim = A.makeLimiter({ max: 10, globalMax: 20, windowMs: 1000, maxKeys: 50 })
  for (let i = 0; i < 20; i++) lim.fail(`10.0.0.${i}`, 0)
  assert.equal(lim.blocked('10.9.9.9', 1), true, 'rotating addresses hits the global cap')
  assert.equal(lim.blocked('10.9.9.9', 2000), false, 'and it expires')
  const big = A.makeLimiter({ max: 10, globalMax: 1e9, windowMs: 1000, maxKeys: 50 })
  for (let i = 0; i < 500; i++) big.fail(`k${i}`, 0)
  assert.ok(big.size() <= 50, `bounded: ${big.size()}`)
  big.fail('late', 5000)
  for (let i = 0; i < 49; i++) big.fail(`m${i}`, 5000)
  assert.ok(big.size() <= 50)
})

test('loopback is recognised in every form Node reports it', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.53']) assert.equal(A.isLoopback(a), true, a)
  for (const a of ['10.0.0.2', '100.64.1.1', '::ffff:192.168.1.5', '', undefined]) assert.equal(A.isLoopback(a), false, String(a))
})

test('an existing install that already has an owner never falls back to proxy', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'state.json'), '{}')
  fs.writeFileSync(path.join(dir, 'owner.json'), '{"username":"me","passwordHash":"scrypt$x"}')
  const s = S.makeSettings({ dataDir: dir, env: { HOME: dir }, log: () => {} })
  assert.equal(s.migrate().auth, 'builtin')
  assert.equal(s.effective().auth.mode, 'builtin')
  assert.equal(s.effective().totem.enabled.value, true, 'the bridge is still kept on')
})

test("Totem's .env has no default; an upgraded install records it only if it exists", () => {
  const fresh = tmp()
  const s0 = S.makeSettings({ dataDir: fresh, env: { HOME: fresh }, log: () => {} })
  s0.migrate()
  assert.equal(s0.effective().totem.envFile.value, '')

  const home = tmp()
  const old = tmp()
  fs.writeFileSync(path.join(old, 'state.json'), '{}')
  const s1 = S.makeSettings({ dataDir: old, env: { HOME: home }, log: () => {} })
  s1.migrate()
  assert.equal(s1.stored().totem.envFile, undefined, 'no file, nothing recorded')
  assert.equal(S.totemConfig(s1.effective()), null)

  const old2 = tmp()
  fs.writeFileSync(path.join(old2, 'state.json'), '{}')
  fs.mkdirSync(path.join(home, 'projects', 'personal-assistant'), { recursive: true })
  fs.writeFileSync(path.join(home, 'projects', 'personal-assistant', '.env'), 'BRIDGE_SECRET=abc\n')
  const s2 = S.makeSettings({ dataDir: old2, env: { HOME: home }, log: () => {} })
  s2.migrate()
  assert.equal(s2.stored().totem.envFile, path.join(home, 'projects', 'personal-assistant', '.env'))
  assert.equal(S.totemConfig(s2.effective()).secret, 'abc')
})

test("a new bridge URL does not inherit the old secret", () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'state.json'), '{}')
  fs.writeFileSync(path.join(dir, 'totem.env'), 'BRIDGE_SECRET=from-file\n')
  const s = S.makeSettings({ dataDir: dir, env: { HOME: dir, KRAKATOA_TOTEM_ENV: path.join(dir, 'totem.env') }, log: () => {} })
  s.migrate()
  assert.equal(S.totemConfig(s.effective()).secret, 'from-file')
  // Same URL: nothing changes.
  s.save(S.guardTotemUrl(S.cleanPatch({ totem: { url: 'http://127.0.0.1:8787/' } }), s.effective()))
  assert.equal(S.totemConfig(s.effective()).secret, 'from-file')
  // A different URL with no secret: the bridge has none until one is entered.
  s.save(S.guardTotemUrl(S.cleanPatch({ totem: { url: 'https://elsewhere.example' } }), s.effective()))
  assert.equal(S.totemConfig(s.effective()), null)
  assert.equal(s.effective().totem.secret.value, '')
  s.save(S.guardTotemUrl(S.cleanPatch({ totem: { secret: 'typed-for-new-url' } }), s.effective()))
  assert.equal(S.totemConfig(s.effective()).secret, 'typed-for-new-url')
  // A URL change that carries its own secret keeps it.
  s.save(S.guardTotemUrl(S.cleanPatch({ totem: { url: 'https://third.example', secret: 'third' } }), s.effective()))
  assert.deepEqual([S.totemConfig(s.effective()).url, S.totemConfig(s.effective()).secret], ['https://third.example', 'third'])
  // Clearing the stored URL is a change of destination too: the secret goes.
  s.save(S.guardTotemUrl(S.cleanPatch({ totem: { url: null } }), s.effective()))
  assert.equal(s.stored().totem.url, undefined)
  assert.equal(s.stored().totem.secret, undefined, 'the stored secret is dropped')
  assert.equal(s.stored().totem.ownSecretOnly, true)
  assert.equal(S.totemConfig(s.effective()), null, 'not even the .env secret goes to the default URL')
  // Clearing again, with nothing stored, changes nothing.
  assert.deepEqual(S.guardTotemUrl({ totem: { url: null } }, s.effective()), { totem: { url: null } })
  s.save(S.guardTotemUrl(S.cleanPatch({ totem: { url: 'https://third.example', secret: 'third' } }), s.effective()))
  // Env BRIDGE_SECRET is not carried to a changed URL either.
  const e = S.makeSettings({ dataDir: dir, env: { BRIDGE_SECRET: 'env-secret' } }).effective()
  assert.equal(e.totem.secret.value, 'third')
})

console.log(`auth + settings: ${passed} passed`)
