/*
 * node server/nutritionix.test.js
 *
 * The restaurant normalizers, against Nutritionix's documented payload shapes.
 * This is the one integration in the app that cannot be checked against a live
 * response without a key, so the shapes below are the contract: if the
 * live API disagrees with them, THESE are what to fix.
 */

const assert = require('assert')
const N = require('./nutritionix.js')

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++ } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`)
    process.exitCode = 1
  }
}

/* A /v2/search/instant branded row: a list entry, calories and nothing else. */
const BRANDED = {
  food_name: 'Chicken Burrito Bowl',
  brand_name: 'Chipotle Mexican Grill',
  nix_item_id: '5a6e5b1c1b2d3c4e5f6a7b8c',
  serving_qty: 1,
  serving_unit: 'bowl',
  serving_weight_grams: 510,
  nf_calories: 630,
}

/* A /v2/search/item food: the same thing with its macros. */
const ITEM = {
  food_name: 'Chicken Burrito Bowl',
  brand_name: 'Chipotle Mexican Grill',
  nix_item_id: '5a6e5b1c1b2d3c4e5f6a7b8c',
  serving_qty: 1,
  serving_unit: 'bowl',
  serving_weight_grams: 510,
  nf_calories: 630,
  nf_protein: 46,
  nf_total_carbohydrate: 58,
  nf_total_fat: 22.5,
  nf_dietary_fiber: 10,
  nf_sugars: 4,
  nf_sodium: 1560,
}

test('a search row carries calories and is flagged as NOT loggable', () => {
  // The flag is the contract with the client. Without it a restaurant item would
  // log as 0 g of protein and look perfectly fine on screen.
  const f = N.fromBranded(BRANDED)
  assert.equal(f.partial, true)
  assert.equal(f.source, 'restaurant')
  assert.equal(f.brand, 'Chipotle Mexican Grill')
  assert.equal(f.portions[0].kcal, 630)
  assert.equal(f.portions[0].protein, null, 'macros are not known yet, and say so')
  assert.equal(f.nixItemId, BRANDED.nix_item_id)
})

test('a full item is loggable and carries every macro', () => {
  const f = N.fromItem(ITEM)
  assert.equal(f.partial, false)
  const s = f.portions[0]
  assert.equal(s.label, 'bowl')
  assert.equal(s.kcal, 630)
  assert.equal(s.protein, 46)
  assert.equal(s.carbs, 58)
  assert.equal(s.fat, 22.5)
  assert.equal(s.sodium, 1560)
})

test('100 g is derived only where the serving WEIGHT is known', () => {
  // Scaling "1 bowl" to 100 g without knowing what a bowl weighs would be
  // inventing a density — the same rule the USDA millilitre case follows.
  const withWeight = N.fromItem(ITEM)
  const per100 = withWeight.portions.find(p => p.id === '100g')
  assert.ok(per100, 'a 510 g bowl can be expressed per 100 g')
  assert.equal(per100.kcal, Math.round(630 * 100 / 510))

  const noWeight = N.fromItem({ ...ITEM, serving_weight_grams: null })
  assert.equal(noWeight.portions.length, 1, 'no weight, no 100 g portion')
})

test('a serving of more than one says so in its label', () => {
  const f = N.fromItem({ ...ITEM, serving_qty: 2, serving_unit: 'taco' })
  assert.equal(f.portions[0].label, '2 taco')
})

test('no energy is a miss, not an empty food', () => {
  assert.equal(N.fromBranded({ ...BRANDED, nf_calories: null }), null)
  assert.equal(N.fromItem({ ...ITEM, nf_calories: undefined }), null)
})

test('no key is a normal state, not an error', () => {
  // Everything else in the app keeps working without it, so this path must be
  // quiet rather than throwing into a screen.
  assert.equal(N.credsFrom({}), null)
  assert.equal(N.credsFrom({ nutritionixId: 'only-one-half' }), null)
  assert.deepEqual(N.credsFrom({ nutritionixId: 'a', nutritionixKey: 'b' }), { id: 'a', key: 'b' })
})

/* The unconfigured paths must resolve quietly and must not reach the network. */
;(async () => {
  try {
    assert.deepEqual(await N.search('chipotle', {}), { foods: [], configured: false })
    assert.equal(await N.item('abc', {}), null)
    passed++
  } catch (e) {
    console.error(`FAIL  no key resolves quietly\n      ${e.message}`)
    process.exitCode = 1
  }
  console.log(`nutritionix: ${passed} passed`)
})()
