/*
 * node server/nutrition.test.js
 *
 * The normalizers, against payload shapes taken from live responses. These are
 * the tests that matter most in this app: every number on every screen comes out
 * of this file, and a unit mistake here is invisible — it just makes a food look
 * plausible and wrong.
 */

const assert = require('assert')
const N = require('./nutrition.js')

let passed = 0
const test = (name, fn) => {
  try {
    fn()
    passed++
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`)
    process.exitCode = 1
  }
}

/* ------------------------------------------------------------------- GTINs */

test('a GTIN is digits only, 8 to 14 of them', () => {
  assert.equal(N.normalizeGtin(' 049000042566 '), '049000042566')
  assert.equal(N.normalizeGtin('0-49000-04256-6'), '049000042566')
  assert.equal(N.normalizeGtin('12345'), null, 'too short is not a barcode')
  assert.equal(N.normalizeGtin('123456789012345'), null, 'too long is not a barcode')
  assert.equal(N.normalizeGtin('0490000425660'), null, 'nor is a 12-digit UPC with a digit tacked on')
  assert.equal(N.normalizeGtin(''), null)
  assert.equal(N.normalizeGtin(null), null)
})

test('a bad check digit is not a barcode', () => {
  // The last digit of a GTIN is a mod-10 checksum. Validating it is what tells a
  // typo in the manual box from a real code, and it is the only thing stopping a
  // misread resolving to a real-looking food.
  assert.ok(N.gtinCheckDigitOk('049000042566'), 'a real Coke UPC')
  assert.ok(N.gtinCheckDigitOk('0722252100900'), 'a real Clif EAN-13')
  assert.equal(N.normalizeGtin('049000042567'), null, 'one digit off is rejected')
  assert.equal(N.normalizeGtin('0000000000000'), null,
    'all zeros passes the checksum but is a placeholder row, never a product')
  assert.equal(N.normalizeGtin('1111111111111'), null)
})

test('a 12-digit UPC is also asked about as a 13-digit EAN, and back', () => {
  // The same physical barcode reads as UPC-A (12) or EAN-13 (13) depending on the
  // scanner, and OFF stores the padded form while USDA stores the bare one.
  const c = N.gtinCandidates('049000042566')
  assert.ok(c.includes('049000042566'), 'the scanned form is tried first')
  assert.ok(c.includes('0049000042566'), 'and the zero-padded 13')

  const back = N.gtinCandidates('0049000042566')
  assert.ok(back.includes('049000042566'), 'a padded 13 also tries the bare 12')
})

/* ----------------------------------------------------------- Open Food Facts */

const OFF_CLIF = {
  code: '0722252100900',
  product: {
    product_name: 'Clif Bar Chocolate Chip',
    brands: 'CLIF, Clif Bar & Company',
    serving_size: '1 bar (68 g)',
    serving_quantity: 68,
    nutriments: {
      'energy-kcal_100g': 372,
      'energy-kcal_serving': 253,
      proteins_100g: 14.7,
      proteins_serving: 10,
      carbohydrates_100g: 63.2,
      carbohydrates_serving: 43,
      fat_100g: 8.8,
      fat_serving: 6,
      fiber_100g: 5.9,
      sugars_100g: 30.9,
      sodium_100g: 0.22, // GRAMS, per OFF convention
    },
  },
}

test('OFF: the real-world serving leads, 100 g is still offered', () => {
  const f = N.fromOpenFoodFacts(OFF_CLIF)
  assert.equal(f.name, 'Clif Bar Chocolate Chip')
  // Title-cased, like USDA's: OFF's live entry for this bar is literally
  // "CHOCOLATE CHIP ENERGY BAR" / "CLIF", and shouting is a contributor habit
  // rather than the brand's styling.
  assert.equal(f.brand, 'Clif', 'only the first brand, not the whole comma list')
  assert.equal(f.source, 'off')
  assert.equal(f.portions[0].id, 'serving', 'a bar is the portion, not 100 g of bar')
  assert.equal(f.portions[0].label, '1 bar (68 g)')
  assert.equal(f.portions[0].grams, 68)
  assert.equal(f.portions[0].kcal, 253)
  assert.equal(f.portions[1].id, '100g')
  assert.equal(f.portions[1].kcal, 372)
})

test('OFF: sodium is grams upstream and milligrams here', () => {
  const f = N.fromOpenFoodFacts(OFF_CLIF)
  const per100 = f.portions.find(p => p.id === '100g')
  assert.equal(per100.sodium, 220, '0.22 g is 220 mg, not 0.22 mg')
})

test('OFF: a kJ-only product is converted, not read as kcal', () => {
  // `energy_100g` with no unit is kJ by OFF convention. Reading it as kcal makes
  // a biscuit look like a day's food, and nothing on screen would look wrong.
  const f = N.fromOpenFoodFacts({
    code: '1',
    product: {
      product_name: 'Euro Biscuit',
      nutriments: { energy_100g: 2093, proteins_100g: 6, carbohydrates_100g: 60, fat_100g: 25 },
    },
  })
  const per100 = f.portions.find(p => p.id === '100g')
  assert.equal(per100.kcal, 500, '2093 kJ is 500 kcal')
})

test('OFF: a product with no energy at all is a MISS, not an empty food', () => {
  // OFF has plenty of entries that are a photo and a name. Returning a zero-calorie
  // food would log silently as nothing and read as "the scan worked".
  const f = N.fromOpenFoodFacts({
    code: '1',
    product: { product_name: 'Photo only', nutriments: {} },
  })
  assert.equal(f, null)
  assert.equal(N.fromOpenFoodFacts({}), null, 'no product key is a miss')
  assert.equal(N.fromOpenFoodFacts(null), null)
})

test('OFF: a product with only per-100g data still logs', () => {
  const f = N.fromOpenFoodFacts({
    code: '1',
    product: {
      product_name: 'Bulk Oats',
      nutriments: { 'energy-kcal_100g': 379, proteins_100g: 13, carbohydrates_100g: 67, fat_100g: 6.5 },
    },
  })
  assert.equal(f.portions.length, 1)
  assert.equal(f.portions[0].id, '100g')
})

test('OFF: the FRONT photo is kept, and only from OFF\'s own image host', () => {
  const withImg = N.fromOpenFoodFacts({
    ...OFF_CLIF,
    product: {
      ...OFF_CLIF.product,
      image_front_small_url: 'https://images.openfoodfacts.org/images/products/072/front_en.171.200.jpg',
    },
  })
  assert.ok(withImg.image.includes('images.openfoodfacts.org'))

  // A contributor-supplied URL pointing anywhere else is dropped rather than
  // rendered: the proxy would refuse to fetch it and the row would show a broken
  // image instead of falling straight through to its letter tile.
  const elsewhere = N.fromOpenFoodFacts({
    ...OFF_CLIF,
    product: { ...OFF_CLIF.product, image_front_small_url: 'https://evil.example.com/x.jpg' },
  })
  assert.equal(elsewhere.image, null)

  assert.equal(N.fromOpenFoodFacts(OFF_CLIF).image, null, 'no image field is no image')
})

test('the image host allowlist is the whole check', () => {
  assert.ok(N.isAllowedImage('https://images.openfoodfacts.org/images/products/1/front.jpg'))
  assert.equal(N.isAllowedImage('http://images.openfoodfacts.org/x.jpg'), false, 'https only')
  assert.equal(N.isAllowedImage('https://evil.example.com/x.jpg'), false)
  // The trap worth naming: a host that merely ENDS with the allowed one.
  assert.equal(N.isAllowedImage('https://images.openfoodfacts.org.evil.com/x.jpg'), false)
  assert.equal(N.isAllowedImage('file:///etc/passwd'), false)
  assert.equal(N.isAllowedImage(''), false)
  assert.equal(N.isAllowedImage(null), false)
})

/* --------------------------------------------------------------------- USDA */

const USDA_BAR = {
  fdcId: 123,
  description: 'GRANOLA BAR, CHOCOLATE CHIP',
  brandOwner: 'GENERAL MILLS',
  gtinUpc: '628451529095',
  servingSize: 40,
  servingSizeUnit: 'g',
  householdServingFullText: '1 BAR',
  foodNutrients: [
    { nutrientNumber: '208', value: 450 },
    { nutrientNumber: '203', value: 7.5 },
    { nutrientNumber: '205', value: 65 },
    { nutrientNumber: '204', value: 17.5 },
    { nutrientNumber: '307', value: 300 },
  ],
}

test('USDA: per-100g nutrients are scaled to the label serving', () => {
  const f = N.fromUsda(USDA_BAR)
  assert.equal(f.portions[0].id, 'serving')
  assert.equal(f.portions[0].label, '1 BAR')
  assert.equal(f.portions[0].grams, 40)
  assert.equal(f.portions[0].kcal, 180, '450 kcal/100g at 40 g is 180')
  assert.equal(f.portions[0].protein, 3)
  assert.equal(f.portions[1].kcal, 450, 'and 100 g is still there')
})

test('USDA publishes no photography, and says so explicitly', () => {
  // null rather than undefined, so a reader can tell "no picture" from a field
  // that was never set — which is what the /api/image backfill keys off.
  assert.equal(N.fromUsda(USDA_BAR).image, null)
})

test('USDA: SHOUTED descriptions are title-cased', () => {
  const f = N.fromUsda(USDA_BAR)
  assert.equal(f.name, 'Granola Bar, Chocolate Chip')
  assert.equal(f.brand, 'General Mills')
  assert.equal(N.titleCase('Clif Bar'), 'Clif Bar', 'mixed case is left alone')
})

test('USDA: a serving measured in millilitres is NOT scaled', () => {
  // Scaling 100 g of nutrients by 355 ml assumes a density nobody stated. The
  // 100 g portion is honest; an invented per-can figure is not.
  const f = N.fromUsda({ ...USDA_BAR, servingSize: 355, servingSizeUnit: 'ml', householdServingFullText: '1 CAN' })
  assert.equal(f.portions.length, 1)
  assert.equal(f.portions[0].id, '100g')
})

test('USDA: the nutrient NUMBER is read, not the name', () => {
  // nutrientName spelling has changed between USDA releases; the numbers have not.
  const f = N.fromUsda({
    ...USDA_BAR,
    foodNutrients: [{ nutrient: { number: '208' }, amount: 200 }, { nutrient: { number: '203' }, amount: 10 }],
  })
  assert.equal(f.portions.find(p => p.id === '100g').kcal, 200)
})

test('USDA: no energy is a miss', () => {
  assert.equal(N.fromUsda({ ...USDA_BAR, foodNutrients: [{ nutrientNumber: '203', value: 7 }] }), null)
  assert.equal(N.fromUsda(null), null)
})

/* ------------------------------------------------------------ the arithmetic */

test('quantity multiplies the portion, and kcal stays whole', () => {
  const portion = { id: 'serving', label: '1 bar', kcal: 253, protein: 10, carbs: 43, fat: 6 }
  assert.deepEqual(N.amountFor(portion, 2), { kcal: 506, protein: 20, carbs: 86, fat: 12 })
  assert.deepEqual(N.amountFor(portion, 0.5), { kcal: 127, protein: 5, carbs: 21.5, fat: 3 })
  assert.equal(N.amountFor(portion).kcal, 253, 'no quantity means one')
  assert.equal(N.amountFor(portion, 0).kcal, 253, 'zero is not a quantity')
  assert.equal(N.amountFor(portion, -1).kcal, 253, 'nor is a negative one')
})

test('a day totals to whole calories and one decimal of macro', () => {
  const t = N.totals([
    { kcal: 253, protein: 10, carbs: 43, fat: 6 },
    { kcal: 140, protein: 0.5, carbs: 39, fat: 0 },
  ])
  assert.deepEqual(t, { kcal: 393, protein: 10.5, carbs: 82, fat: 6 })
})

test('totals survive a missing or malformed row', () => {
  // The store is merged across devices; a half-written row must not NaN the only
  // number on the main screen.
  const t = N.totals([{ kcal: 100 }, null, { kcal: 'x', protein: undefined }, {}])
  assert.deepEqual(t, { kcal: 100, protein: 0, carbs: 0, fat: 0 })
  assert.deepEqual(N.totals(null), { kcal: 0, protein: 0, carbs: 0, fat: 0 })
})

console.log(`nutrition: ${passed} passed`)
