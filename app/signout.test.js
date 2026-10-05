// Signing out takes the log off the device, after a flush and, if anything
// would be lost, a confirmation that says how much.
import assert from 'node:assert/strict'
import { signOutDevice, unsyncedCount, lossMessage, clearDeviceData, makeLocalPersist, clearSignedOut, onSignedOutElsewhere, isSignedOut, SIGNED_OUT_KEY, SIGNING_OUT_KEY } from './src/lib/signout.js'

let passed = 0
const tests = []
const test = (name, fn) => tests.push([name, fn])

function storage(init = {}) {
  const m = new Map(Object.entries(init))
  return {
    get length() { return m.size },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    keys: () => [...m.keys()],
  }
}
const e = (id, at) => ({ id, kind: 'food', updatedAt: at, data: { name: id } })
const LOG = { entries: { a: e('a', '2026-10-01T08:00:00Z'), b: e('b', '2026-10-01T09:00:00Z'), c: e('c', '2026-10-01T10:00:00Z') } }

function fakeCaches(names) {
  const set = new Set(names)
  return { keys: async () => [...set], delete: async (n) => set.delete(n), names: () => [...set] }
}
function fakeIdb(names) {
  const set = new Set(names)
  return { databases: async () => [...set].map(name => ({ name })), deleteDatabase: (n) => set.delete(n), names: () => [...set] }
}
const json = (status, body) => ({ ok: status < 400, status, json: async () => body })

/* A server that accepts the push (the normal, online case). */
function onlineServer(calls) {
  return async (url, init = {}) => {
    calls.push(`${init.method || 'GET'} ${url}`)
    if (url === '/api/state' && init.method === 'PUT') return json(200, { state: { entries: JSON.parse(init.body).state.entries } })
    if (url === '/api/auth/logout') return json(200, { ok: true })
    return json(404, {})
  }
}

test('online: flushes, does not ask, signs out and clears everything but the shell', async () => {
  const calls = []
  const ls = storage({ 'krakatoa.state.v1': JSON.stringify(LOG), 'fuel.state.v1': '{}', 'other.app': 'keep' })
  const ss = storage({ 'krakatoa.draft': 'x' })
  const cachesApi = fakeCaches(['krakatoa-shell-v1', 'krakatoa-photos'])
  const idb = fakeIdb(['krakatoa'])
  let asked = 0
  const flag = {}
  const out = await signOutDevice({ fetchFn: onlineServer(calls), storage: ls, session: ss, cachesApi, idb, confirmFn: () => { asked++; return true }, flagTarget: flag })
  assert.deepEqual(out, { signedOut: true, unsynced: 0 })
  assert.equal(asked, 0, 'nothing to lose, so no question')
  assert.deepEqual(calls, ['PUT /api/state', 'POST /api/auth/logout'], 'flush first, then sign out')
  assert.deepEqual(ls.keys().sort(), ['krakatoa.signedOut', 'other.app'], 'only this app\'s keys go; the marker stays')
  assert.deepEqual(ss.keys(), [])
  assert.deepEqual(cachesApi.names(), ['krakatoa-shell-v1'], 'the shell cache stays')
  assert.deepEqual(idb.names(), [])
  assert.equal(flag.__krakatoaSignedOut, true)
})

test('server has an older copy: asks with the count, and keeps everything on "no"', async () => {
  const calls = []
  const ls = storage({ 'krakatoa.state.v1': JSON.stringify(LOG) })
  // The push fails (say 401 because the session expired) but a read works and
  // shows the server missing c and holding an older b.
  const fetchFn = async (url, init = {}) => {
    calls.push(`${init.method || 'GET'} ${url}`)
    if (init.method === 'PUT') return json(401, {})
    if (url === '/api/state') return json(200, { state: { entries: { a: LOG.entries.a, b: e('b', '2026-10-01T07:00:00Z') } } })
    return json(200, {})
  }
  let message = null
  const out = await signOutDevice({ fetchFn, storage: ls, confirmFn: (m) => { message = m; return false } })
  assert.deepEqual(out, { signedOut: false, unsynced: 2 })
  assert.match(message, /^2 entries have not reached the server/)
  assert.ok(ls.getItem('krakatoa.state.v1'), 'kept')
  assert.ok(!calls.includes('POST /api/auth/logout'), 'not signed out')
})

test('fully offline: warns without a count, then keeps everything because sign-out never landed', async () => {
  const ls = storage({ 'krakatoa.state.v1': JSON.stringify(LOG) })
  const fetchFn = async () => { throw new TypeError('Failed to fetch') }
  let message = null
  const out = await signOutDevice({ fetchFn, storage: ls, confirmFn: (m) => { message = m; return true } })
  assert.equal(out.signedOut, false)
  assert.equal(out.unsynced, null)
  assert.match(message, /cannot reach the server/)
  assert.ok(ls.getItem('krakatoa.state.v1'), 'kept: the session is still valid')
})

