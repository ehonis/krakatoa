/*
 * node server/mcp.test.js
 *
 * Krakatoa's MCP, against an in-memory store. What this pins: the protocol answers
 * the way Totem's gateway expects; logging by ref uses KRAKATOA's numbers and an
 * estimate says it is one; entries are shaped as the phone writes them; errors
 * come back as tool errors, not crashes; every tool states all four hints.
 */

const assert = require('assert')
const { makeMcp } = require('./mcp.js')
const ai = require('./ai.js')
const digest = require('./digest.js')

let passed = 0
const pending = []
const test = (name, fn) => pending.push(async () => {
  try { await fn(); passed++ } catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1 }
})

function world() {
  const doc = { entries: {
    'combo-eggs': { id: 'combo-eggs', kind: 'combo', data: { name: 'Scrambled eggs', components: [{ name: 'Egg', portion: { kcal: 72, protein: 6.3, carbs: 0.4, fat: 4.8 }, qty: 4 }] } },
    targets: { id: 'targets', kind: 'settings', data: { kcal: 2400, protein: 185 } },
  } }
  const ctx = {
    readState: async () => JSON.parse(JSON.stringify(doc)),
    withState: async (fn) => fn(JSON.parse(JSON.stringify(doc))),
    commit: async (_d, incoming) => { Object.assign(doc.entries, incoming); return doc },
    digest,
    whoop: () => null,
    balanceFor: () => null,
    buildIndex: ai.buildIndex,
    restaurants: async () => ({ chains: [{ id: 'chipotle', name: 'Chipotle Mexican Grill', short: 'Chipotle', items: [{ id: 'chipotle-chicken', name: 'Chicken', category: 'Proteins', portions: [{ id: 'p0', label: '4 oz', kcal: 180, protein: 32, carbs: 0, fat: 7 }] }] }] }),
    basics: async () => ({ foods: [{ id: 'coffee-brewed', name: 'Coffee, brewed', category: 'Drinks', portions: [{ id: 'p0', label: '1 cup', kcal: 2, protein: 0.3, carbs: 0, fat: 0 }] }, { id: 'coffee-cake', name: 'Coffee cake', category: 'Bakery', portions: [{ id: 'p0', label: '1 piece', kcal: 263, protein: 4, carbs: 29, fat: 15 }] }] }),
    searchDatabases: async () => ({ foods: [] }),
    lookupBarcode: async () => ({ food: null, reason: 'not-found' }),
    normalizeGtin: (g) => (g ? String(g) : null),
    cacheFood: async () => {},
    listThreads: async () => [],
    askAndWait: async () => ({ status: 'error', error: 'no model in tests', turns: [] }),
    markLogged: async () => {},
  }
  return { doc, mcp: makeMcp(ctx) }
}

const call = async (mcp, name, args) => (await mcp.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } })).result

test('it speaks MCP the way the gateway asks', async () => {
  const { mcp } = world()
  const init = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })
  assert.equal(init.result.protocolVersion, '2025-03-26', 'echoes the version asked for')
  assert.equal(init.result.serverInfo.name, 'krakatoa')
  assert.equal(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null, 'a notification gets no reply')
  const list = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  assert.ok(list.result.tools.length >= 15)
  for (const t of list.result.tools) {
    assert.ok(!t.name.startsWith('krakatoa') && t.title && t.description && t.inputSchema, t.name)
    for (const h of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) assert.equal(typeof t.annotations[h], 'boolean', `${t.name} ${h}`)
    assert.ok(!('run' in t), 'handlers are not listed')
  }
  const del = list.result.tools.find(t => t.name === 'delete_entry')
  assert.equal(del.annotations.destructiveHint, true)
  assert.equal((await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'nope' })).error.code, -32601)
})

test('search puts his own food first, and the thing itself before things named after it', async () => {
  const { mcp } = world()
  const r = (await call(mcp, 'search_foods', { query: 'eggs' })).structuredContent
  assert.equal(r.results[0].ref, 'y:combo-eggs')
  const c = (await call(mcp, 'search_foods', { query: 'coffee' })).structuredContent
  assert.equal(c.results[0].name, 'Coffee, brewed', 'not "Coffee cake"')
})

test('a ref logs Krakatoa\'s numbers; an estimate logs as "ai"; entries look like the phone\'s', async () => {
  const { mcp, doc } = world()
  const r = (await call(mcp, 'log_food', { date: '2026-09-26', meal: 'breakfast', items: [
    { ref: 'y:combo-eggs' },
    { ref: 'b:coffee-brewed', qty: 2 },
    { ref: 'm:chipotle-chicken', qty: 2 },
    { food: { name: 'BLT sandwich' }, portion: { label: '1 sandwich', kcal: 450, protein: 17, carbs: 35, fat: 27 }, qty: 2 },
  ] })).structuredContent
  assert.deepEqual(r.logged.map(l => l.kcal), [288, 4, 360, 900])
  assert.deepEqual(r.logged.map(l => l.basis), ['yours', 'basic', 'menu', 'estimate'])
  const entries = Object.values(doc.entries).filter(e => e.kind === 'food')
  assert.equal(entries.length, 4)
  const combo = entries.find(e => e.data.name === 'Scrambled eggs')
  assert.equal(combo.data.source, 'combo')
  assert.equal(combo.data.comboId, 'combo-eggs')
  assert.ok(combo.data.components?.length, 'a combo remembers what went in, as the phone logs it')
  const blt = entries.find(e => e.data.name === 'BLT sandwich')
  assert.deepEqual([blt.data.source, blt.data.qty, blt.data.portion.kcal, blt.data.kcal, blt.date, blt.data.meal], ['ai', 2, 450, 900, '2026-09-26', 'breakfast'])
  assert.ok(blt.updatedAt && /^food-2026-09-26-/.test(blt.id))
  assert.equal(r.day.kcal, 288 + 4 + 360 + 900)
})

test('a bad item is a tool error with the fix in it, and nothing is logged', async () => {
  const { mcp, doc } = world()
  const r = await call(mcp, 'log_food', { items: [{ ref: 'b:coffee-brewed' }, { ref: 'b:no-such-food' }] })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /item 2: no food with ref "b:no-such-food" — search again/)
  assert.equal(Object.values(doc.entries).filter(e => e.kind === 'food').length, 0, 'all or nothing')
})

test('edit, delete, water, targets and combos', async () => {
  const { mcp, doc } = world()
  const r = (await call(mcp, 'log_food', { date: '2026-09-26', items: [{ ref: 'b:coffee-brewed' }] })).structuredContent
  const id = r.logged[0].id
  assert.equal((await call(mcp, 'edit_entry', { id, qty: 3 })).structuredContent.kcal, 6)
  await call(mcp, 'delete_entry', { id })
  assert.equal(doc.entries[id].deleted, true)
  assert.equal((await call(mcp, 'add_water', { oz: 17, date: '2026-09-26' })).structuredContent.waterOz, 17)
  assert.equal((await call(mcp, 'add_water', { oz: -40, date: '2026-09-26' })).structuredContent.waterOz, 0, 'never below zero')
  assert.equal((await call(mcp, 'set_targets', { water: 100 })).structuredContent.targets.kcal, 2400, 'only what was given changes')
  const combo = (await call(mcp, 'save_combo', { name: 'Breakfast', components: [{ ref: 'y:combo-eggs' }, { ref: 'b:coffee-brewed', qty: 2 }] })).structuredContent
  assert.equal(combo.total.kcal, 292)
  assert.equal(doc.entries[combo.id].kind, 'combo')
})

;(async () => { for (const t of pending) await t(); console.log(`mcp: ${passed} passed`) })()
