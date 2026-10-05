/*
 * node app/whoop.test.js
 *
 * The deficit. Most of these tests are about REFUSING to answer: the obvious
 * version of this feature lies twice a day, and both lies subtract two real
 * numbers to get a confident wrong one.
 */

import assert from 'node:assert'
import { createRequire } from 'node:module'
import { balanceFor } from './src/lib/whoop.js'

const require = createRequire(import.meta.url)
const server = require('../server/whoop.js')

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++ } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`)
    process.exitCode = 1
  }
}

const WHOOP = {
  fetchedAt: '2026-09-22T18:00:00Z',
  burn: {
    '2026-09-22': { kcal: 1890, strain: 12.8 }, // today, still counting
    '2026-09-21': { kcal: 2816, strain: 17.4 },
    '2026-09-20': { kcal: 1741, strain: 4.1 },
    '2026-09-19': { kcal: 2496, strain: 10.7 },
    '2026-09-18': { kcal: 2179, strain: 7.3 },
  },
}
const TODAY = '2026-09-22'

/* ------------------------------------------------- the two ways this lies */

test("today's burn is PARTIAL and is flagged as such", () => {
  // At 14:23 this read 1,890 burned against 1,853 eaten and subtracted to
  // "37 under" — which is not a deficit, it is a clock. The flag is what stops
  // the screen printing a verdict.
  const b = balanceFor(WHOOP, TODAY, 1853, TODAY)
  assert.equal(b.partial, true)
  assert.equal(b.burned, 1890)
  assert.equal(b.net, -37)
})

test('a completed day is not partial', () => {
  const b = balanceFor(WHOOP, '2026-09-21', 2400, TODAY)
  assert.equal(b.partial, false)
  assert.equal(b.net, -416)
})

test('a day with nothing logged is UNTRACKED, not a 2,800 deficit', () => {
  // The log's own gaps would otherwise read as the most dramatic results in it,
  // and an agent reading the digest would draw exactly the wrong conclusion.
  const b = balanceFor(WHOOP, '2026-09-21', 0, TODAY)
  assert.equal(b.untracked, true)
  assert.equal(b.burned, 2816)
  const tracked = balanceFor(WHOOP, '2026-09-21', 1, TODAY)
  assert.equal(tracked.untracked, false, 'one calorie logged is a tracked day')
})

test('a day WHOOP has no figure for gets no balance at all', () => {
  // Absent means absent. A missing strap night must not read as zero burned.
  assert.equal(balanceFor(WHOOP, '2026-01-01', 2000, TODAY), null)
  assert.equal(balanceFor(null, TODAY, 2000, TODAY), null)
  assert.equal(balanceFor({ burn: {} }, TODAY, 2000, TODAY), null)
})

/* ------------------------------------------------------------- the yardstick */

test('the typical day averages COMPLETE days only, never today', () => {
  // Including today's partial 1,890 would drag the average down all morning and
  // make the one honest reference number move for the wrong reason.
  const b = balanceFor(WHOOP, TODAY, 1853, TODAY)
  const complete = [2816, 1741, 2496, 2179]
  assert.equal(b.typical, Math.round(complete.reduce((a, c) => a + c, 0) / complete.length))
  assert.ok(!String(b.typical).includes('1890'))
})

test('too few days means no yardstick rather than a shaky one', () => {
  const thin = { burn: { '2026-09-22': { kcal: 1890 }, '2026-09-21': { kcal: 2816 } } }
  assert.equal(balanceFor(thin, '2026-09-22', 1000, '2026-09-22').typical, null)
})

/* --------------------------------------------- the duplication is honest */

test('the client agrees with the server, case for case', () => {
  const cases = [
    ['2026-09-22', 1853], ['2026-09-22', 0], ['2026-09-21', 2400],
    ['2026-09-21', 0], ['2026-09-20', 1741], ['2026-01-01', 500],
  ]
  for (const [date, eaten] of cases) {
    assert.deepEqual(
      balanceFor(WHOOP, date, eaten, TODAY),
      server.balanceFor(WHOOP, date, eaten, { today: TODAY }),
      `drifted at ${date} / ${eaten}`,
    )
  }
})

console.log(`whoop: ${passed} passed`)