test('the store refuses writes while the marker is set, even in a tab with no flag', () => {
  const ls = storage({ [SIGNED_OUT_KEY]: 'x' })
  assert.equal(makeLocalPersist({ storage: ls, flagTarget: {}, key: 'krakatoa.state.v1' })(LOG), false)
})

test('an empty device signs out without a question', async () => {
  const calls = []
  const out = await signOutDevice({ fetchFn: onlineServer(calls), storage: storage(), confirmFn: () => { throw new Error('asked') } })
  assert.deepEqual(out, { signedOut: true, unsynced: 0 })
  assert.deepEqual(calls, ['POST /api/auth/logout'])
})

test('the arithmetic and the wording', async () => {
  assert.equal(unsyncedCount(LOG.entries, LOG.entries), 0)
  assert.equal(unsyncedCount(LOG.entries, {}), 3)
  assert.equal(unsyncedCount({ a: e('a', '2026-10-02T00:00:00Z') }, { a: e('a', '2026-10-01T00:00:00Z') }), 1)
  assert.equal(unsyncedCount({ a: e('a', '2026-10-01T00:00:00Z') }, { a: e('a', '2026-10-02T00:00:00Z') }), 0, 'server newer is not a loss')
  assert.match(lossMessage(1), /^1 entry has/)
  await clearDeviceData({}) // nothing available: no throw
})

for (const [label, failure] of [
  ['a 503', async (url, init = {}) => (url === '/api/auth/logout' ? json(503, {}) : onlineServer([])(url, init))],
  ['a network error', async (url, init = {}) => { if (url === '/api/auth/logout') throw new TypeError('Failed to fetch'); return onlineServer([])(url, init) }],
]) {
  test(`logout failing with ${label}: still signed in, nothing cleared, a retry offered`, async () => {
    const ls = storage({ 'krakatoa.state.v1': JSON.stringify(LOG) })
    const cachesApi = fakeCaches(['krakatoa-shell-v1', 'krakatoa-photos'])
    const flag = {}
    const posted = []
    const out = await signOutDevice({ fetchFn: failure, storage: ls, cachesApi, confirmFn: () => true, flagTarget: flag, channel: { postMessage: (m) => posted.push(m) } })
    assert.equal(out.signedOut, false)
    assert.match(out.error, /did not reach the server.*Try again/)
    assert.ok(ls.getItem('krakatoa.state.v1'), 'the log is still here')
    assert.equal(ls.getItem(SIGNED_OUT_KEY), null, 'no marker')
    assert.equal(flag.__krakatoaSignedOut, undefined)
    assert.deepEqual(cachesApi.names().sort(), ['krakatoa-photos', 'krakatoa-shell-v1'])
    assert.deepEqual(posted, ['signing-out', 'resumed'], 'other tabs are frozen, then let go; never told "signed out"')
    assert.equal(ls.getItem(SIGNING_OUT_KEY), null)
  })
}

test('an already-ended session (401 on logout) counts as signed out', async () => {
  const ls = storage({ 'krakatoa.state.v1': JSON.stringify(LOG) })
  const fetchFn = async (url, init = {}) => (url === '/api/auth/logout' ? json(401, {}) : onlineServer([])(url, init))
  const out = await signOutDevice({ fetchFn, storage: ls, confirmFn: () => true })
  assert.equal(out.signedOut, true)
  assert.equal(ls.getItem('krakatoa.state.v1'), null)
})

