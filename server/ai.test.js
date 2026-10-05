/*
 * node server/ai.test.js
 *
 * Ask AI without a model. What this pins: numbers for a food Krakatoa knows come
 * from Krakatoa's table and never from the model; another chain's number is an
 * estimate; an invented match is an estimate that says so; and the run can see
 * its photo and its table and nothing else.
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const ai = require('./ai.js')

let passed = 0
const pending = []
const test = (name, fn) => pending.push(async () => {
  try { await fn(); passed++ } catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1 }
})

const restaurants = {
  chains: [{
    id: 'chipotle', name: 'Chipotle Mexican Grill', short: 'Chipotle',
    items: [
      { id: 'chipotle-chicken', name: 'Chicken', category: 'Proteins', portions: [{ id: 'p0', label: '4 oz', kcal: 180, protein: 32, carbs: 0, fat: 7 }] },
      { id: 'chipotle-rice', name: 'Cilantro-Lime White Rice', category: 'Rice', portions: [{ id: 'p0', label: '4 oz', kcal: 210, protein: 4, carbs: 40, fat: 4 }] },
      { id: 'chipotle-chips', name: 'Chips', category: 'Sides', portions: [{ id: 'p0', label: 'Regular · 4 oz', kcal: 540, protein: 7, carbs: 73, fat: 25 }] },
    ],
  }],
}
const basics = { foods: [{ id: 'banana', name: 'Banana', category: 'Fruit', portions: [{ id: 'p0', label: '1 medium', kcal: 105, protein: 1.3, carbs: 27, fat: 0.4 }] }] }
const state = {
  entries: {
    'combo-shake': { id: 'combo-shake', kind: 'combo', data: { name: 'Protein shake', components: [
      { name: 'Whey', portion: { kcal: 130, protein: 21, carbs: 4, fat: 3.5 }, qty: 2 },
      { name: 'Milk, 2%', portion: { kcal: 122, protein: 8.1, carbs: 11.7, fat: 4.8 }, qty: 3 },
    ] } },
    'combo-gone': { id: 'combo-gone', kind: 'combo', deleted: true, data: { name: 'Deleted', components: [{ name: 'x', portion: { kcal: 1 }, qty: 1 }] } },
  },
}
const index = ai.buildIndex({ state, restaurants, basics })

test('the table holds his combos (not deleted ones), the menus and the basics', () => {
  assert.ok(index.byId.has('y:combo-shake'))
  assert.ok(!index.byId.has('y:combo-gone'))
  assert.ok(index.byId.has('m:chipotle-chicken@p0'))
  assert.ok(index.byId.has('b:banana@p0'))
  assert.match(index.tsv.split('\n')[1], /^y:combo-shake\tyours\tyour combo\tProtein shake\t1 whole combo = 2× Whey, 3× Milk, 2%\t626\t/,
    'a combo says what one of it holds, so three tacos is not three combos of three tacos')
  assert.equal(index.byId.get('y:combo-shake').portion.label, '1 combo', 'and he just sees "1 combo"')
})

test('a matched food takes the TABLE\'s numbers, whatever the model says', () => {
  const r = ai.resolve({ kind: 'words', items: [
    { name: 'shake', qty: 1, portion: 'x', matchId: 'y:combo-shake', parts: [], estimate: { kcal: 999, protein: 0, carbs: 0, fat: 0 }, eaten: true },
    { name: 'Banana', qty: 2, portion: '1', matchId: 'b:banana@p0', parts: [], estimate: null, eaten: true },
  ] }, index)
  assert.equal(r.items[0].per.kcal, 626, 'not the 999 it claimed')
  assert.equal(r.items[0].basis, 'yours')
  assert.equal(r.items[1].per.kcal, 105)
  assert.equal(r.items[1].qty, 2)
  assert.equal(r.items[1].matchId, 'b:banana@p0', 'kept for a revision to send back')
})

test('a dish built from parts is the sum of the chain\'s own parts', () => {
  const r = ai.resolve({ kind: 'receipt', place: 'Chipotle Mexican Grill', items: [
    { name: 'Chicken bowl', qty: 1, portion: '1 bowl', matchId: null, parts: [{ matchId: 'm:chipotle-rice@p0', qty: 1 }, { matchId: 'm:chipotle-chicken@p0', qty: 2 }], estimate: null, eaten: true },
  ] }, index)
  assert.equal(r.items[0].basis, 'menu')
  assert.equal(r.items[0].per.kcal, 210 + 2 * 180)
  assert.equal(r.items[0].components.length, 2)
})

test("another chain's number at a different restaurant is an estimate, and says whose", () => {
  const r = ai.resolve({ kind: 'receipt', place: 'El Sol Taqueria', items: [
    { name: 'Chips', qty: 1, portion: '1', matchId: 'm:chipotle-chips@p0', parts: [], estimate: null, eaten: true },
  ] }, index)
  assert.equal(r.items[0].basis, 'estimate')
  assert.equal(r.items[0].per.kcal, 540)
  assert.match(r.items[0].note, /based on Chipotle's chips/)
  const same = ai.resolve({ kind: 'receipt', place: 'Chipotle', items: [{ name: 'Chips', qty: 1, portion: '1', matchId: 'm:chipotle-chips@p0', parts: [], eaten: true }] }, index)
  assert.equal(same.items[0].basis, 'menu', 'at Chipotle it is the menu')
})

test('an invented match is an estimate that says so; an item with no numbers is dropped', () => {
  const r = ai.resolve({ kind: 'words', items: [
    { name: 'Horchata', qty: 1, portion: '1 large', matchId: 'm:made-up@p0', parts: [], estimate: { kcal: 300, protein: 2, carbs: 60, fat: 5 }, eaten: true },
    { name: 'Mystery', qty: 1, portion: '1', matchId: null, parts: [], estimate: null, eaten: true },
  ] }, index)
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].basis, 'estimate')
  assert.match(r.items[0].note, /no exact match/)
})

test('the run sees its photo and its table and nothing else, and both are deleted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krakatoa-fake-ask-'))
  const bin = path.join(dir, 'claude')
  const argsFile = path.join(dir, 'args.json')
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs'); fs.readFileSync(0, 'utf8')
const a = process.argv.slice(2); const d = a[a.indexOf('--add-dir') + 1]
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ a, files: fs.readdirSync(d).sort() }))
process.stdout.write(JSON.stringify({ structured_output: { kind: 'words', place: null, items: [{ name: 'Banana', qty: 1, portion: '1', matchId: 'b:banana@p0', parts: [], estimate: null, eaten: true, confidence: 'high', note: null }], skipped: [], question: null, reply: 'ok' } }))
`, { mode: 0o755 })
  const out = await ai.askMeal({ bin, model: 'm', index, text: 'a banana', image: Buffer.alloc(2000, 1) })
  const { a, files } = JSON.parse(fs.readFileSync(argsFile, 'utf8'))
  const flag = (f) => a[a.indexOf(f) + 1]
  assert.equal(flag('--allowedTools'), 'Read,Grep,WebSearch,WebFetch', 'the web, to look a chain up — and nothing that writes')
  for (const t of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Task']) assert.ok(flag('--disallowedTools').split(',').includes(t), t)
  assert.deepEqual(files, ['foods.tsv', 'photo.jpg'])
  assert.ok(!fs.existsSync(flag('--add-dir')), 'deleted before the answer returned')
  assert.equal(out.items[0].per.kcal, 105)
  fs.rmSync(dir, { recursive: true, force: true })
})

const learnedMod = require('./learned.js')

test('a number from the web is kept only if Krakatoa sees it on that page itself', async () => {
  const page = 'Entrees\nChicken Madeira 1,250 cal | 55 g protein\nFried Mac and Cheese 1,100 calories\n'
  const found = [
    { chain: 'The Cheesecake Factory', sourceUrl: 'https://x/n.pdf', name: 'Chicken Madeira', category: 'Entrees', portion: '1 plate', kcal: 1250, protein: 55, carbs: 40, fat: 80 },
    { chain: 'The Cheesecake Factory', sourceUrl: 'https://x/n.pdf', name: 'Fried Mac and Cheese', category: 'Starters', portion: '1 order', kcal: 900, protein: 20, carbs: 80, fat: 50 },
    { chain: 'The Cheesecake Factory', sourceUrl: 'https://x/blocked', name: 'Avocado Eggrolls', category: 'Starters', portion: '1', kcal: 840, protein: 10, carbs: 70, fat: 60 },
  ]
  const { checks } = await learnedMod.verifyFound(found, { fetcher: async (u) => { if (u.includes('blocked')) throw new Error('403 Forbidden'); return page } })
  assert.deepEqual(checks.map(c => c.ok), [true, false, false], 'right number: kept; wrong number: not; unreadable page: not')
  assert.match(checks[2].why, /403/)
  const r = ai.resolve({ kind: 'receipt', place: 'The Cheesecake Factory', found, items: [
    { name: 'Chicken Madeira', qty: 1, portion: '1 plate', matchId: 'w:0', parts: [], estimate: null, eaten: true },
    { name: 'Fried Mac and Cheese', qty: 1, portion: '1 order', matchId: 'w:1', parts: [], estimate: null, eaten: true },
  ] }, index, checks)
  assert.equal(r.items[0].basis, 'menu')
  assert.equal(r.items[0].per.kcal, 1250)
  assert.equal(r.items[1].basis, 'estimate', 'a number the page does not show is an estimate')
  assert.match(r.items[1].note, /not verified/)
})

test('the check is strict: the name AND the number, together', () => {
  const text = 'Chicken Madeira ........ 1250\n\nSalads\nMadeira Salad 640'
  assert.equal(learnedMod.verifyItem(text, { name: 'Chicken Madeira', kcal: 1250 }), true)
  assert.equal(learnedMod.verifyItem(text, { name: 'Chicken Madeira', kcal: 640 }), false, 'another item\'s number nearby is not this one\'s')
  assert.equal(learnedMod.verifyItem(text, { name: 'Steak Diane', kcal: 1250 }), false)
  assert.equal(learnedMod.verifyItem('Cheesecake 12,50', { name: 'Cheesecake', kcal: 1250 }), false, 'digits must be the number itself')
})

test('the prompt names only the chains it has, and says so when there are none', () => {
  const some = ai.systemPrompt('', [{ short: 'Chipotle' }])
  assert.match(some, /chain menus \(basis "menu": Chipotle\)/)
  assert.doesNotMatch(some, /McDonald/)
  const none = ai.systemPrompt('', [])
  assert.match(none, /no chain menus on this server/)
  const empty = ai.buildIndex({ state: { entries: {} }, restaurants: null, basics })
  assert.deepEqual(empty.chains, [])
  assert.ok(![...empty.byId.keys()].some(k => k.startsWith('m:')))
})

test('learned items are kept as a chain Krakatoa knows, and learning twice updates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krakatoa-learned-'))
  const store = learnedMod.makeLearned(dir)
  const fresh = await store.add({ chain: 'The Cheesecake Factory', url: 'https://x/n.pdf', items: [{ name: 'Chicken Madeira', category: 'Entrees', portion: '1 plate', kcal: 1250, protein: 55, carbs: 40, fat: 80 }] })
  assert.equal(fresh, 1)
  assert.equal(await store.add({ chain: 'The Cheesecake Factory', url: 'https://x/n.pdf', items: [{ name: 'Chicken Madeira', category: 'Entrees', portion: '1 plate', kcal: 1260 }] }), 0)
  const doc = await store.load()
  const c = doc.chains[0]
  assert.equal(c.short, 'Cheesecake Factory')
  assert.equal(c.items[0].portions[0].kcal, 1260)
  assert.equal(c.source.url, 'https://x/n.pdf')
  assert.ok(c.learned)
  const again = ai.buildIndex({ state: { entries: {} }, restaurants: { chains: doc.chains }, basics })
  assert.ok([...again.byId.keys()].some(k => k.startsWith('m:learned-the-cheesecake-factory')), 'and it is in the table next time')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a nutrition table is read by Krakatoa, row by row; the model only names the columns', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krakatoa-fake-map-'))
  const bin = path.join(dir, 'claude')
  // Columns in this table: Calories, Cal-from-fat, Fat, Sodium, Carbs, Protein.
  fs.writeFileSync(bin, `#!/usr/bin/env node
require('fs').readFileSync(0, 'utf8')
process.stdout.write(JSON.stringify({ structured_output: { kcal: 0, fat: 2, sodium: 3, carbs: 4, protein: 5, fiber: null, sugar: null } }))
`, { mode: 0o755 })
  const header = '                          Calories  Cal from Fat  Fat (g)  Sodium (mg)  Carbs (g)  Protein (g)\nSPECIALTIES\n'
  const row = (n, k) => `${n.padEnd(34)}  ${k}   ${Math.round(k * 0.45)}   ${Math.round(k * 0.05)}   1200   ${Math.round(k * 0.08)}   ${Math.round(k * 0.07)}`
  const names = Array.from({ length: 30 }, (_, i) => `Dish Number ${String.fromCharCode(65 + (i % 26))}${i}`)
  const text = header + names.map((n, i) => row(n, 400 + i * 10)).join('\n') + '\nTropical Mimosa (PR)            230  0  0  10  20  1\n'
  const r = await ai.tableMenu({ bin, model: 'm', chain: 'Testaurant', text })
  assert.equal(r.items.length, 30, 'every row, and not the other state\'s variant')
  const first = r.items[0]
  assert.deepEqual([first.kcal, first.fat, first.sodium, first.carbs, first.protein, first.category], [400, 20, 1200, 32, 28, 'SPECIALTIES'])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a table whose mapped columns disagree with their own macros is not kept at all', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krakatoa-fake-map-'))
  const bin = path.join(dir, 'claude')
  // A wrong mapping: "calories" pointed at the sodium column.
  fs.writeFileSync(bin, `#!/usr/bin/env node
require('fs').readFileSync(0, 'utf8')
process.stdout.write(JSON.stringify({ structured_output: { kcal: 3, fat: 2, sodium: 0, carbs: 4, protein: 5, fiber: null, sugar: null } }))
`, { mode: 0o755 })
  const rows = Array.from({ length: 30 }, (_, i) => `Plate ${i} of the house                  ${500 + i}   200   20   1400   50   30`).join('\n')
  const r = await ai.tableMenu({ bin, model: 'm', chain: 'Testaurant', text: `Calories Cal Fat Sodium Carbs Protein\n${rows}\n` })
  assert.equal(r.items.length, 0, 'none of it is kept')
  assert.match(r.why, /disagree with their own macros/)
  fs.rmSync(dir, { recursive: true, force: true })
})

;(async () => { for (const t of pending) await t(); console.log(`ask (server): ${passed} passed`) })()
