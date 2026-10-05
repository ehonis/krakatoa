/*
 * Shared by every chain reader: fetching, naming, and the one shape an item
 * leaves a reader in.
 *
 *   item    { name, category, step, portions: [Portion], defaultPortion }
 *   Portion { id, label, grams, kcal, protein, carbs, fat, fiber, sugar,
 *             sodium, satFat, cholesterol }
 *
 * A reader's only job is to produce those from whatever the chain publishes.
 * Everything after — ids, the sanity checks, the output file — is the build
 * script's, so four very different sources come out identical.
 */

import fs from 'node:fs'

export const UA = 'Mozilla/5.0 (Krakatoa personal food log; one fetch per build)'

export async function fetchTo(url, file, { headers = {} } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } })
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  return file
}

export const slug = (s) => String(s).toLowerCase()
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/®|™|&reg;?|&trade;?/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** Matching key: accents, marks and punctuation gone. "Queso Blanco (entreé)" -> "quesoblancoentree". */
export const key = (s) => slug(s).replace(/-/g, '')

/** HTML entities and trademark marks off a display name. Culver's names arrive as "Culver's&reg;". */
export function tidyName(s) {
  return String(s)
    // Culver's sometimes drops the semicolon: "Concrete Mixer&reg".
    .replace(/&reg;?|®|&trade;?|™/g, '')
    .replace(/&amp;/g, '&').replace(/&#39;|&rsquo;|’/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim()
}

const r1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null)

/**
 * One portion from numbers already in their final form. Calories whole,
 * everything else to a tenth. Sources that publish UNROUNDED figures pass
 * through `labelRound` first — see there for why.
 */
export function portion(id, label, v, grams = null) {
  const n = (x) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x))
  return {
    id,
    label,
    grams: n(grams) != null ? r1(n(grams)) : null,
    kcal: n(v.kcal) != null ? Math.round(n(v.kcal)) : null,
    protein: r1(n(v.protein)),
    carbs: r1(n(v.carbs)),
    fat: r1(n(v.fat)),
    fiber: r1(n(v.fiber)),
    sugar: r1(n(v.sugar)),
    sodium: n(v.sodium) != null ? Math.round(n(v.sodium)) : null,
    satFat: r1(n(v.satFat)),
    cholesterol: n(v.cholesterol) != null ? Math.round(n(v.cholesterol)) : null,
  }
}

/*
 * FDA label rounding (21 CFR 101.9), for sources that publish RAW figures —
 * Culver's hosted menu carries 576.42 kcal for a Deluxe Single where its menu
 * board says 580.
 *
 * Every chain here shows the number the chain PRINTS, and that is the reason:
 * a figure that matches the menu board is one he can check at a glance, and one
 * that is four calories off it reads as a mistake however precise it is. The
 * cost is small and bounded — each part of an order is at most five kcal from
 * its raw value, so a burger, fries and a shake are within fifteen.
 */
export function labelRound(v) {
  const step = (x, s) => Math.round(x / s) * s
  const kcal = (x) => (x < 5 ? 0 : x <= 50 ? step(x, 5) : step(x, 10))
  const fat = (x) => (x < 0.5 ? 0 : x < 5 ? step(x, 0.5) : Math.round(x))
  const gram = (x) => (x < 0.5 ? 0 : x < 1 ? 0.5 : Math.round(x)) // "<1 g" kept as 0.5, as the PDFs are read
  const sodium = (x) => (x < 5 ? 0 : x <= 140 ? step(x, 5) : step(x, 10))
  const chol = (x) => (x < 2 ? 0 : x <= 5 ? 2.5 : step(x, 5))
  const f = (fn, x) => (Number.isFinite(x) ? fn(x) : null)
  return {
    kcal: f(kcal, v.kcal), fat: f(fat, v.fat), satFat: f(fat, v.satFat),
    protein: f(gram, v.protein), carbs: f(gram, v.carbs), fiber: f(gram, v.fiber), sugar: f(gram, v.sugar),
    sodium: f(sodium, v.sodium), cholesterol: f(chol, v.cholesterol),
  }
}

/*
 * Which size a multi-size item opens on. The size you would order without
 * being asked — a medium fry, a single patty, one scoop, the regular cup —
 * rather than the first one listed, which for fries is the small.
 */
const USUAL = ['medium', 'regular', 'single', '1 scoop', '22 fl oz', 'small']
export function usualPortion(portions) {
  for (const want of USUAL) {
    const hit = portions.find(p => p.label.toLowerCase().startsWith(want))
    if (hit) return hit.id
  }
  return portions[0]?.id
}

/**
 * Energy should roughly agree with the macros that make it: 4/4/9 kcal a gram.
 * Where it does not, the row was read wrong more often than it was printed
 * wrong — a column shifted, a digit dropped — so it is REPORTED. Alcohol,
 * sugar alcohols and fibre make honest differences, hence a wide margin.
 */
export function atwaterOutliers(items) {
  const out = []
  for (const it of items) {
    for (const p of it.portions) {
      if (!Number.isFinite(p.kcal) || p.kcal < 60) continue
      const est = 4 * (p.protein || 0) + 4 * (p.carbs || 0) + 9 * (p.fat || 0)
      const gap = Math.abs(p.kcal - est)
      if (gap > Math.max(50, p.kcal * 0.2)) out.push(`${it.name} (${p.label}): ${p.kcal} kcal vs ${Math.round(est)} from its macros`)
    }
  }
  return out
}

/*
 * Sizes in the order they are ordered, not the order the source listed them:
 * Culver's lists tenders 2, 1, 4, 8. Piece and scoop counts go by number, named
 * sizes by size, and anything unrecognised keeps its place at the end.
 */
const SIZE_ORDER = ['kids', 'mini', 'snack', 'extra small', 'small', 'regular', 'single', 'medium', 'double', 'large', 'triple', 'extra large', 'family']
export function sortPortions(portions) {
  const rank = (label) => {
    const l = label.toLowerCase()
    const n = l.match(/^(\d+)\s*(piece|scoop|oz)/)
    if (n) return Number(n[1])
    const i = SIZE_ORDER.indexOf(l)
    return i >= 0 ? 1000 + i : 2000
  }
  const sorted = portions.map((p, i) => [p, i]).sort((a, b) => rank(a[0].label) - rank(b[0].label) || a[1] - b[1]).map(([p]) => p)
  sorted.forEach((p, i) => { p.id = `p${i}` })
  return sorted
}