test('two tabs sharing storage: once one signs out, the other cannot write the log back', async () => {
  const shared = storage()
  const tabA = {}
  const tabB = {}
  const persistA = makeLocalPersist({ storage: shared, flagTarget: tabA, key: 'krakatoa.state.v1' })
  const persistB = makeLocalPersist({ storage: shared, flagTarget: tabB, key: 'krakatoa.state.v1' })
  assert.equal(persistA(LOG), true)
  assert.equal(persistB(LOG), true)
  // Tab B is told by the channel (and, failing that, by the storage event).
  let toldByChannel = 0
  let toldByStorage = 0
  const listeners = {}
  class FakeChannel { constructor() { FakeChannel.last = this } postMessage() {} close() {} }
  const stopB = onSignedOutElsewhere({ win: { BroadcastChannel: FakeChannel, addEventListener: (t, f) => { listeners[t] = f }, removeEventListener: () => {} }, fn: () => toldByChannel++ })
  const stopB2 = onSignedOutElsewhere({ win: { addEventListener: (t, f) => { listeners.s2 = f }, removeEventListener: () => {} }, fn: () => toldByStorage++ })
  const out = await signOutDevice({ fetchFn: onlineServer([]), storage: shared, confirmFn: () => true, flagTarget: tabA, channel: { postMessage: (m) => FakeChannel.last.onmessage({ data: m }) } })
  assert.equal(out.signedOut, true)
  listeners.s2({ key: SIGNED_OUT_KEY, newValue: shared.getItem(SIGNED_OUT_KEY) })
  assert.equal(toldByChannel, 1)
  assert.equal(toldByStorage, 1)
  // Tab B's pending sync lands after the clear: refused, by the shared marker alone.
  assert.equal(isSignedOut(shared, tabB), true)
  assert.equal(persistB({ entries: { late: e('late', '2026-10-02T00:00:00Z') } }), false)
  assert.equal(shared.getItem('krakatoa.state.v1'), null, 'the log stays gone')
  // The next sign-in clears the marker, in either tab, and writes work again.
  clearSignedOut(shared, tabA)
  assert.equal(persistB(LOG), true)
  assert.equal(persistA(LOG), true)
  stopB(); stopB2()
})

test('two tabs: an entry the other tab logs during the flush is frozen out, not silently cleared', async () => {
  const shared = storage({ 'krakatoa.state.v1': JSON.stringify(LOG) })
  const tabB = {}
  const persistB = makeLocalPersist({ storage: shared, flagTarget: tabB, key: 'krakatoa.state.v1' })
  const messages = []
  let wroteDuringFlush = null
  let readAtFlush = null
  // Tab B logs a new entry while tab A's flush request is in flight.
  const fetchFn = async (url, init = {}) => {
    if (url === '/api/state' && init.method === 'PUT') {
      readAtFlush = Object.keys(JSON.parse(init.body).state.entries)
      wroteDuringFlush = persistB({ entries: { ...LOG.entries, late: e('late', '2026-10-03T00:00:00Z') } })
    }
    return onlineServer([])(url, init)
  }
  const out = await signOutDevice({ fetchFn, storage: shared, confirmFn: () => { throw new Error('nothing unsynced was read, so no question') }, flagTarget: {}, channel: { postMessage: (m) => messages.push(m) } })
  assert.equal(out.signedOut, true)
  assert.equal(wroteDuringFlush, false, 'tab B was frozen before tab A read storage')
  assert.deepEqual(readAtFlush.sort(), ['a', 'b', 'c'])
  assert.deepEqual(messages, ['signing-out', 'signed-out'])
})

test('two tabs: when sign-out fails, the freeze lifts and the other tab writes again', async () => {
  const shared = storage({ 'krakatoa.state.v1': JSON.stringify(LOG) })
  const persistB = makeLocalPersist({ storage: shared, flagTarget: {}, key: 'krakatoa.state.v1' })
  let during = null
  const fetchFn = async (url, init = {}) => {
    if (url === '/api/auth/logout') { during = persistB(LOG); return json(503, {}) }
    return onlineServer([])(url, init)
  }
  const messages = []
  const out = await signOutDevice({ fetchFn, storage: shared, confirmFn: () => true, channel: { postMessage: (m) => messages.push(m) } })
  assert.equal(out.signedOut, false)
  assert.equal(during, false, 'frozen while the logout was in flight')
  assert.equal(shared.getItem(SIGNING_OUT_KEY), null, 'the freeze is lifted')
  assert.equal(persistB({ entries: { ...LOG.entries, after: e('after', '2026-10-03T00:00:00Z') } }), true)
  assert.deepEqual(messages, ['signing-out', 'resumed'])
  // Declining the loss question lifts it too.
  const ls2 = storage({ 'krakatoa.state.v1': JSON.stringify(LOG) })
  await signOutDevice({ fetchFn: async () => { throw new TypeError('offline') }, storage: ls2, confirmFn: () => false })
  assert.equal(ls2.getItem(SIGNING_OUT_KEY), null)
})

test('a freeze left by a tab that died mid-sign-out expires', () => {
  const ls = storage({ [SIGNING_OUT_KEY]: new Date(Date.now() - 5 * 60 * 1000).toISOString() })
  assert.equal(isSignedOut(ls, {}), false)
  ls.setItem(SIGNING_OUT_KEY, new Date().toISOString())
  assert.equal(isSignedOut(ls, {}), true)
})

for (const [name, fn] of tests) {
  try { await fn(); passed++ } catch (err) { console.error(`FAIL  ${name}\n      ${err.stack}`); process.exitCode = 1 }
}
console.log(`sign-out: ${passed} passed`)
