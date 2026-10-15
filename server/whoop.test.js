/*
 * node server/whoop.test.js
 *
 * The WHOOP pull against a stand-in Bushido on a loopback port: what is sent
 * (method, path, token, body), what is kept from the answer, that Bushido's
 * error text arrives verbatim, and that with no Bushido configured nothing is
 * sent at all. The arithmetic (`balanceFor`) is pinned in app/whoop.test.js.
 */

const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const W = require('./whoop.js')

let passed = 0
const tests = []
const test = (name, fn) => tests.push([name, fn])

/* A fake Bushido. `reply` decides each answer; every request is recorded. */
function fakeBushido() {
  const seen = []
  let reply = () => ({ status: 200, body: { result: { ok: true, recovery: [] } } })
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, raw })
      const r = reply(req)
      res.writeHead(r.status, { 'content-type': typeof r.body === 'string' ? 'text/plain' : 'application/json' })
      res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body))
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    answer: (fn) => { reply = fn },
    close: () => new Promise(r => server.close(r)),
  })))
}

const TRAINING = {
  ok: true,
  fetchedAt: '2026-10-14T08:00:00Z',
  days: 7,
  maxHeartRate: 190,
  body: { weightLb: 172.4 },
  workouts: [{ id: 'w1', sport: 'running' }],
  recovery: [
    { date: '2026-10-13', calories: 2612.6, strain: 14.2 },
    { date: '2026-10-14', calories: 940, strain: 3.1 },
    { date: '2026-10-12', calories: 0 }, // no figure: dropped, not a zero-burn day
    { calories: 2000 }, // no date: dropped
  ],
  sleep: [],
}

test('sends POST /api/whoop/owner with the token and the training method', async (b) => {
  b.answer(() => ({ status: 200, body: { result: TRAINING } }))
  const doc = await W.pull({ url: b.url, token: 'tok-123', days: 7 })
  assert.equal(b.seen.length, 1)
  const r = b.seen[0]
  assert.equal(r.method, 'POST')
  assert.equal(r.url, '/api/whoop/owner')
  assert.equal(r.headers.authorization, 'Bearer tok-123')
  assert.match(r.headers['content-type'], /^application\/json/)
  assert.deepEqual(JSON.parse(r.raw), { method: 'training', args: [{ days: 7 }] })

  // Only the burn and the body weight are kept; training is Bushido's business.
  assert.deepEqual(doc.burn, {
    '2026-10-13': { kcal: 2613, strain: 14.2 },
    '2026-10-14': { kcal: 940, strain: 3.1 },
  })
  assert.equal(doc.weightLb, 172.4)
  assert.equal(doc.days, 7)
  assert.ok(!('workouts' in doc))
})

test("Bushido's error text arrives verbatim, whatever the status", async (b) => {
  const cases = [
    [409, { error: 'Bushido has no WHOOP connection set up.' }],
    [403, { error: 'wrong token' }],
    [429, { error: 'WHOOP rate limit, try again in a minute', rateLimited: true }],
    [502, { error: 'WHOOP said: reconnect WHOOP to grant read:cycles', needsReauth: true }],
  ]
  for (const [status, body] of cases) {
    b.answer(() => ({ status, body }))
    await assert.rejects(W.pull({ url: b.url, token: 't' }), (e) => e.message === body.error, `status ${status}`)
  }
  b.answer(() => ({ status: 500, body: 'upstream exploded' }))
  await assert.rejects(W.pull({ url: b.url, token: 't' }), /^Error: upstream exploded$/)
  b.answer(() => ({ status: 500, body: '' }))
  await assert.rejects(W.pull({ url: b.url, token: 't' }), /Bushido answered 500/)
})

test('a 200 with no result, or a result that says it failed, is an error', async (b) => {
  b.answer(() => ({ status: 200, body: { ok: true } }))
  await assert.rejects(W.pull({ url: b.url, token: 't' }), /without a WHOOP result/)
  b.answer(() => ({ status: 200, body: 'not json' }))
  await assert.rejects(W.pull({ url: b.url, token: 't' }), /without a WHOOP result/)
  b.answer(() => ({ status: 200, body: { result: { ok: false, error: 'reconnect WHOOP' } } }))
  await assert.rejects(W.pull({ url: b.url, token: 't' }), /^Error: reconnect WHOOP$/)
})

test('no URL or no token: refused before any request', async (b) => {
  await assert.rejects(W.pull({ url: b.url, token: '' }), /not configured/)
  await assert.rejects(W.pull({ url: '', token: 't' }), /not configured/)
  assert.equal(b.seen.length, 0)
})

test('unset is OFF: the store answers not-configured and sends nothing', async (b) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'krakatoa-whoop-')), 'whoop.json')
  const store = W.makeStore(file, { config: () => null })
  assert.deepEqual(store.get(), W.NOT_CONFIGURED)
  assert.deepEqual(await store.refresh(), W.NOT_CONFIGURED)
  assert.equal(store.read().configured, false)
  assert.equal(b.seen.length, 0)
  assert.equal(fs.existsSync(file), false, 'nothing written either')
})

test('a failed refresh keeps the previous numbers, with the reason beside them', async (b) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'krakatoa-whoop-')), 'whoop.json')
  const store = W.makeStore(file, { config: () => ({ url: b.url, token: 't' }) })
  b.answer(() => ({ status: 200, body: { result: TRAINING } }))
  const ok = await store.refresh()
  assert.equal(ok.configured, true)
  assert.equal(ok.burn['2026-10-13'].kcal, 2613)

  b.answer(() => ({ status: 502, body: { error: 'reconnect WHOOP', needsReauth: true } }))
  const failed = await store.refresh()
  assert.equal(failed.error, 'reconnect WHOOP')
  assert.equal(failed.burn['2026-10-13'].kcal, 2613, 'yesterday is still yesterday')
  assert.equal(store.read().error, 'reconnect WHOOP')
})

;(async () => {
  for (const [name, fn] of tests) {
    const b = await fakeBushido()
    try { await fn(b); passed++ } catch (e) {
      console.error(`FAIL  ${name}\n      ${e.message}`)
      process.exitCode = 1
    } finally { await b.close() }
  }
  console.log(`server whoop: ${passed} passed`)
})()
