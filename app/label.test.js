/*
 * node app/label.test.js
 *
 * A food built from its Nutrition Facts label: the portions it gets, what a
 * blank box means, and the checks that catch a misread or a typo.
 */

import assert from 'node:assert'
import { checkLabel, emptyLabel, fromReading, labelFood, labelReady, numbersOf, toNum } from './src/lib/label.js'

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++ } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`)
    process.exitCode = 1
  }
}

// The test label the reader was tried on: 2/3 cup (55g), 8 servings, 230 kcal.
const READ = {
  isLabel: true, name: null, servingLabel: '2/3 cup', servingGrams: 55, servingsPerContainer: 8,
  kcal: 230, fat: 8, satFat: 1, cholesterol: 0, sodium: 160, carbs: 37, fiber: 4, sugar: 12, protein: 3, notes: null,
}

test('a reading fills the form as text, and a null stays blank — never "0"', () => {
  const f = fromReading({ ...READ, fiber: null }, emptyLabel({ name: 'Granola' }))
  assert.equal(f.kcal, '230')
  assert.equal(f.fiber, '', 'a number the label did not show is not zero')
  assert.equal(f.name, 'Granola', 'what he typed is not overwritten')
  assert.equal(fromReading({ ...READ, name: 'Crunchy Granola' }, emptyLabel()).name, 'Crunchy Granola')
})

test('the serving, the whole package and 100 g, each scaled from the label', () => {
  const food = labelFood(fromReading(READ, emptyLabel({ name: 'Granola' })), { gtin: '0012345678905' })
  assert.equal(food.source, 'label')
  assert.equal(food.gtin, '0012345678905')
  assert.deepEqual(food.portions.map(p => p.label), ['2/3 cup (55 g)', 'whole package (8 servings)', '100 g'])
  const [serving, pack, per100] = food.portions
  assert.deepEqual([serving.kcal, serving.protein, serving.carbs, serving.fat, serving.sodium, serving.fiber], [230, 3, 37, 8, 160, 4])
  assert.equal(pack.kcal, 1840)
  assert.equal(pack.grams, 440)
  assert.equal(per100.kcal, 418)
  assert.equal(per100.protein, 5.5)
})

test('with no weight there is no 100 g; with one serving there is no package', () => {
  const food = labelFood({ ...emptyLabel({ name: 'Cookie' }), kcal: '210', servingsPerContainer: '1' })
  assert.deepEqual(food.portions.map(p => p.label), ['1 serving'])
  assert.equal(food.portions[0].fiber, null, 'a blank box is unknown, not zero')
  assert.equal(food.portions[0].protein, 0, 'the four headline numbers are always numbers')
})

test('it can be saved with a name and calories, and not without', () => {
  assert.equal(labelReady(emptyLabel({ name: 'Bar' })), false)
  assert.equal(labelReady({ ...emptyLabel(), kcal: '190' }), false)
  assert.equal(labelReady({ ...emptyLabel({ name: 'Bar' }), kcal: '0' }), true, 'zero calories is an answer (a diet soda)')
})

test('a comma is a decimal point, and nothing negative gets in', () => {
  assert.equal(toNum('2,5'), 2.5)
  assert.equal(toNum(''), null)
  assert.equal(toNum('-3'), null)
})

test('the label as printed raises nothing', () => {
  assert.deepEqual(checkLabel(numbersOf(fromReading(READ, emptyLabel()))), [])
  // The blurred protein bar: 190 kcal, 7 fat, 22 carbs, 10 protein, <1 g fibre.
  assert.deepEqual(checkLabel({ kcal: 190, fat: 7, satFat: 2.5, carbs: 22, fiber: 0.5, sugar: 13, protein: 10, servingGrams: 40 }), [])
})

test('a misread says so, in words, and corrects nothing', () => {
  const v = numbersOf(fromReading(READ, emptyLabel()))
  assert.match(checkLabel({ ...v, kcal: 530 })[0], /530 calories.*add up to about 232/, 'a 2 read as a 5')
  assert.match(checkLabel({ ...v, sugar: 40 }).join(' '), /Sugar is more than total carbohydrate/)
  assert.match(checkLabel({ ...v, satFat: 9 }).join(' '), /Saturated fat is more than total fat/)
  assert.match(checkLabel({ ...v, servingGrams: 5 }).join(' '), /5 g serving is not possible/)
})

console.log(`label: ${passed} passed`)
