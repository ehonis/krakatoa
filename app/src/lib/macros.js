/*
 * Krakatoa — the macro split, and the day's water.
 *
 * Two small pure models that the two new charts read. Nothing here fetches,
 * writes or looks at a clock.
 */

/*
 * Atwater factors: the energy each gram of a macronutrient carries. These are
 * the conventional rounded values every food label in the world is computed
 * with, which is what makes a split derived from them comparable to the
 * calories printed on the pack.
 */
export const KCAL_PER_G = { protein: 4, carbs: 4, fat: 9 }

/** Protein, carbs and fat as a share of the energy they account for. */
export function macroSplit(totals) {
  const g = {
    protein: Math.max(0, Number(totals?.protein) || 0),
    carbs: Math.max(0, Number(totals?.carbs) || 0),
    fat: Math.max(0, Number(totals?.fat) || 0),
  }
  const kcal = {
    protein: g.protein * KCAL_PER_G.protein,
    carbs: g.carbs * KCAL_PER_G.carbs,
    fat: g.fat * KCAL_PER_G.fat,
  }
  const fromMacros = kcal.protein + kcal.carbs + kcal.fat

  /*
   * A day with no macros on it has no split, and saying so is the point: three
   * equal thirds would be a chart of nothing that looks like a chart of
   * something. Every caller checks `fromMacros` before drawing.
   */
  const pct = (k) => (fromMacros > 0 ? (kcal[k] / fromMacros) * 100 : 0)

  return {
    fromMacros: Math.round(fromMacros),
    parts: ['protein', 'carbs', 'fat'].map(key => ({
      key,
      grams: Math.round(g[key] * 10) / 10,
      kcal: Math.round(kcal[key]),
      pct: Math.round(pct(key)),
    })),
  }
}

/**
 * The arc each macro occupies on the ring, as `[offset, length]` pairs in
 * PERCENT of the circle.
 *
 * `fill` is how much of the circle is drawn at all: the share of the calorie
 * TARGET he has eaten, clamped to one full turn. So the ring answers two
 * questions with one shape — how far round is how close to the target, and the
 * colours within it are the split. With no target set the ring is drawn whole,
 * because a fraction of nothing is not a fraction.
 *
 * The segments are laid out against the macro energy, NOT the logged calories.
 * They rarely agree exactly — alcohol carries energy and no macro, fibre is
 * counted differently by different labels, and everything is rounded — and
 * scaling the segments to the logged total would silently redistribute that
 * discrepancy across the three colours as if it belonged to them.
 */
export function ringSegments(totals, targetKcal) {
  const { fromMacros, parts } = macroSplit(totals)
  if (fromMacros <= 0) return { fill: 0, segments: [] }

  const eaten = Math.max(0, Number(totals?.kcal) || 0)
  const fill = targetKcal > 0 ? Math.min(1, eaten / targetKcal) : 1

  let offset = 0
  const segments = parts
    .filter(p => p.pct > 0)
    .map(p => {
      const length = (p.pct / 100) * 100 * fill
      const seg = { key: p.key, offset, length }
      offset += length
      return seg
    })

  return { fill, segments, over: targetKcal > 0 && eaten > targetKcal }
}

/* ------------------------------------------------------------------- water */

/*
 * The quick amounts. A glass, a pint, a bottle, a big bottle — the things he
 * actually drinks out of, rather than a slider that asks him to estimate in a
 * unit nobody pours. 4 oz is there for a few sips, with a Custom box beside them for everything else.
 */
export const WATER_STEPS = [
  { oz: 4, label: '4 oz', hint: 'a few sips' },
  { oz: 6, label: '6 oz', hint: 'glass' },
  { oz: 12, label: '12 oz', hint: 'can' },
  { oz: 32, label: '32 oz', hint: 'bottle' },
  { oz: 64, label: '64 oz', hint: 'big bottle' },
]

/* The fine adjust under the buttons: one tap too many is corrected in this. */
export const WATER_NUDGE = 4

const ML_PER_OZ = 29.5735

/**
 * A typed amount as whole ounces, the unit the day is kept in. "500" in mL is
 * 17 oz. Nothing, nonsense, zero and anything past a gallon at once (a typo, not
 * a drink) are null, and the Add button stays off.
 */
export function customWaterOz(text, unit = 'oz') {
  const n = Number(String(text ?? '').trim().replace(',', '.'))
  if (!Number.isFinite(n) || n <= 0) return null
  const oz = Math.round(unit === 'ml' ? n / ML_PER_OZ : n)
  return oz >= 1 && oz <= 128 ? oz : null
}

/** The default daily target: eight 8 oz glasses, the figure everyone quotes. */
export const WATER_DEFAULT_TARGET = 64

/** Ounces -> litres, for the line under the number. */
export const ozToL = (oz) => Math.round((Number(oz) || 0) * 0.0295735 * 100) / 100

/**
 * How full the glass is drawn. Clamped to one, because a wave that leaves the
 * top of its container is a rendering bug rather than an achievement — the
 * number above it already says he went over.
 */
export function waterLevel(oz, target = WATER_DEFAULT_TARGET) {
  const t = Number(target) > 0 ? Number(target) : WATER_DEFAULT_TARGET
  const n = Math.max(0, Number(oz) || 0)
  return { pct: Math.min(1, n / t) * 100, met: n >= t, oz: n, target: t }
}
