/*
 * node server/digest.test.js
 *
 * The day rollup and the agent digest. These are what Totem's habit note and
 * Bushido's coach both read, so a mistake here is a wrong number in two other apps.
 */

const assert = require('assert')
const D = require('./digest.js')
const V = require('./totem.js')

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++ } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`)
    process.exitCode = 1
  }
}

const food = (id, date, name, at, m) => ({
  id, kind: 'food', date, updatedAt: at,
  data: { name, at, meal: m.meal || 'lunch', kcal: m.kcal, protein: m.protein || 0, carbs: m.carbs || 0, fat: m.fat || 0, gtin: m.gtin || null },
})

const STATE = {
  entries: {
    targets: { id: 'targets', kind: 'settings', data: { kcal: 2400, protein: 160, carbs: 250, fat: 80 } },
    a: food('a', '2026-09-22', 'Oats', '2026-09-22T07:00:00Z', { kcal: 380, protein: 13, carbs: 67, fat: 7, meal: 'breakfast', gtin: '1' }),
    b: food('b', '2026-09-22', 'Clif Bar', '2026-09-22T12:00:00Z', { kcal: 250, protein: 10, carbs: 43, fat: 6, gtin: '2' }),
    c: food('c', '2026-09-21', 'Burrito', '2026-09-21T19:00:00Z', { kcal: 900, protein: 40, carbs: 90, fat: 30, meal: 'dinner' }),
    gone: { ...food('gone', '2026-09-22', 'Deleted', '2026-09-22T08:00:00Z', { kcal: 5000 }), deleted: true },
  },
}

test('a day totals what is on it, and nothing else', () => {
  const d = D.dayDigest(STATE, '2026-09-22')
  assert.equal(d.count, 2, 'the deleted row and yesterday are both out')
  assert.equal(d.total.kcal, 630)
  assert.equal(d.total.protein, 23)
})

test('the day is ordered by when it was eaten, not by entry id', () => {
  const d = D.dayDigest(STATE, '2026-09-22')
  assert.deepEqual(d.items.map(i => i.name), ['Oats', 'Clif Bar'])
})

test('remaining is against the target, and grouped by meal', () => {
  const d = D.dayDigest(STATE, '2026-09-22')
  assert.equal(d.remaining.kcal, 1770)
  assert.deepEqual(Object.keys(d.byMeal).sort(), ['breakfast', 'lunch'])
})

test('no target is null remaining, never zero', () => {
  // "0 left" and "no target set" look identical if a missing target reads as 0,
  // and only one of them should turn a ring red.
  const d = D.dayDigest({ entries: { a: STATE.entries.a } }, '2026-09-22')
  assert.equal(d.remaining.kcal, null)
  assert.equal(d.target.kcal, null)
})

test('an empty day is zero and not a crash', () => {
  const d = D.dayDigest(STATE, '2026-01-01')
  assert.equal(d.count, 0)
  assert.equal(d.total.kcal, 0)
  assert.deepEqual(D.dayDigest(null, '2026-01-01').items, [])
})

test('the average is over days he LOGGED, not over the window', () => {
  // Averaging an untracked day in as zero reads as a crash diet, which is a
  // conclusion an agent would then act on.
  const g = D.digest(STATE, { today: '2026-09-22', days: 14 })
  assert.equal(g.daysLogged, 2)
  assert.equal(g.average.kcal, Math.round((630 + 900) / 2))
  assert.equal(g.history.length, 14)
  assert.equal(g.history.at(-1).date, '2026-09-22', 'today is last')
})

test('a window with nothing in it averages to null, not zero', () => {
  const g = D.digest({ entries: {} }, { today: '2026-09-22', days: 7 })
  assert.equal(g.average.kcal, null)
  assert.equal(g.daysLogged, 0)
})

test('recent foods are unique, newest first, and counted', () => {
  const state = {
    entries: {
      ...STATE.entries,
      d: food('d', '2026-09-20', 'Oats', '2026-09-20T07:00:00Z', { kcal: 380, gtin: '1' }),
    },
  }
  const r = D.recentFoods(state)
  const oats = r.find(f => f.name === 'Oats')
  assert.equal(r.filter(f => f.name === 'Oats').length, 1, 'one row per food')
  assert.equal(oats.times, 2, 'eaten twice')
  assert.equal(r[0].name, 'Clif Bar', 'the most recent thing is first')
})

test('dates are local, never UTC', () => {
  // toISOString on a local evening rolls to tomorrow, which would file dinner on
  // the wrong day for everyone west of Greenwich — including here.
  const d = new Date(2026, 8, 22, 23, 30)
  assert.equal(D.isoDate(d), '2026-09-22')
  assert.deepEqual(D.recentDates('2026-03-02', 3), ['2026-02-28', '2026-03-01', '2026-03-02'])
})

test('the Totem note leads with the numbers and is capped at 500', () => {
  const day = D.dayDigest(STATE, '2026-09-22')
  const note = V.noteFor(day)
  assert.ok(note.startsWith('630 kcal · 23 P / 110 C / 13 F'), note)
  assert.ok(note.includes('Oats'))

  const many = { total: day.total, items: Array.from({ length: 80 }, (_, i) => ({ name: `A very long food name number ${i}` })) }
  const long = V.noteFor(many)
  assert.ok(long.length <= 500, `note was ${long.length} chars`)
  assert.ok(long.startsWith('630 kcal'), 'the totals survive the truncation')
})

console.log(`digest: ${passed} passed`)
