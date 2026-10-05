/*
 * Krakatoa — turning what a food database says into one shape.
 *
 * Open Food Facts and USDA describe the same can of Coke completely differently:
 * OFF gives you a flat `nutriments` bag with `_100g` and `_serving` variants and
 * energy in whichever unit the contributor typed; USDA gives you an array of
 * nutrient records keyed by number, per 100 g, plus a separate `labelNutrients`
 * block that is per serving. Everything downstream — the log, the day total, the
 * digest the agents read — sees only the shape at the bottom of this file.
 *
 * Pure. No fetch, no disk, no clock. server/lookup.js does the talking.
 */

/* ---------------------------------------------------------------- the shape */

/**
 * A FOOD is an identity plus a list of PORTIONS you could eat of it.
 *
 *   { gtin, name, brand, source, image, portions: [Portion], fetchedAt }
 *
 * A PORTION is a label, optionally its weight, and the macros for ONE of it:
 *
 *   { id, label, grams, kcal, protein, carbs, fat }
 *
 * Portions rather than a per-100g figure plus a multiplier, because "1 bar" is
 * what he ate and "68 g" is trivia. The 100 g portion is always present when the
 * data supports it, so a food weighed on a scale is still loggable — but it is
 * never FIRST if a real-world serving exists, since leading with 100 g is how a
 * tracker gets you to log 100 g of a 68 g bar.
 */

const round = (n, dp = 1) => {
  if (!Number.isFinite(n)) return null
  const f = 10 ** dp
  return Math.round(n * f) / f
}

/** kJ -> kcal. The factor is exact by definition (1 kcal = 4.184 kJ). */
const kjToKcal = (kj) => (Number.isFinite(kj) ? kj / 4.184 : null)

const num = (v) => {
  // An empty string is ABSENT, not zero. `Number('')` is 0 and finite, which is
  // how a field nobody filled in becomes a confident-looking zero.
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'string' ? Number(v) : v
  return Number.isFinite(n) ? n : null
}

/**
 * A macro set is only worth keeping if it has an energy figure. Protein without
 * calories is a row that renders as "— kcal" and silently contributes nothing to
 * the only number on the main screen, which is worse than not offering it.
 */
const hasEnergy = (m) => m && Number.isFinite(m.kcal) && m.kcal >= 0

const macros = ({ kcal, protein, carbs, fat, fiber, sugar, sodium }) => ({
  kcal: round(kcal, 0),
  protein: round(protein, 1),
  carbs: round(carbs, 1),
  fat: round(fat, 1),
  fiber: round(fiber, 1),
  sugar: round(sugar, 1),
  sodium: round(sodium, 0),
})

/* ------------------------------------------------------------ Open Food Facts */

/**
 * OFF publishes energy three ways and contributors use all of them. Prefer the
 * one already in kcal; fall back to converting the kJ figure. `energy_100g` with
 * no unit is kJ by OFF's own convention, which is the trap here — reading it as
 * kcal makes a biscuit look like a day's food.
 */
function offEnergy(nut, suffix) {
  const kcal = num(nut[`energy-kcal${suffix}`])
  if (Number.isFinite(kcal)) return kcal
  const kj = num(nut[`energy-kj${suffix}`]) ?? num(nut[`energy${suffix}`])
  return kjToKcal(kj)
}

function offMacros(nut, suffix) {
  return macros({
    kcal: offEnergy(nut, suffix),
    protein: num(nut[`proteins${suffix}`]),
    carbs: num(nut[`carbohydrates${suffix}`]),
    fat: num(nut[`fat${suffix}`]),
    fiber: num(nut[`fiber${suffix}`]),
    sugar: num(nut[`sugars${suffix}`]),
    // OFF stores sodium in GRAMS. Everything on screen is mg.
    sodium: num(nut[`sodium${suffix}`]) != null ? num(nut[`sodium${suffix}`]) * 1000 : null,
  })
}

/**
 * "1 bar (68 g)" / "12 fl oz (355 ml)" / "68g" -> a label worth showing.
 * OFF's `serving_size` is free text typed by a contributor, so it is cleaned but
 * never parsed for meaning: `serving_quantity` is the numeric field and is the
 * only thing trusted for grams.
 */
function offServingLabel(product) {
  const raw = String(product.serving_size || '').trim()
  if (raw) return raw
  const q = num(product.serving_quantity)
  return q ? `${round(q, 0)} ${product.serving_quantity_unit || 'g'}` : 'serving'
}

