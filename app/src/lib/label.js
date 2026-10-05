/*
 * Krakatoa — a food built from its Nutrition Facts label.
 *
 * The label is the one source
 * every packaged food has, including the ones no database has heard of. So this
 * takes exactly what a label prints — per serving, in the label's own units —
 * and turns it into an ordinary food with real portions: the serving, the whole
 * package when the label says how many servings are in it, and 100 g when it
 * gives the serving's weight. Pure; the screen is labelfood.jsx and the photo
 * reader is server/label.js.
 */

/* The fields, in the order a label prints them. `unit` is what the label says. */
export const LABEL_FIELDS = [
  { key: 'kcal', label: 'Calories', unit: '', big: true },
  { key: 'fat', label: 'Total fat', unit: 'g' },
  { key: 'satFat', label: 'Saturated fat', unit: 'g', indent: true },
  { key: 'cholesterol', label: 'Cholesterol', unit: 'mg' },
  { key: 'sodium', label: 'Sodium', unit: 'mg' },
  { key: 'carbs', label: 'Total carbohydrate', unit: 'g' },
  { key: 'fiber', label: 'Dietary fiber', unit: 'g', indent: true },
  { key: 'sugar', label: 'Total sugars', unit: 'g', indent: true },
  { key: 'protein', label: 'Protein', unit: 'g' },
]

const NUMERIC_KEYS = ['servingGrams', 'servingsPerContainer', ...LABEL_FIELDS.map(f => f.key)]

/** A blank form. Every value is TEXT, because the boxes own their text. */
export function emptyLabel(initial = {}) {
  const v = { name: '', brand: '', servingLabel: '', servingGrams: '', servingsPerContainer: '' }
  for (const f of LABEL_FIELDS) v[f.key] = ''
  return { ...v, ...initial }
}

/** What the photo reader returned, as form text. Null stays blank — never "0". */
export function fromReading(reading, current = emptyLabel()) {
  const next = { ...current }
  if (reading.name && !current.name.trim()) next.name = reading.name
  if (reading.servingLabel) next.servingLabel = reading.servingLabel
  for (const k of NUMERIC_KEYS) {
    if (reading[k] != null) next[k] = String(reading[k])
  }
  return next
}

/** "12" -> 12, "" -> null, "1.5" -> 1.5. A comma is a decimal point. */
export function toNum(s) {
  const t = String(s ?? '').trim().replace(',', '.')
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? n : null
}

export function numbersOf(form) {
  const out = {}
  for (const k of NUMERIC_KEYS) out[k] = toNum(form[k])
  return out
}

/**
 * The ways a wrong number shows itself. Sentences, never corrections: which box
 * is wrong is his call. Run on what he typed as much as on what was read,
 * because a typo is the same failure as a misread.
 */
export function checkLabel(v) {
  const out = []
  const est = 4 * (v.protein || 0) + 4 * (v.carbs || 0) + 9 * (v.fat || 0)
  // A label rounds every figure, and fibre and sugar alcohols carry fewer than 4
  // kcal a gram, so only a gap that no rounding explains is worth saying.
  if (v.kcal != null && (v.protein != null || v.carbs != null || v.fat != null)
    && Math.abs(v.kcal - est) > Math.max(25, v.kcal * 0.2)) {
    out.push(`${v.kcal} calories, but the fat, carbs and protein add up to about ${Math.round(est)}. One of them is off.`)
  }
  if (v.sugar != null && v.carbs != null && v.sugar > v.carbs) out.push('Sugar is more than total carbohydrate.')
  if (v.fiber != null && v.carbs != null && v.fiber > v.carbs) out.push('Fiber is more than total carbohydrate.')
  if (v.satFat != null && v.fat != null && v.satFat > v.fat) out.push('Saturated fat is more than total fat.')
  if (v.servingGrams != null && v.servingGrams > 0) {
    const grams = (v.fat || 0) + (v.carbs || 0) + (v.protein || 0)
    if (grams > v.servingGrams * 1.05) out.push(`${Math.round(grams)} g of fat, carbs and protein in a ${v.servingGrams} g serving is not possible.`)
  }
  return out
}

const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10)

function scaled(v, k, label, grams, id) {
  const m = (x, dp = 1) => (x == null ? null : dp === 0 ? Math.round(x * k) : r1(x * k))
  return {
    id,
    label,
    grams: grams == null ? null : r1(grams),
    kcal: m(v.kcal, 0) ?? 0,
    protein: m(v.protein) ?? 0,
    carbs: m(v.carbs) ?? 0,
    fat: m(v.fat) ?? 0,
    fiber: m(v.fiber),
    sugar: m(v.sugar),
    sodium: m(v.sodium, 0),
    satFat: m(v.satFat),
    cholesterol: m(v.cholesterol, 0),
  }
}

/** Calories are the one thing a food cannot be logged without. */
export const labelReady = (form) => form.name.trim() !== '' && toNum(form.kcal) != null

/**
 * The form, as an ordinary food. Portions: the label's serving first (it is
 * what the label is written for), then the whole package where the label says
 * how many servings are in it, then 100 g where it gives the serving's weight.
 */
export function labelFood(form, { gtin = null } = {}) {
  const v = numbersOf(form)
  const serving = form.servingLabel.trim() || '1 serving'
  const g = v.servingGrams
  const portions = [scaled(v, 1, g ? `${serving} (${g} g)` : serving, g, 'serving')]
  const per = v.servingsPerContainer
  if (per && per > 1) {
    portions.push(scaled(v, per, `whole package (${per} servings)`, g ? g * per : null, 'package'))
  }
  if (g) portions.push(scaled(v, 100 / g, '100 g', 100, '100g'))
  return {
    name: form.name.trim(),
    brand: form.brand.trim() || null,
    gtin: gtin || null,
    image: null,
    source: 'label',
    portions,
  }
}
