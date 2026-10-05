/*
 * node app/restaurants.test.js
 *
 * The chain menus and the orders built from them. The catalog tests check the
 * file the build script wrote against the source it came from — each chain's
 * numbers here were read off its own document by hand — and the bowl tests
 * check the adding-up, which is every number the builder shows.
 */

import assert from 'node:assert'
import fs from 'node:fs'
import {
  addToBowl, removeFromBowl, effectiveQty, bowlTotals, bowlName, bowlComponents, bowlVessel, searchMenus, stepSize, selKey,
} from './src/lib/restaurants.js'
import { splitSize } from '../scripts/restaurants/mcd-archive.mjs'
import { splitSize as paneraSize } from '../scripts/restaurants/panera-pdf.mjs'

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++ } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`)
    process.exitCode = 1
  }
}

const portionLabel = (item, pid) => item.portions.find(p => p.id === pid)?.label
const CATALOG = new URL('../content/restaurants.json', import.meta.url)
if (!fs.existsSync(CATALOG)) {
  // The chain menus are optional and not every copy ships them. Nothing here
  // can be checked without them.
  console.log('restaurants: skipped (content/restaurants.json is not built; optional, see `npm run build:menus`)')
  process.exit(0)
}
const catalog = JSON.parse(fs.readFileSync(CATALOG))
const chain = catalog.chains.find(c => c.id === 'bibibop')
const byName = (name, cat) => chain.items.find(i => i.name === name && (!cat || i.category === cat))
const BOWL = chain.sizes.find(s => s.id === 'bowl')
const CUP = chain.sizes.find(s => s.id === 'cup')

/* ------------------------------------------------------------ the catalog */

test('every table in the PDF came through, in full', () => {
  // Counted off BIBIBOP-Nutrition-Updated-8.19.26.pdf by hand. A parser that
  // drops a row does it silently, so the count is the check.
  const count = {}
  for (const i of chain.items) count[i.category] = (count[i.category] || 0) + 1
  assert.deepEqual(count, {
    Bases: 5, Proteins: 7, 'Hot toppings': 5, 'Cold toppings': 10,
    Sauces: 6, Sides: 6, Desserts: 2, Drinks: 17,
  })
})

test('the steak is what the PDF says it is', () => {
  // "Steak (5oz) 240 100 11 4 0 75 675 13 0 10 23"
  const p = byName('Steak').portions[0]
  assert.equal(p.label, '5 oz')
  assert.deepEqual([p.kcal, p.fat, p.satFat, p.cholesterol, p.sodium, p.carbs, p.fiber, p.sugar, p.protein],
    [240, 11, 4, 75, 675, 13, 0, 10, 23])
})

test('a name that wrapped across three lines of the PDF is whole', () => {
  // "Korean Crispy" / 140 ... / "Chicken (5oz)" — the fragment above AND below.
  assert.ok(byName('Korean Crispy Chicken'))
  assert.equal(byName('Korean Crispy Chicken').portions[0].kcal, 140)
  assert.ok(byName('Citrus Honey Kale', 'Bases'), 'three fragments: "Citrus Honey" / "Kale" / "(4oz)"')
})

test('no table title leaked into an item name', () => {
  // "1/3 cup ice)" once became the first word of "Coca-Cola Classic".
  for (const i of chain.items) {
    assert.ok(!/\)\s|^\W|cup ice|Calories|from Fat/i.test(i.name), `"${i.name}"`)
  }
  assert.ok(byName('Coca-Cola Classic'))
  assert.ok(byName('Diet Coca-Cola'), 'a hyphen at a line break joins, it does not become "Coca- Cola"')
})

test('the drinks at the foot of the last page were not dropped', () => {
  // Their tables start further left than the food tables; measured per page,
  // the name/value edge was wrong for them and both rows vanished.
  assert.ok(byName('Honest Kids Appley Ever After'))
  assert.ok(chain.items.some(i => /Kombucha/.test(i.name)))
})

test('every item can be logged and says where it came from', () => {
  assert.ok(chain.source.url.endsWith('.pdf'))
  assert.match(chain.source.published, /^\d{4}-\d{2}-\d{2}$/)
  for (const i of chain.items) {
    assert.ok(Number.isFinite(i.portions[0].kcal), `${i.name} has no energy`)
    assert.ok(i.step, `${i.name} belongs to no step of a bowl`)
    assert.equal(i.source, 'restaurant')
  }
  assert.equal(new Set(chain.items.map(i => i.id)).size, chain.items.length, 'ids are unique')
})

test('a fluid ounce is not turned into grams', () => {
  // Weight only for weight. A fl oz of sauce is a volume, and converting it
  // would be a guess about its density.
  assert.equal(byName('Gochujang').portions[0].grams, null)
  assert.ok(Math.abs(byName('Steak').portions[0].grams - 141.7) < 0.1, '5 oz of steak is 141.7 g')
})

/* --------------------------------------------------------------- the bowl */

const STEAK = byName('Steak')
const RICE = byName('Purple Rice')
const WHITE = byName('White Rice')
const CHICKEN = byName('Chicken', 'Proteins')

const sample = () => {
  let s = {}
  for (const n of [['Purple Rice'], ['Steak'], ['Roasted Sesame Broccoli'], ['Avocado'], ['Eggs'], ['Carrots'], ['Gochujang']]) {
    s = addToBowl(s, byName(...n), chain)
  }
  return s
}

test('a steak bowl adds up to the sum of its parts', () => {
  // 350 + 240 + 60 + 90 + 40 + 15 + 70, off the PDF.
  const t = bowlTotals(chain, sample(), BOWL)
  assert.equal(t.kcal, 865)
  assert.equal(t.protein, 38.5)
  assert.equal(t.carbs, 111)
  assert.equal(t.fat, 30.5)
  assert.equal(t.sodium, 1740)
})

test('a bibiCup halves the BASE and nothing else', () => {
  // "THE BASE CALORIES FOR BIBICUP = ½ PORTIONS" — and that is all the chain
  // says shrinks, so halving the steak too would be a guess.
  assert.equal(effectiveQty(RICE, 1, CUP), 0.5)
  assert.equal(effectiveQty(STEAK, 1, CUP), 1)
  assert.equal(bowlTotals(chain, sample(), CUP).kcal, 865 - 175)
})

test('a second base splits the bowl into halves', () => {
  let s = addToBowl({}, RICE, chain)
  assert.equal(s[selKey(RICE)], 1)
  s = addToBowl(s, WHITE, chain)
  assert.equal(s[selKey(RICE)], 0.5, 'the first base becomes a half')
  assert.equal(s[selKey(WHITE)], 0.5, 'and so does the second')
  assert.equal(bowlTotals(chain, s, BOWL).kcal, Math.round(350 / 2 + 370 / 2))
})

test('a base steps in halves; a protein steps in wholes', () => {
  assert.equal(stepSize(chain, 'base'), 0.5)
  assert.equal(stepSize(chain, 'protein'), 1)
  let s = addToBowl({}, STEAK, chain)
  s = addToBowl(s, STEAK, chain)
  assert.equal(s[selKey(STEAK)], 2, 'double steak')
  assert.equal(bowlTotals(chain, s, BOWL).kcal, 480)
})

test('taking the last of something takes it out of the bowl', () => {
  let s = addToBowl({}, STEAK, chain)
  s = removeFromBowl(s, STEAK, chain)
  assert.deepEqual(s, {})
  assert.deepEqual(removeFromBowl({}, STEAK, chain), {}, 'removing what is not there is nothing')
})

test('the bowl is named the way you would say it', () => {
  assert.equal(bowlName(chain, sample(), BOWL), 'Bibibop · Steak bowl')
  assert.equal(bowlName(chain, sample(), CUP), 'Bibibop · Steak bibiCup')
  const two = addToBowl(addToBowl({}, STEAK, chain), CHICKEN, chain)
  assert.equal(bowlName(chain, two, BOWL), 'Bibibop · Steak & Chicken bowl')
  assert.equal(bowlName(chain, addToBowl({}, RICE, chain), BOWL), 'Bibibop · Purple Rice bowl')
  assert.equal(bowlName(chain, addToBowl({}, byName('Sprite'), chain), BOWL), 'Bibibop · Order',
    'a drink on its own is not a bowl')
})

test('components carry the EFFECTIVE quantity, in bowl order', () => {
  // So a saved bibiCup adds up to exactly what the builder showed, with no size
  // to remember anywhere downstream.
  const cs = bowlComponents(chain, sample(), CUP)
  assert.equal(cs[0].name, 'Purple Rice', 'base first')
  assert.equal(cs[0].qty, 0.5, 'half a portion in a bibiCup')
  assert.equal(cs[1].name, 'Steak')
  assert.equal(cs[1].qty, 1)
  assert.equal(cs.at(-1).name, 'Gochujang', 'sauce last')
  assert.ok(cs.every(c => c.brand === 'Bibibop'))
  const sum = cs.reduce((n, c) => n + c.portion.kcal * c.qty, 0)
  assert.equal(Math.round(sum), 690)
})

test('an empty bowl is zero, not a crash', () => {
  assert.equal(bowlTotals(chain, {}, BOWL).kcal, 0)
  assert.deepEqual(bowlComponents(chain, {}, BOWL), [])
  assert.equal(bowlTotals(chain, { 'no-such-item@p0': 3 }, BOWL).kcal, 0, 'an id not on the menu is ignored')
})

/* ------------------------------------------------------------ Chipotle */

const chip = catalog.chains.find(c => c.id === 'chipotle')
const C = (name) => chip.items.find(i => i.name === name)

test('Chipotle: the table came through, and the kids table did not leak into it', () => {
  // US-Nutrition-Facts-Paper-Menu-3-2025.pdf. The kids table repeats every
  // ingredient at kids portions under the SAME names — "Chicken 2 oz 90" — and
  // read as the main table it gives the chicken a second, wrong row.
  const chicken = C('Chicken')
  assert.equal(chicken.portions.length, 1)
  assert.deepEqual(
    [chicken.portions[0].label, chicken.portions[0].kcal, chicken.portions[0].fat, chicken.portions[0].carbs, chicken.portions[0].protein, chicken.portions[0].sodium],
    ['4 oz', 180, 7, 0, 32, 310])
  assert.equal(C('Steak').portions[0].kcal, 150)
  assert.equal(C('Cilantro-Lime White Rice').portions[0].kcal, 210)
  assert.ok(!chip.items.some(i => /Mandarins|Organic Milk|Quesadilla/.test(i.name)), 'nothing only on the kids menu')
})

test('Chipotle: one PDF row can be two things he orders', () => {
  // "Guacamole (topping/side) 4 oz 230" is guac IN the bowl and guac on the side.
  assert.equal(C('Guacamole').step, 'toppings')
  assert.deepEqual(C('Side of Guacamole').portions.map(p => [p.label, p.kcal]), [['Side · 4 oz', 230], ['Large · 8 oz', 460]])
  assert.deepEqual(C('Chips').portions.map(p => p.kcal), [540, 810])
  assert.deepEqual(C('Coca-Cola Classic').portions.map(p => p.label), ['Regular · 22 fl oz', 'Large · 32 fl oz'])
})

test('Chipotle: a burrito is named a burrito, and weighs its tortilla', () => {
  const tortilla = C('Flour Tortilla')
  const burrito = tortilla.portions.find(p => p.vessel === 'burrito')
  const taco = tortilla.portions.find(p => p.vessel === 'tacos')
  let s = addToBowl({}, tortilla, chip, burrito.id)
  s = addToBowl(s, C('Cilantro-Lime White Rice'), chip)
  s = addToBowl(s, C('Black Beans'), chip)
  s = addToBowl(s, C('Chicken'), chip)
  s = addToBowl(s, C('Fresh Tomato Salsa'), chip)
  s = addToBowl(s, C('Cheese'), chip)
  assert.equal(bowlName(chip, s), 'Chipotle · Chicken burrito')
  // 320 + 210 + 130 + 180 + 25 + 110
  assert.equal(bowlTotals(chip, s).kcal, 975)
  const bowl = removeFromBowl(s, tortilla, chip, burrito.id)
  assert.equal(bowlName(chip, bowl), 'Chipotle · Chicken bowl', 'no tortilla is a bowl')
  assert.equal(bowlTotals(chip, bowl).kcal, 655)
  let tacos = addToBowl({}, tortilla, chip, taco.id)
  tacos = addToBowl(addToBowl(addToBowl(tacos, tortilla, chip, taco.id), tortilla, chip, taco.id), C('Steak'), chip)
  assert.equal(bowlName(chip, tacos), 'Chipotle · Steak tacos')
  assert.equal(bowlTotals(chip, tacos).kcal, 3 * 80 + 150)
})

test('Chipotle: half and half rice, and double chicken', () => {
  let s = addToBowl({}, C('Cilantro-Lime White Rice'), chip)
  s = addToBowl(s, C('Cilantro-Lime Brown Rice'), chip)
  assert.equal(s[selKey(C('Cilantro-Lime White Rice'))], 0.5)
  s = addToBowl(addToBowl(s, C('Chicken'), chip), C('Chicken'), chip)
  assert.equal(bowlTotals(chip, s).kcal, 210 + 360)
  assert.equal(bowlVessel(chip, addToBowl({}, C('Chips'), chip)), null, 'chips alone are not a bowl')
})

/* ------------------------------------------------------------ Culver's */

const culv = catalog.chains.find(c => c.id === 'culvers')
const U = (name) => culv.items.find(i => i.name === name)

test("Culver's: sizes are portions of one item, in the order they are ordered", () => {
  const deluxe = U("The Culver's Deluxe")
  assert.deepEqual(deluxe.portions.map(p => p.label), ['Single', 'Double', 'Triple'])
  // Raw 576.42 in the hosted menu; label-rounded to what the board prints.
  assert.deepEqual([deluxe.portions[0].kcal, deluxe.portions[0].protein, deluxe.portions[0].carbs, deluxe.portions[0].fat], [580, 24, 41, 34])
  assert.equal(deluxe.defaultPortion, deluxe.portions[0].id, 'a single, unasked')
  const fries = U('Crinkle Cut Fries')
  assert.deepEqual(fries.portions.map(p => p.label), ['Small', 'Medium', 'Large', 'Family'])
  assert.equal(portionLabel(fries, fries.defaultPortion), 'Medium', 'a medium fry, unasked — not the small')
  assert.deepEqual(U('Original Chicken Tenders').portions.map(p => p.label), ['1 Piece', '2 Piece', '4 Piece', '8 Piece'])
  assert.ok(!culv.items.some(i => /CurderBurger|Preview/.test(i.name)), 'the test kitchen is not the menu')
  assert.ok(!culv.items.some(i => /&|reg\b/.test(i.name.replace(/ & /g, ''))), 'no entity left in a name, with or without its semicolon')
})

test("Culver's: an order is named off its first two things", () => {
  const deluxe = U("The Culver's Deluxe")
  const fries = U('Crinkle Cut Fries')
  let s = addToBowl({}, deluxe, culv, deluxe.portions[1].id)
  s = addToBowl(s, fries, culv, fries.defaultPortion)
  assert.equal(bowlName(culv, s), "Culver's · The Culver's Deluxe, Double + Crinkle Cut Fries, Medium")
  s = addToBowl(s, fries, culv, fries.portions.find(p => p.label === 'Large').id)
  assert.match(bowlName(culv, s), /\+ 1 more$/)
  assert.equal(bowlVessel(culv, s), null)
  const cs = bowlComponents(culv, s)
  assert.deepEqual(cs.map(c => c.name), ["The Culver's Deluxe, Double", 'Crinkle Cut Fries, Medium', 'Crinkle Cut Fries, Large'],
    'two sizes of fries are two lines, each saying which')
  assert.equal(bowlTotals(culv, s).kcal, cs.reduce((n, c) => n + c.portion.kcal * c.qty, 0))
})

/* ---------------------------------------------------------- McDonald's */

const mcd = catalog.chains.find(c => c.id === 'mcdonalds')
const M = (name) => mcd.items.find(i => i.name === name)

test("McDonald's: the core menu, with McDonald's own numbers", () => {
  // dnaapp/itemList as archived. `value` is the figure McDonald's displays.
  const bigMac = M('Big Mac')
  assert.deepEqual([bigMac.portions[0].kcal, bigMac.portions[0].protein], [580, 25])
  const fries = M('French Fries')
  assert.deepEqual(fries.portions.map(p => [p.label, p.kcal]), [['Kids', 110], ['Small', 230], ['Medium', 320], ['Large', 480]])
  assert.equal(fries.portions.find(p => p.id === fries.defaultPortion).label, 'Medium')
  assert.deepEqual(M('Chicken McNuggets').portions.map(p => p.label).slice(0, 3), ['4 piece', '6 piece', '10 piece'])
  assert.ok(!mcd.items.some(i => /\(mhq\)|Grimace|No Ice|§|&reg/i.test(i.name)), 'no test kitchen, promotions, no-ice variants or stray marks')
  assert.ok(!mcd.items.some(i => i.step === 'sauces' && /latte|coffee/i.test(i.name)), 'a latte is not a sauce')
  assert.ok(mcd.items.every(i => /^\d{4}-\d{2}-\d{2}$/.test(i.capturedAt)), 'every item keeps the date it was captured')
  assert.ok(mcd.source.from < mcd.source.published)
})

test("McDonald's: sizes are found where McDonald's puts them, and nowhere else", () => {
  assert.deepEqual(splitSize('Small French Fries'), { name: 'French Fries', size: 'Small' })
  assert.deepEqual(splitSize('Diet Coke (Small)'), { name: 'Diet Coke', size: 'Small' })
  assert.deepEqual(splitSize('Chicken McNuggets® (4 piece)'), { name: 'Chicken McNuggets', size: '4 piece' })
  assert.deepEqual(splitSize("McDonald's Lemonade (16 Oz.)"), { name: "McDonald's Lemonade", size: '16 oz' })
  assert.equal(splitSize('Honest Kids Appley Ever After').size, null, 'KIDS in the middle is a brand, not a size')
  assert.equal(splitSize('Big Mac').size, null)
})

/* -------------------------------------------------------------- Panera */

const pan = catalog.chains.find(c => c.id === 'panera')
const P = (name) => pan.items.find(i => i.name === name)
const P1 = (item, label) => item.portions.find(p => p.label.startsWith(label))

test('Panera: numbers are the guide’s own (c6-26, effective 6/17/2026)', () => {
  // "Asiago Cheese Bagel  1 Bagel  350 80 9 4 0 15 660 55 3 5 14 N/A"
  const bagel = P('Asiago Cheese Bagel').portions[0]
  assert.deepEqual([bagel.kcal, bagel.fat, bagel.satFat, bagel.cholesterol, bagel.sodium, bagel.carbs, bagel.fiber, bagel.sugar, bagel.protein],
    [350, 9, 4, 15, 660, 55, 3, 5, 14])
  const brocc = P('Broccoli Cheddar')
  assert.deepEqual(brocc.portions.map(p => [p.label.split(' · ')[0], p.kcal]), [['Cup', 280], ['Bowl', 420], ['Bread Bowl', 930]],
    '"Broccoli Cheddar - Cup" and "Broccoli Cheddar Soup - Bread Bowl" are one soup')
  assert.equal(brocc.portions.find(p => p.id === brocc.defaultPortion).label.split(' · ')[0], 'Bowl')
  const rancher = P('Chicken Bacon Rancher on Black Pepper Focaccia')
  assert.deepEqual([P1(rancher, 'Half').kcal, P1(rancher, 'Whole').kcal], [510, 1010])
  assert.equal(rancher.portions.find(p => p.id === rancher.defaultPortion).label.split(' · ')[0], 'Whole')
})

test('Panera: a wrapped name is whole, and a blank cell stays blank', () => {
  // "Honey Walnut Cream Cheese Spread -" / numbers / "1.5 oz" — three lines.
  assert.equal(P('Honey Walnut Cream Cheese Spread').portions.length, 2)
  assert.ok(P('Chipotle Chicken, Egg & Avo on Artisan Ciabatta'), 'wrapped across three lines')
  // The bottled tea prints no fibre figure; read by count, its sugar would
  // have slid into the fibre column.
  const tea = P('Bottled Passionfruit Papaya Naturally Flavored Iced Green Tea').portions[0]
  assert.equal(tea.fiber, null)
  assert.equal(tea.sugar, 28)
  assert.equal(tea.carbs, 31)
})

test('Panera: no kids repeats, no drive-thru duplicates, no catering trays, names the right way round', () => {
  assert.ok(!pan.items.some(i => /^Drive/i.test(i.name)))
  assert.ok(!pan.items.some(i => i.portions.some(p => /group|serves \d/i.test(p.label))))
  assert.ok(!pan.items.some(i => /^(Cookie|Muffin|Pastry|Sauce|Dressing|Side) - /.test(i.name)), 'no back-to-front names')
  assert.ok(!pan.items.some(i => /-(Half|Whole|Cup|Bowl)\b|- Portion|&apos;/.test(i.name)), 'no size left glued to a name')
  assert.ok(P('Candy Cookie') && P("Lil' Lemon Bundt Cake"))
  assert.equal(P('Greek').portions.length, 3, 'the sandwich portion and both salad cups of one dressing')
})

test('Panera: sizes are split off the name', () => {
  assert.deepEqual(paneraSize('Asian Sesame Chicken - Half'), { name: 'Asian Sesame Chicken', size: 'Half', group: false })
  assert.deepEqual(paneraSize('Ciabatta Cheesesteak on Ciabatta-Whole'), { name: 'Ciabatta Cheesesteak on Ciabatta', size: 'Whole', group: false })
  assert.equal(paneraSize('Asian Sesame Chicken- Half (no nuts)').name, 'Asian Sesame Chicken (no nuts)')
  assert.equal(paneraSize('Market Bowl - Sesame Ginger Chicken - Half - No Almonds').name, 'Market Bowl - Sesame Ginger Chicken - No Almonds')
  assert.equal(paneraSize('Asian Sesame Vinaigrette - Half Portion').name, 'Asian Sesame Vinaigrette')
  assert.equal(paneraSize('Agave Lemonade - Serves 4 - Group').group, true)
  assert.equal(paneraSize('Chipotle-Honey Vinaigrette').size, null, 'a hyphen inside a word is not a separator')
})

/* --------------------------------------------- Balance Pan-Asian Grille */

const bal = catalog.chains.find(c => c.id === 'balance')
const B = (name) => bal.items.find(i => i.name === name)

test("Balance: its own July 2025 figures, and a bowl is base + protein + starch", () => {
  // balance.menu, as archived 2025-07-21: green curry 300 / 6 P / 18 C / 24 F.
  const curry = B('Green Curry').portions[0]
  assert.deepEqual([curry.kcal, curry.protein, curry.carbs, curry.fat], [300, 6, 18, 24])
  assert.equal(B('Grilled Chicken').portions[0].kcal, 187)
  assert.equal(bal.items.length, 30)
  assert.ok(!bal.items.some(i => /Choose|Option|Vegan|Gluten/.test(i.name)), 'no dietary badge read as an item')
  let s = addToBowl({}, B('Green Curry'), bal)
  s = addToBowl(s, B('Grilled Chicken'), bal)
  s = addToBowl(s, B('Brown Rice'), bal)
  s = addToBowl(s, B('White Rice'), bal)
  assert.equal(bowlTotals(bal, s).kcal, 300 + 187 + 135 + 180, 'half and half: 270/2 + 360/2')
  assert.equal(bowlName(bal, s), 'Balance · Green Curry & Grilled Chicken bowl')
})

/* ---------------------------------------------------------- every chain */

test('every chain says where its numbers came from, and every item can be logged', () => {
  for (const c of catalog.chains) {
    assert.ok(c.source.what, `${c.id} names its source`)
    assert.match(c.source.published || '', /^\d{4}-\d{2}-\d{2}$/, `${c.id} dates its source`)
    const steps = new Set(c.steps.map(s => s.id))
    for (const i of c.items) {
      assert.ok(steps.has(i.step), `${c.id}: ${i.name} is on no step`)
      assert.ok(i.portions.length && i.portions.every(p => Number.isFinite(p.kcal)), `${c.id}: ${i.name} has no energy`)
      assert.ok(i.portions.some(p => p.id === i.defaultPortion), `${c.id}: ${i.name} opens on a size it does not have`)
      assert.equal(i.brand, c.short)
    }
    assert.equal(new Set(c.items.map(i => i.id)).size, c.items.length, `${c.id}: ids are unique`)
  }
})

/* ------------------------------------------------------------ the search */

test('the brand is searched, so "bibibop steak" finds the steak', () => {
  assert.equal(searchMenus(catalog.chains, 'bibibop steak')[0].name, 'Steak')
  assert.equal(searchMenus(catalog.chains, 'bibibop steak')[0].brand, 'Bibibop')
  assert.equal(searchMenus(catalog.chains, 'chipotle steak')[0].brand, 'Chipotle')
  assert.equal(searchMenus(catalog.chains, 'steak')[0].name, 'Steak')
  assert.ok(searchMenus(catalog.chains, 'bibibop', 50).length >= 12, 'the brand alone lists the menu')
  assert.deepEqual(searchMenus(catalog.chains, 'zzqq'), [])
  assert.deepEqual(searchMenus(catalog.chains, ''), [])
})

console.log(`restaurants: ${passed} passed`)
