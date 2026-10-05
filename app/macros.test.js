/*
 * node app/macros.test.js
 *
 * The macro ring and the water meter. Both turn a number into a SHAPE, so what
 * is pinned is that the shape cannot say something the numbers do not.
 */

import assert from 'node:assert'
import {
  macroSplit, ringSegments, waterLevel, ozToL, KCAL_PER_G, WATER_STEPS, WATER_DEFAULT_TARGET, customWaterOz, WATER_NUDGE,
} from './src/lib/macros.js'

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++ } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`)
    process.exitCode = 1
  }
}

const DAY = { kcal: 1853, protein: 118, carbs: 140, fat: 92 }

/* ------------------------------------------------------------ the macro pie */

test('the split is by ENERGY, not by grams', () => {
  // 92 g of fat is fewer grams than 140 g of carbs and more than half again the
  // energy. A pie drawn by weight would say the opposite of the truth.
  const { parts } = macroSplit(DAY)
  const by = Object.fromEntries(parts.map(p => [p.key, p]))
  assert.equal(by.fat.kcal, 92 * KCAL_PER_G.fat)
  assert.ok(by.fat.pct > by.carbs.pct, 'fat is the bigger slice despite fewer grams')
  // 472 / 560 / 828 kcal of 1,860 — the fat slice rounds UP to 45.
  assert.deepEqual(parts.map(p => p.pct), [25, 30, 45])
})

test('the slices are a whole pie, give or take rounding', () => {
  const total = macroSplit(DAY).parts.reduce((n, p) => n + p.pct, 0)
  assert.ok(Math.abs(total - 100) <= 1, `slices sum to ${total}%`)
})

test('a day with no macros has NO split rather than three equal thirds', () => {
  // Three equal thirds would be a chart of nothing that looks exactly like a
  // chart of something.
  const empty = macroSplit({ kcal: 0, protein: 0, carbs: 0, fat: 0 })
  assert.equal(empty.fromMacros, 0)
  assert.deepEqual(empty.parts.map(p => p.pct), [0, 0, 0])
  assert.deepEqual(ringSegments({ kcal: 0 }, 2400), { fill: 0, segments: [] })
  assert.deepEqual(macroSplit(null).parts.map(p => p.grams), [0, 0, 0])
})

test('the ring goes further round as the day fills the target', () => {
  const half = ringSegments({ ...DAY, kcal: 1200 }, 2400)
  const full = ringSegments({ ...DAY, kcal: 2400 }, 2400)
  const len = (r) => r.segments.reduce((n, s) => n + s.length, 0)
  assert.ok(Math.abs(len(half) - 50) < 0.5, `half a target drew ${len(half)}%`)
  assert.ok(Math.abs(len(full) - 100) < 0.5, `a met target drew ${len(full)}%`)
})

test('going over the target does not draw more than one turn', () => {
  const over = ringSegments({ ...DAY, kcal: 4000 }, 2400)
  const len = over.segments.reduce((n, s) => n + s.length, 0)
  assert.ok(Math.abs(len - 100) < 0.5, `drew ${len}%`)
  assert.equal(over.over, true, 'but it says so')
})

test('with NO target the ring is whole and is purely the split', () => {
  // A fraction of nothing is not a fraction.
  const r = ringSegments(DAY, null)
  const len = r.segments.reduce((n, s) => n + s.length, 0)
  assert.ok(Math.abs(len - 100) < 0.5, `drew ${len}%`)
  assert.equal(r.over, false)
})

test('the segments butt up, each starting where the last ended', () => {
  const { segments } = ringSegments(DAY, 2400)
  let cursor = 0
  for (const s of segments) {
    assert.ok(Math.abs(s.offset - cursor) < 0.001, `${s.key} starts at ${s.offset}, expected ${cursor}`)
    cursor += s.length
  }
})

test('a macro with nothing in it gets no slice at all', () => {
  const { segments } = ringSegments({ kcal: 800, protein: 50, carbs: 150, fat: 0 }, 2400)
  assert.deepEqual(segments.map(s => s.key), ['protein', 'carbs'])
})

test('the split ignores the logged kcal, which rarely agrees exactly', () => {
  // Alcohol carries energy and no macro; labels count fibre differently; every
  // figure is rounded. Scaling the slices to the logged total would quietly
  // hand that discrepancy to the three colours as if it were theirs.
  const boozy = macroSplit({ kcal: 2500, protein: 100, carbs: 100, fat: 50 })
  assert.equal(boozy.fromMacros, 100 * 4 + 100 * 4 + 50 * 9)
  assert.notEqual(boozy.fromMacros, 2500)
  assert.equal(boozy.parts.reduce((n, p) => n + p.pct, 0), 100)
})

/* --------------------------------------------------------------- the water */

test('the glass fills toward the target and stops at full', () => {
  assert.equal(waterLevel(32, 64).pct, 50)
  assert.equal(waterLevel(64, 64).pct, 100)
  assert.equal(waterLevel(64, 64).met, true)
  // A wave leaving the top of its container is a rendering bug, not an
  // achievement — the number above it already says he went over.
  assert.equal(waterLevel(200, 64).pct, 100)
  assert.equal(waterLevel(200, 64).met, true)
})

test('an empty or nonsense amount is an empty glass, never a negative one', () => {
  assert.equal(waterLevel(0, 64).pct, 0)
  assert.equal(waterLevel(-50, 64).pct, 0)
  assert.equal(waterLevel(null, 64).pct, 0)
  assert.equal(waterLevel(undefined).pct, 0)
})

test('no target falls back to the default rather than dividing by zero', () => {
  assert.equal(waterLevel(32, null).target, WATER_DEFAULT_TARGET)
  assert.equal(waterLevel(32, 0).target, WATER_DEFAULT_TARGET)
  assert.equal(waterLevel(32, null).pct, 50)
})

test('the quick amounts are the things you drink out of', () => {
  assert.deepEqual(WATER_STEPS.map(s => s.oz), [4, 6, 12, 32, 64])
  assert.equal(WATER_NUDGE, 4)
  for (const s of WATER_STEPS) assert.ok(s.hint, `${s.oz} has no name`)
})

test('litres are right', () => {
  assert.equal(ozToL(64), 1.89)
  assert.equal(ozToL(0), 0)
})

test('a custom amount of water is whole ounces, in oz or mL', () => {
  assert.equal(customWaterOz('20'), 20)
  assert.equal(customWaterOz('16.9'), 17)
  assert.equal(customWaterOz('500', 'ml'), 17)
  assert.equal(customWaterOz('1,5'), 2, 'a comma is a decimal point')
  for (const bad of ['', 'abc', '0', '-8', '500']) assert.equal(customWaterOz(bad), null, `"${bad}"`)
})

console.log(`macros + water: ${passed} passed`)
