/*
 * node app/balance.test.jsx  (via esbuild — see package.json)
 *
 * The energy panel, rendered in each of its four states. The bar is the only
 * place in this app where a number becomes a SHAPE, so what is pinned here is
 * that the shape cannot say something the numbers do not.
 */

import assert from 'node:assert'
import { renderToStaticMarkup } from 'react-dom/server'
import { Balance } from './src/today.jsx'

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++ } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`)
    process.exitCode = 1
  }
}

const render = (balance, extra = {}) => renderToStaticMarkup(<Balance balance={balance} {...extra} />)

/** The eaten bar's width, as a number. */
const eatenWidth = (html) => {
  const m = html.match(/tug-fill tug-eaten"[^>]*width:\s*([\d.]+)%/)
  return m ? Number(m[1]) : null
}

test('equal numbers meet dead centre', () => {
  const html = render({ eaten: 2000, burned: 2000, net: 0, partial: false, untracked: false, typical: 2400 })
  assert.equal(eatenWidth(html), 50)
})

test('burning more pulls the join LEFT of even', () => {
  const html = render({ eaten: 1853, burned: 2027, net: -174, partial: true, untracked: false, typical: 2485 })
  assert.ok(eatenWidth(html) < 50, `join at ${eatenWidth(html)}%`)
  assert.ok(html.includes('even'), 'and the reference it is read against is on screen')
})

test('eating more pushes the join RIGHT of even', () => {
  const html = render({ eaten: 3000, burned: 2000, net: 1000, partial: false, untracked: false, typical: 2400 })
  assert.ok(eatenWidth(html) > 50, `join at ${eatenWidth(html)}%`)
})

test('a lopsided day still shows a sliver of the losing colour', () => {
  // A bar that reads as one solid block has stopped being a comparison.
  const tiny = render({ eaten: 20, burned: 3000, net: -2980, partial: false, untracked: false, typical: 2400 })
  assert.ok(eatenWidth(tiny) >= 3, `clamped to ${eatenWidth(tiny)}%`)
  const huge = render({ eaten: 6000, burned: 100, net: 5900, partial: false, untracked: false, typical: 2400 })
  assert.ok(eatenWidth(huge) <= 97, `clamped to ${eatenWidth(huge)}%`)
})

test('an UNTRACKED day draws no bar at all', () => {
  // Drawing one would fill the track with burn and read as an enormous deficit,
  // which is the exact lie the flag exists to prevent: he did not eat nothing,
  // he did not say what he ate.
  const html = render({ eaten: 0, burned: 2816, net: -2816, partial: false, untracked: true, typical: 2400 })
  assert.ok(!html.includes('tug-fill'), 'no bar')
  assert.ok(html.includes('Nothing logged'))
})

test('a partial day states no verdict, only the count so far', () => {
  const html = render({ eaten: 1853, burned: 1890, net: -37, partial: true, untracked: false, typical: 2485 })
  assert.ok(html.includes('2,485'), 'the average complete day is the yardstick')
  assert.ok(!/kcal (under|over)</.test(html), 'a clock is not a verdict')
  assert.ok(html.includes('burned so far'), 'and the partial-ness is said on the label')
  // "Still counting — WHOOP keeps adding to the burn until midnight" was removed
  // as the third statement of the same fact in one card.
  assert.ok(!html.includes('Still counting'))
})

test('a partial day with no yardstick yet says nothing rather than something empty', () => {
  const html = render({ eaten: 1853, burned: 1890, net: -37, partial: true, untracked: false, typical: null })
  assert.ok(html.includes('tug-fill'), 'the bar is still the point')
  assert.ok(!html.includes('usually finish'))
})

test('a completed tracked day states the verdict plainly', () => {
  const under = render({ eaten: 2100, burned: 2816, net: -716, partial: false, untracked: false, typical: 2400 })
  assert.ok(under.includes('716'))
  assert.ok(under.includes('under'))
  const over = render({ eaten: 3200, burned: 2400, net: 800, partial: false, untracked: false, typical: 2400 })
  assert.ok(over.includes('800') && over.includes('over'))
})

test('no balance at all renders nothing, not an empty panel', () => {
  assert.equal(render(null), '')
})

test('the estimate is labelled as one, in every state', () => {
  for (const b of [
    { eaten: 100, burned: 200, net: -100, partial: false, untracked: false, typical: 2400 },
    { eaten: 0, burned: 200, net: -200, partial: false, untracked: true, typical: 2400 },
  ]) {
    assert.ok(render(b).includes('not a measurement'))
  }
})

/* ------------------------------------------------------------- the refresh */

const OK = { eaten: 2100, burned: 2816, net: -716, partial: false, untracked: false, typical: 2400 }

test('the refresh button is there only when something can do the refreshing', () => {
  assert.ok(!render(OK).includes('Refresh from WHOOP'), 'no handler, no button')
  assert.ok(render(OK, { onRefresh: () => {} }).includes('Refresh from WHOOP'))
})

test('it says how stale the number is, because a button that tells you nothing is not one', () => {
  const html = render(OK, { onRefresh: () => {}, whoop: { fetchedAt: new Date().toISOString() } })
  assert.ok(html.includes('just now'), html.slice(0, 200))
  const old = render(OK, {
    onRefresh: () => {},
    whoop: { fetchedAt: new Date(Date.now() - 90 * 60000).toISOString() },
  })
  assert.ok(/2 h ago/.test(old), old.slice(0, 300))
})

test('a stale instant that makes no sense says nothing rather than something wrong', () => {
  const future = render(OK, { onRefresh: () => {}, whoop: { fetchedAt: new Date(Date.now() + 9e6).toISOString() } })
  assert.ok(!future.includes('ago'))
  assert.ok(!render(OK, { onRefresh: () => {}, whoop: { fetchedAt: 'nonsense' } }).includes('ago'))
})

test('a failed pull keeps the numbers AND says why they did not move', () => {
  // The previous cache survives on the server, so the balance above is still
  // real — this only explains the staleness, in WHOOP's own words.
  const html = render(OK, { onRefresh: () => {}, whoop: { error: 'reconnect WHOOP to grant read:cycles' } })
  assert.ok(html.includes('716'), 'the real numbers are still there')
  assert.ok(html.includes('reconnect WHOOP'), 'and the reason the refresh failed')
})

test('with NO balance at all, an error still renders a panel with a way out', () => {
  // This is the state someone presses refresh to escape. Rendering nothing would
  // leave a bridge that is down looking exactly like a feature that is off.
  const html = render(null, { onRefresh: () => {}, whoop: { error: 'no BRIDGE_SECRET found' } })
  assert.ok(html.includes('no BRIDGE_SECRET found'))
  assert.ok(html.includes('Refresh from WHOOP'))
  // …but no error and no balance is still nothing, as before.
  assert.equal(render(null, { onRefresh: () => {}, whoop: { burn: {} } }), '')
})

console.log(`balance: ${passed} passed`)