/*
 * The only host this app will ever load an image from. `server.js` checks any
 * URL it is handed against it before fetching — an image proxy that will fetch
 * whatever it is told to is an open relay with a friendly name.
 */
const OFF_IMAGE_HOST = 'images.openfoodfacts.org'

/** The front-of-pack photo, or null. Never the ingredients or nutrition panel. */
function offImage(product) {
  const url = String(product.image_front_small_url || product.image_small_url || '').trim()
  if (!url) return null
  try {
    return new URL(url).hostname === OFF_IMAGE_HOST ? url : null
  } catch {
    return null
  }
}

/** Is this a URL we are willing to fetch? Host allowlist, nothing cleverer. */
function isAllowedImage(url) {
  try {
    const u = new URL(String(url))
    return u.protocol === 'https:' && u.hostname === OFF_IMAGE_HOST
  } catch {
    return false
  }
}

/** Normalize an Open Food Facts v2 product payload. Returns null if unusable. */
function fromOpenFoodFacts(payload, { gtin } = {}) {
  const product = payload?.product
  if (!product) return null
  const nut = product.nutriments || {}

  const per100 = offMacros(nut, '_100g')
  const perServing = offMacros(nut, '_serving')

  const portions = []
  if (hasEnergy(perServing)) {
    portions.push({
      id: 'serving',
      label: offServingLabel(product),
      grams: num(product.serving_quantity),
      ...perServing,
    })
  }
  if (hasEnergy(per100)) {
    portions.push({ id: '100g', label: '100 g', grams: 100, ...per100 })
  }
  if (!portions.length) return null

  // OFF entries are contributor-typed and plenty are SHOUTED, same as USDA's.
  const name = titleCase(String(product.product_name || product.generic_name || '').trim())
  return {
    gtin: String(payload.code || gtin || '').trim() || null,
    name: name || 'Unnamed product',
    brand: titleCase(String(product.brands || '').split(',')[0].trim()) || null,
    source: 'off',
    // The FRONT of the pack at 200px. OFF publishes 100/200/400 and this is the
    // one that reads at thumbnail size on a 3x phone without being a photo.
    // Absent on roughly one product in five, so every reader must handle null.
    image: offImage(product),
    portions,
  }
}

/* ------------------------------------------------------- USDA FoodData Central */

/*
 * USDA keys nutrients by number, and the numbers are the stable part of that API —
 * `nutrientName` is prose and has changed spelling between releases.
 */
const USDA_NUTRIENTS = {
  208: 'kcal', // Energy
  203: 'protein',
  205: 'carbs', // Carbohydrate, by difference
  204: 'fat', // Total lipid (fat)
  291: 'fiber',
  269: 'sugar',
  307: 'sodium', // already mg
}

function usdaMacros(food) {
  const found = {}
  for (const n of food.foodNutrients || []) {
    // Search results and detail responses disagree about where the number lives.
    const code = String(n.nutrientNumber ?? n.nutrient?.number ?? '')
    const key = USDA_NUTRIENTS[code]
    if (!key) continue
    const value = num(n.value ?? n.amount)
    if (value != null && found[key] == null) found[key] = value
  }
  return macros(found)
}

/**
 * Normalize one USDA Branded food. USDA's `foodNutrients` are per 100 g even
 * when the label is not, and `servingSize` is the label serving — so the serving
 * portion is derived by scaling, which is the only arithmetic in this file and
 * the reason `servingSizeUnit` is checked: scaling by millilitres would be a
 * guess about density.
 */
function fromUsda(food) {
  if (!food) return null
  const per100 = usdaMacros(food)
  if (!hasEnergy(per100)) return null

  const portions = []
  const size = num(food.servingSize)
  const unit = String(food.servingSizeUnit || '').toLowerCase()
  if (size && (unit === 'g' || unit === 'gram' || unit === 'grm')) {
    const k = size / 100
    const label = String(food.householdServingFullText || '').trim() || `${round(size, 0)} g`
    portions.push({
      id: 'serving',
      label,
      grams: size,
      ...macros({
        kcal: per100.kcal * k,
        protein: per100.protein * k,
        carbs: per100.carbs * k,
        fat: per100.fat * k,
        fiber: per100.fiber != null ? per100.fiber * k : null,
        sugar: per100.sugar != null ? per100.sugar * k : null,
        sodium: per100.sodium != null ? per100.sodium * k : null,
      }),
    })
  }
  portions.push({ id: '100g', label: '100 g', grams: 100, ...per100 })

  const name = String(food.description || '').trim()
  return {
    gtin: String(food.gtinUpc || '').trim() || null,
    // USDA branded descriptions are SHOUTED. Title case reads better on a phone
    // and the original is never shown, so nothing is lost.
    name: titleCase(name) || 'Unnamed product',
    brand: titleCase(String(food.brandOwner || food.brandName || '').trim()) || null,
    source: 'usda',
    // USDA's API publishes no product photography at all. Explicitly null so a
    // reader can tell "no picture" from "field never set".
    image: null,
    portions,
  }
}

