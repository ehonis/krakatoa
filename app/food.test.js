/*
 * node app/food.test.js
 *
 * The client's arithmetic, and — the point of this file — a check that it still
 * agrees with the server's. `app/src/lib/food.js` deliberately duplicates
 * `amountFor` and `totals` from `server/nutrition.js` (see the header there for
 * why). A deliberate duplicate is only safe while something fails when the two
 * drift, so that something is here.
 */

import assert from 'node:assert'
import { createRequire } from 'node:module'
import {
  amountFor, totals, isoDate, shiftDate, dayLabel,
  mealNow, portionLabel, titleOf, imageUrl, tileHue, tileLetter,
} from './src/lib/food.js'

const require = createRequire(import.meta.url)
const server = require('../server/nutrition.js')

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++ } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`)
    process.exitCode = 1
  }
}

/* ------------------------------------------------- the duplication is honest */

test('amountFor agrees with the server, case for case', () => {
  const portions = [
    { kcal: 253, protein: 10, carbs: 43, fat: 6 },
    { kcal: 0, protein: 0, carbs: 0, fat: 0 },
    { kcal: 379, protein: 13.3, carbs: 67.7, fat: 6.52 },
    { kcal: 1, protein: 0.05, carbs: 0.05, fat: 0.05 },
  ]
  for (const p of portions) {
    for (const q of [1, 2, 0.25, 0.5, 1.5, 3.75, 0, -1, undefined]) {
      assert.deepEqual(
        amountFor(p, q), server.amountFor(p, q),
        `drifted at ${JSON.stringify(p)} × ${q}`,
      )
    }
  }
})

test('totals agrees with the server, including on malformed rows', () => {
  const cases = [
    [],
    [{ kcal: 253, protein: 10, carbs: 43, fat: 6 }],
    [{ kcal: 100 }, null, { kcal: 'x' }, {}],
    [{ kcal: 1, protein: 0.1 }, { kcal: 2, protein: 0.2 }, { kcal: 3, protein: 0.3 }],
  ]
  for (const c of cases) {
    assert.deepEqual(totals(c), server.totals(c), `drifted at ${JSON.stringify(c)}`)
  }
  assert.deepEqual(totals(null), server.totals(null))
})

/* ------------------------------------------------------------------- dates */

test('a date is LOCAL, and late evening does not roll to tomorrow', () => {
  // toISOString() is UTC. At 23:30 anywhere west of Greenwich that is already tomorrow, which would
  // file every late dinner on the wrong day.
  assert.equal(isoDate(new Date(2026, 8, 22, 23, 30)), '2026-09-22')
  assert.equal(isoDate(new Date(2026, 0, 1, 0, 1)), '2026-01-01')
})

test('shifting a date crosses months, years and DST', () => {
  assert.equal(shiftDate('2026-09-22', -1), '2026-09-21')
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28')
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01')
  // The US spring-forward weekend. Anchored at noon precisely so a 23:00 date
  // plus a lost hour cannot land back on the same day.
  assert.equal(shiftDate('2026-03-08', -1), '2026-03-07')
})

test('the three days that get a word instead of a date', () => {
  assert.equal(dayLabel('2026-09-22', '2026-09-22'), 'Today')
  assert.equal(dayLabel('2026-09-21', '2026-09-22'), 'Yesterday')
  assert.ok(!/Today|Yesterday/.test(dayLabel('2026-09-18', '2026-09-22')))
})

/* -------------------------------------------------------------------- meals */

test('the meal follows the clock, so the commonest answer is pre-answered', () => {
  assert.equal(mealNow(new Date(2026, 8, 22, 8, 0)), 'breakfast')
  assert.equal(mealNow(new Date(2026, 8, 22, 12, 30)), 'lunch')
  assert.equal(mealNow(new Date(2026, 8, 22, 19, 0)), 'dinner')
  assert.equal(mealNow(new Date(2026, 8, 22, 22, 30)), 'snack')
  assert.equal(mealNow(new Date(2026, 8, 22, 2, 0)), 'breakfast', 'a 2am raid is still before 10:30')
})

/* ------------------------------------------------------------------ naming */

test('a brand is not printed twice', () => {
  assert.equal(titleOf({ name: 'Chocolate Chip Energy Bar', brand: 'Clif' }), 'Clif · Chocolate Chip Energy Bar')
  assert.equal(titleOf({ name: 'Clif Bar Chocolate Chip', brand: 'Clif' }), 'Clif Bar Chocolate Chip')
  assert.equal(titleOf({ name: 'Oats', brand: null }), 'Oats')
  assert.equal(titleOf(null), '')
})

test('one of something says the portion, more than one says how many', () => {
  assert.equal(portionLabel(1, { label: '1 bar (68 g)' }), '1 bar (68 g)')
  assert.equal(portionLabel(2, { label: '1 bar (68 g)' }), '2 × 1 bar (68 g)')
  assert.equal(portionLabel(0.5, { label: '100 g' }), '0.5 × 100 g')
  assert.equal(portionLabel(1, null), 'serving')
})

/* ------------------------------------------------------------------ photos */

test('a barcode is enough to ask for a picture; the known URL is only a hint', () => {
  // Everything logged before this app had photos is a real barcode with no image
  // URL stored anywhere, and the server can resolve one from the code alone. If
  // this ever requires `image` again, those entries silently stop asking.
  const withUrl = imageUrl({ gtin: '722252100900', image: 'https://images.openfoodfacts.org/x.jpg' })
  assert.ok(withUrl.startsWith('/api/image?gtin=722252100900'))
  assert.ok(withUrl.includes('&u=https%3A%2F%2Fimages'), 'the hint is passed on, encoded')

  const bare = imageUrl({ gtin: '722252100900' })
  assert.equal(bare, '/api/image?gtin=722252100900', 'no hint, still asks')

  assert.equal(imageUrl({ name: 'Chicken burrito' }), null, 'no barcode, no picture')
  assert.equal(imageUrl(null), null)
})

test('a food always renders as this app, never as OFF directly', () => {
  // Same-origin is what makes the photo work offline, get cached by the service
  // worker, and stay off somebody else's request log.
  const url = imageUrl({ gtin: '049000042566', image: 'https://images.openfoodfacts.org/y.jpg' })
  assert.ok(url.startsWith('/api/'), url)
  assert.ok(!url.startsWith('http'), 'never an absolute URL to the CDN')
})

test('the letter tile is stable for a food and different between foods', () => {
  // Stable, because the point of the tile is that the same yoghurt is the same
  // colour every time — a random one would defeat the whole reason for it.
  assert.equal(tileHue('Chobani · Greek Yogurt'), tileHue('Chobani · Greek Yogurt'))
  assert.notEqual(tileHue('Chobani · Greek Yogurt'), tileHue('Fage · Greek Yogurt'))
  assert.ok(tileHue('anything') >= 0 && tileHue('anything') < 360)
  assert.equal(tileHue(''), 0)
  assert.equal(tileHue(null), 0, 'a nameless food still gets a tile, not a crash')

  assert.equal(tileLetter('Chicken burrito'), 'C')
  assert.equal(tileLetter('  oats'), 'O')
  assert.equal(tileLetter(''), '·', 'never an empty square')
  assert.equal(tileLetter(null), '·')
})

console.log(`food: ${passed} passed`)
