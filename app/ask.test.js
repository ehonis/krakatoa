/*
 * node app/ask.test.js
 *
 * The Ask AI review list: what a ticked row becomes in the log, and what goes
 * back up when he asks for a change.
 */

import assert from 'node:assert'
import { basisLabel, itemTotal, previousOf, reviewOf, reviewTotals, ticked, toLog, updateItem } from './src/lib/ask.js'

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++ } catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1 }
}

const shake = {
  name: 'Protein shake', qty: 1, portion: '1 (your combo)', basis: 'yours', where: 'your combo', eaten: true,
  per: { kcal: 626, protein: 66.3, carbs: 43.1, fat: 21.4 }, matchId: 'y:combo-shake', parts: [],
  matched: { name: 'Protein shake', brand: null, source: 'combo', comboId: 'combo-shake', components: [{ name: 'Whey', qty: 2 }], portion: { id: 'combo', label: '1 (your combo)', kcal: 626, protein: 66.3, carbs: 43.1, fat: 21.4 } },
}
const burrito = {
  name: 'Chicken Burrito', qty: 1, portion: '1 burrito', basis: 'menu', where: 'Chipotle', eaten: true,
  per: { kcal: 1085, protein: 54, carbs: 110, fat: 44 }, components: [{ name: 'Chicken', qty: 1 }, { name: 'Flour Tortilla', qty: 1 }],
}
const horchata = { name: 'Horchata', qty: 2, portion: '1 large', basis: 'estimate', eaten: true, per: { kcal: 300, protein: 2, carbs: 60, fat: 5 }, confidence: 'medium' }
const milk = { name: 'Milk, 2%', qty: 1, portion: '1 cup', basis: 'basic', eaten: false, per: { kcal: 122, protein: 8.1, carbs: 11.7, fat: 4.8 } }

const review = () => reviewOf({ kind: 'receipt', place: 'Chipotle', items: [shake, burrito, horchata, milk], skipped: ['Tax'] })

test('what the AI marked not-eaten arrives unticked, and totals count only the ticked', () => {
  const r = review()
  assert.deepEqual(r.items.map(i => i.on), [true, true, true, false])
  assert.equal(reviewTotals(r).kcal, 626 + 1085 + 600)
  assert.equal(ticked(r).length, 3)
})

test('each basis says where its number came from', () => {
  const r = review()
  assert.deepEqual(r.items.map(basisLabel), ['Your food', 'Chipotle menu', 'AI estimate', 'USDA'])
  const edited = updateItem(r, r.items[2].key, { per: { ...horchata.per, kcal: 250 } })
  assert.equal(basisLabel(edited.items[2]), 'You edited', 'a number he typed is his, not the AI\'s')
  assert.equal(itemTotal(edited.items[2]).kcal, 500)
})

test('his combo logs AS his combo, remembering what went in', () => {
  const l = toLog(review().items[0], 'Chipotle')
  assert.equal(l.food.source, 'combo')
  assert.equal(l.food.comboId, 'combo-shake')
  assert.equal(l.food.brand, 'Chipotle')
  assert.equal(l.portion.kcal, 626)
  assert.equal(l.qty, 1)
})

test('a dish built from menu parts logs like a combo; an estimate logs as source "ai"', () => {
  const r = review()
  const b = toLog(r.items[1], 'Chipotle')
  assert.equal(b.food.source, 'combo')
  assert.equal(b.food.components.length, 2)
  assert.equal(b.portion.kcal, 1085)
  const h = toLog(r.items[2], 'El Sol Taqueria')
  assert.equal(h.food.source, 'ai')
  assert.equal(h.qty, 2)
  assert.equal(h.portion.kcal, 300, 'per ONE; the quantity carries the rest')
  assert.equal(toLog(r.items[3], null).food.source, 'basic')
})

test('an edited matched food logs his numbers, not the table\'s', () => {
  const r = review()
  const e = updateItem(r, r.items[0].key, { per: { ...shake.per, kcal: 500 } })
  const l = toLog(e.items[0], null)
  assert.equal(l.portion.kcal, 500)
  assert.equal(l.food.source, 'ai')
})

test('a revision starts from HIS version of the list', () => {
  let r = review()
  r = updateItem(r, r.items[1].key, { on: false })
  r = updateItem(r, r.items[2].key, { qty: 1, per: { ...horchata.per, kcal: 280 } })
  const p = previousOf(r)
  assert.equal(p.items[1].eaten, false, 'his untick')
  assert.equal(p.items[2].qty, 1, 'his quantity')
  assert.deepEqual([p.items[2].edited, p.items[2].per.kcal], [true, 280], 'his numbers')
  assert.equal(p.items[0].matchId, 'y:combo-shake', 'a match stays a match')
  assert.equal(p.items[0].per, undefined, 'an unedited match sends no numbers to be copied')
  assert.deepEqual(p.items[3].per, milk.per, 'an unmatched item keeps its numbers across turns')
})

console.log(`ask: ${passed} passed`)