/** "GRANOLA BAR, CHOCOLATE" -> "Granola Bar, Chocolate". Leaves mixed case alone. */
function titleCase(s) {
  if (!s) return ''
  if (s !== s.toUpperCase()) return s
  return s.toLowerCase().replace(/(^|[\s(/,-])([a-z])/g, (_, p, c) => p + c.toUpperCase())
}

/* ------------------------------------------------------------------ the log */

/**
 * What one logged food costs, for a quantity of one of its portions. Quantity is
 * a multiplier on the portion and not on grams, because "2 bars" is the thing he
 * can answer standing at a counter.
 */
function amountFor(portion, qty = 1) {
  const q = Number.isFinite(qty) && qty > 0 ? qty : 1
  const scale = (v) => (Number.isFinite(v) ? round(v * q, v === portion.kcal ? 0 : 1) : null)
  return {
    kcal: Number.isFinite(portion?.kcal) ? Math.round(portion.kcal * q) : 0,
    protein: scale(portion?.protein) ?? 0,
    carbs: scale(portion?.carbs) ?? 0,
    fat: scale(portion?.fat) ?? 0,
  }
}

/** Sum a list of logged foods. The only arithmetic the day screen does. */
function totals(items) {
  const sum = { kcal: 0, protein: 0, carbs: 0, fat: 0 }
  for (const it of items || []) {
    sum.kcal += Number(it?.kcal) || 0
    sum.protein += Number(it?.protein) || 0
    sum.carbs += Number(it?.carbs) || 0
    sum.fat += Number(it?.fat) || 0
  }
  return {
    kcal: Math.round(sum.kcal),
    protein: round(sum.protein, 1),
    carbs: round(sum.carbs, 1),
    fat: round(sum.fat, 1),
  }
}

/**
 * Every GTIN ends in a mod-10 check digit over the digits before it. Validating
 * it is what tells a typo in the manual box from a real barcode, and it is the
 * only defence against a garbage code resolving to a real-looking food: USDA
 * carries placeholder rows whose gtinUpc is a run of zeros, and without this an
 * unreadable scan of "0000000000000" came back as tortilla chips.
 */
function gtinCheckDigitOk(digits) {
  const padded = digits.padStart(14, '0')
  let sum = 0
  for (let i = 0; i < 13; i++) sum += Number(padded[i]) * (i % 2 === 0 ? 3 : 1)
  return (10 - (sum % 10)) % 10 === Number(padded[13])
}

/**
 * A GTIN is 8, 12, 13 or 14 digits with a valid check digit. Scanners hand back
 * UPC-A as 12 and EAN-13 as 13 for the same physical barcode, and the two
 * databases disagree about which they store — so a lookup tries the padded form
 * and the bare one. Getting THAT wrong is the commonest reason a scan reads as
 * "not in the database" when the product is right there.
 */
function normalizeGtin(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '')
  if (![8, 12, 13, 14].includes(digits.length)) return null
  // A run of one digit passes the checksum (all zeros sums to zero) and is never
  // a product — it is a placeholder row or a misread.
  if (/^(\d)\1*$/.test(digits)) return null
  if (!gtinCheckDigitOk(digits)) return null
  return digits
}

/** The forms worth asking a database about, longest-shot last. */
function gtinCandidates(raw) {
  const d = normalizeGtin(raw)
  if (!d) return []
  const out = new Set([d])
  if (d.length < 13) out.add(d.padStart(13, '0'))
  if (d.length === 13 && d.startsWith('0')) out.add(d.slice(1))
  if (d.length === 14 && d.startsWith('0')) out.add(d.slice(1))
  return [...out]
}

module.exports = {
  fromOpenFoodFacts,
  gtinCheckDigitOk,
  isAllowedImage,
  OFF_IMAGE_HOST,
  fromUsda,
  amountFor,
  totals,
  normalizeGtin,
  gtinCandidates,
  titleCase,
  round,
  kjToKcal,
}
