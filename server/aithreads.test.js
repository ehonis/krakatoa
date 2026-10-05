/*
 * node server/aithreads.test.js
 *
 * Ask AI threads, with a stand-in for the model. What this pins is what "in
 * the background" promised: the answer lands in the thread whoever is looking,
 * a failure is recorded rather than lost, and a restart resumes unfinished work.
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { makeStore, makeRunner, newId, summaryOf } = require('./aithreads.js')

let passed = 0
const pending = []
const test = (name, fn) => pending.push(async () => {
  try { await fn(); passed++ } catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1 }
})
const until = async (f) => { for (let i = 0; i < 200; i++) { if (await f()) return; await new Promise(r => setTimeout(r, 10)) } throw new Error('timed out') }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krakatoa-threads-'))
const store = makeStore(dir)
const answer = { kind: 'receipt', place: 'Chipotle', items: [{ name: 'Burrito', qty: 1, per: { kcal: 1085 }, eaten: true }], reply: 'ok' }

test('a thread started with nobody watching still gets its answer', async () => {
  const runner = makeRunner({ store, run: async () => answer, log: () => {} })
  const id = newId()
  await store.write({ id, createdAt: new Date().toISOString(), status: 'working', turns: [{ role: 'you', text: 'burrito' }] })
  runner.enqueue(id)
  await until(async () => (await store.read(id)).status === 'ready')
  const t = await store.read(id)
  assert.equal(t.turns.at(-1).answer.place, 'Chipotle')
  const s = summaryOf(t)
  assert.deepEqual([s.title, s.items, s.kcal, s.status], ['Chipotle', 1, 1085, 'ready'])
})

test('a failed run says why, in the thread', async () => {
  const runner = makeRunner({ store, run: async () => { throw new Error('not signed in') }, log: () => {} })
  const id = newId()
  await store.write({ id, createdAt: new Date().toISOString(), status: 'working', turns: [{ role: 'you', text: 'x' }] })
  runner.enqueue(id)
  await until(async () => (await store.read(id)).status === 'error')
  assert.equal((await store.read(id)).error, 'not signed in')
})

test('work left unfinished by a restart is run again', async () => {
  const id = newId()
  await store.write({ id, createdAt: new Date().toISOString(), status: 'working', turns: [{ role: 'you', text: 'x' }] })
  const runner = makeRunner({ store, run: async () => answer, log: () => {} })
  assert.ok((await runner.recover()) >= 1)
  await until(async () => (await store.read(id)).status === 'ready')
})

test('his draft is what the list shows until a new answer replaces it', async () => {
  const id = newId()
  const t = { id, createdAt: new Date().toISOString(), status: 'ready', turns: [{ role: 'you', text: 'x' }, { role: 'ai', answer }] }
  t.draft = { items: [{ name: 'Burrito', qty: 0.5, per: { kcal: 1085 }, on: true }] }
  await store.write(t)
  assert.equal(summaryOf(await store.read(id)).kcal, 543, 'half the burrito, as he left it')
})

test('a photo is kept with its thread and removed with it', async () => {
  const id = newId()
  const name = await store.savePhoto(id, Buffer.alloc(1200, 1))
  await store.write({ id, createdAt: new Date().toISOString(), status: 'ready', turns: [{ role: 'you', photo: name }] })
  assert.ok(fs.existsSync(store.photoPath(name)))
  await store.remove(id)
  assert.ok(!fs.existsSync(store.photoPath(name)))
  assert.equal(await store.read(id), null)
})

;(async () => {
  for (const t of pending) await t()
  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`ask threads: ${passed} passed`)
})()
