/*
 * node app/combos.test.js
 *
 * Saved meals and the basics catalog. Two things worth pinning hardest: that a
 * combo's totals are its components summed (nothing on screen re-derives them),
 * and that the basics search ranks the way a thumb needs it to.
 */

import assert from 'node:assert'
import fs from 'node:fs'
import {
  comboTotals, comboAsFood, comboSummary, componentsFromEntries, componentOf,
  suggestName, listCombos,
} from './src/lib/combos.js'
import { searchBasics, byCategory } from './src/lib/basics.js'
import { foodKey } from './src/lib/food.js'

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++ } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`)
    process.exitCode = 1
  }
}

const P = (kcal, protein = 0, carbs = 0, fat = 0, label = '1 serving') =>
  ({ id: label, label, kcal, protein, carbs, fat })

const EGGS = {
  id: 'combo-1',
  name: 'Scrambled eggs',
  components: [
    { name: 'Egg, whole, raw', portion: P(72, 6.3, 0.4, 4.8, '1 large'), qty: 4 },
    { name: 'Butter, salted', portion: P(102, 0.1, 0, 11.5, '1 tbsp'), qty: 1 },
    { name: 'Milk, whole', portion: P(9, 0.5, 0.7, 0.5, '1 tbsp'), qty: 1 },
  ],
}

/* ------------------------------------------------------------------ combos */

test('a meal costs what its components cost, times how many of each', () => {
  const t = comboTotals(EGGS.components)
  assert.equal(t.kcal, 4 * 72 + 102 + 9)
  assert.equal(t.protein, 25.8)
  assert.equal(t.fat, 31.2)
})

test('an empty meal is zero, not a crash', () => {
  assert.deepEqual(comboTotals([]), { kcal: 0, protein: 0, carbs: 0, fat: 0 })
  assert.deepEqual(comboTotals(null), { kcal: 0, protein: 0, carbs: 0, fat: 0 })
})

test('a meal becomes an ordinary food with ONE portion', () => {
  // This is what lets a combo travel through the same detail screen, quantity
  // stepper and log writer as a scanned bar. Half a batch is 0.5 of this portion
  // and needs no special case anywhere.
  const food = comboAsFood(EGGS)
  assert.equal(food.source, 'combo')
  assert.equal(food.comboId, 'combo-1')
  assert.equal(food.portions.length, 1)
  assert.equal(food.portions[0].label, '1 serving')
  assert.equal(food.portions[0].kcal, 399)
})

test('a meal borrows a photo from the first component that has one', () => {
  const withPic = comboAsFood({
    ...EGGS,
    components: [
      { name: 'Egg', portion: P(72), qty: 4 },
      { name: 'Butter', gtin: '123', image: 'https://images.openfoodfacts.org/b.jpg', portion: P(102), qty: 1 },
    ],
  })
  assert.ok(withPic.image.includes('openfoodfacts'))
  assert.equal(withPic.imageGtin, '123', 'and the barcode that photo belongs to')
  assert.equal(comboAsFood(EGGS).image, null, 'no component has one, so neither does the meal')
})

test('a meal has its own identity, distinct from any component', () => {
  // Otherwise "how many times have I had this" on the eggs would count the meal.
  assert.equal(foodKey(comboAsFood(EGGS)), 'c:combo-1')
  assert.notEqual(foodKey(comboAsFood(EGGS)), foodKey({ name: 'Egg, whole, raw' }))
})

test('logged entries turn back into components', () => {
  // The path that actually gets used: log the three things, then say it was a
  // meal. Nobody writes the recipe before they have cooked it.
  const comps = componentsFromEntries([
    { name: 'Egg', brand: null, gtin: null, portion: P(72), qty: 4, kcal: 288, meal: 'breakfast' },
    { name: 'Butter', portion: P(102), qty: 1, kcal: 102 },
  ])
  assert.equal(comps.length, 2)
  assert.equal(comps[0].qty, 4)
  assert.equal(comps[0].portion.kcal, 72)
  assert.equal(comps[0].meal, undefined, 'a component has no meal of its own — the meal does')
  assert.deepEqual(componentsFromEntries(null), [])
})

test('a component keeps the portion and quantity it was picked with', () => {
  const c = componentOf({ name: 'Milk, 2%', source: 'basic' }, P(122, 8, 12, 4.8, '1 cup'), 4)
  assert.equal(c.qty, 4)
  assert.equal(c.portion.label, '1 cup')
  assert.equal(componentOf({ name: 'x' }, P(1)).qty, 1, 'no quantity means one')
})

test('a nameless meal suggests one from what is in it', () => {
  // "Meal 1..9" is a list you have to open one at a time to use.
  assert.equal(suggestName([{ name: 'Egg, whole, raw' }]), 'Egg')
  assert.equal(suggestName(EGGS.components), 'Egg + 2 more')
  assert.equal(suggestName([]), '')
})

test('the summary names what is in it, and stops', () => {
  assert.equal(comboSummary(EGGS), 'Egg, whole, raw, Butter, salted, Milk, whole')
  assert.ok(comboSummary({ components: Array.from({ length: 6 }, (_, i) => ({ name: `f${i}` })) }).endsWith('+3 more'))
})

test('combos come out newest-used first, and tombstones do not come out at all', () => {
  const entries = {
    a: { kind: 'combo', data: { name: 'Old', components: [1], createdAt: '2026-01-01' } },
    b: { kind: 'combo', data: { name: 'Used', components: [1], createdAt: '2026-01-01', lastUsedAt: '2026-09-01' } },
    gone: { kind: 'combo', deleted: true, data: { name: 'Gone', components: [1] } },
    empty: { kind: 'combo', data: { name: 'Empty', components: [] } },
    food: { kind: 'food', data: { name: 'Not a combo' } },
  }
  const list = listCombos(entries)
  assert.deepEqual(list.map(c => c.name), ['Used', 'Old'])
})

/* ------------------------------------------------------------------ basics */

const catalog = JSON.parse(fs.readFileSync(new URL('../content/basics.json', import.meta.url)))
const foods = catalog.foods.map(f => ({ ...f, source: 'basic' }))

test('the catalog is real, sourced, and every food can be logged', () => {
  assert.ok(foods.length >= 100, `only ${foods.length} basics`)
  for (const f of foods) {
    assert.ok(f.portions.length, `${f.name} has no portions`)
    assert.ok(f.fdcId, `${f.name} has no USDA receipt`)
    for (const p of f.portions) {
      assert.ok(Number.isFinite(p.kcal), `${f.name} / ${p.label} has no energy`)
      assert.ok(p.kcal >= 0, `${f.name} / ${p.label} is negative`)
    }
    // 100 g is always available, so anything on a scale still logs.
    assert.ok(f.portions.some(p => p.id === '100g'), `${f.name} has no 100 g portion`)
  }
})

test('the portion a food leads with is a plausible serving', () => {
  // Ranking by unit put "1 cup" first for butter — 1,628 kcal, a portion nobody
  // has ever eaten. Nothing may lead with more than a whole meal's calories.
  for (const f of foods) {
    const lead = f.portions[0]
    assert.ok(lead.kcal <= 900, `${f.name} leads with ${lead.label} at ${lead.kcal} kcal`)
  }
})

test('the everyday foods say what a label says', () => {
  const by = Object.fromEntries(foods.map(f => [f.id, f]))
  const lead = (id) => by[id].portions[0]
  assert.equal(lead('egg-whole-raw').label, '1 large')
  assert.equal(lead('egg-whole-raw').kcal, 72)
  assert.equal(lead('butter-salted').label, '1 tbsp')
  assert.equal(lead('butter-salted').kcal, 102)
  assert.equal(lead('milk-whole').label, '1 cup')
  assert.equal(lead('milk-whole').kcal, 149)
})

test('searching ranks the generic food above the elaborate one', () => {
  const hits = searchBasics(foods, 'egg', 5)
  assert.ok(hits.length)
  assert.ok(hits[0].name.startsWith('Egg'), `got ${hits[0].name}`)
})

test('every word of a query has to match something', () => {
  // "peanut butter" must not return every butter — the failure that makes a
  // search feel broken.
  const hits = searchBasics(foods, 'peanut butter', 10)
  assert.ok(hits.length)
  for (const h of hits) {
    const hay = `${h.name} ${h.category} ${h.usdaName}`.toLowerCase()
    assert.ok(hay.includes('peanut'), `${h.name} has no peanut in it`)
  }
})

test('a search with nothing in it returns nothing, not everything', () => {
  assert.deepEqual(searchBasics(foods, ''), [])
  assert.deepEqual(searchBasics(foods, '   '), [])
  assert.deepEqual(searchBasics(foods, 'zzzzqqq'), [])
  assert.deepEqual(searchBasics([], 'egg'), [])
})

test('browsing covers the whole catalog — no food is unreachable', () => {
  // The same rule Bushido pins for its session picker: a food nothing lists is a
  // food that does not exist, and no render test can see that.
  const groups = byCategory({ categories: catalog.categories, foods })
  const shown = groups.flatMap(g => g.foods.map(f => f.id))
  assert.equal(new Set(shown).size, foods.length,
    `${foods.length - new Set(shown).size} foods are in no category`)
})

test('a donut is one search, without a donut chain', () => {
  // One donut from a bakery or gas station should not need a whole chain menu.
  const glazed = foods.find(f => f.name === 'Donut, glazed')
  assert.ok(glazed, 'a glazed donut')
  assert.ok(glazed.portions.some(p => /^1 donut/.test(p.label)), 'offered as one donut, not only by the ounce')
  assert.equal(searchBasics(foods, 'donut')[0].name.startsWith('Donut'), true)
  assert.ok(searchBasics(foods, 'doughnut').some(f => f.name === 'Donut, glazed'), "USDA's spelling finds it too")
  for (const n of ['Donut, jelly-filled', 'Croissant', 'Cheeseburger', 'French fries', 'Snickers', 'Brownie', 'Cola']) {
    assert.ok(foods.some(f => f.name === n), n)
  }
  const nuggets = foods.find(f => f.name === 'Chicken nuggets')
  assert.deepEqual(nuggets.portions.slice(0, 4).map(p => p.label), ['4 pieces', '6 pieces', '10 pieces', '20 pieces'])
})

test('no portion is a whole cake, and none says "NLEA"', () => {
  // A whole pecan pie is a real USDA measure (3,390 kcal) and never what one
  // person means by a slice of it.
  for (const f of foods) {
    for (const p of f.portions) {
      assert.ok(p.kcal <= 1500 || p.label === '100 g', `${f.name}: ${p.label} is ${p.kcal} kcal`)
      assert.ok(!/NLEA|servings per|=/.test(p.label), `${f.name}: "${p.label}"`)
    }
  }
})

console.log(`combos + basics: ${passed} passed`)
