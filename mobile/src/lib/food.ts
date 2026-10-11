/*
 * Krakatoa — the arithmetic, client side. Ported from app/src/lib/food.js; keep
 * the two in step.
 *
 * DELIBERATE DUPLICATE of the two functions at the bottom of server/nutrition.js.
 * The server is CommonJS (it runs on bare node with no build step) and this is an
 * ES module inside Vite; wiring one to import the other would mean a build step
 * on the server or a bundler alias reaching outside the app root, to share about
 * thirty lines. `food.test.js` pins the two implementations against the same
 * cases, so the duplication is checked rather than merely intended.
 */
import type { Food, Portion, Totals } from './types'

export const round = (n: number, dp = 1): number | null => {
  if (!Number.isFinite(n)) return null
  const f = 10 ** dp
  return Math.round(n * f) / f
}

const r = (n: number, dp = 1) => round(n, dp) ?? 0

/** What one logged food costs, for a quantity of one of its portions. */
export function amountFor(portion: Partial<Portion> | null | undefined, qty: number = 1): Totals {
  const q = Number.isFinite(qty) && qty > 0 ? qty : 1
  const scale = (v: unknown) => (Number.isFinite(v) ? r((v as number) * q, 1) : 0)
  return {
    kcal: Number.isFinite(portion?.kcal) ? Math.round((portion!.kcal as number) * q) : 0,
    protein: scale(portion?.protein),
    carbs: scale(portion?.carbs),
    fat: scale(portion?.fat),
  }
}

/** Sum a list of logged foods. The only arithmetic the day screen does. */
export function totals(items: Partial<Totals>[] | null | undefined): Totals {
  const sum = { kcal: 0, protein: 0, carbs: 0, fat: 0 }
  for (const it of items || []) {
    sum.kcal += Number(it?.kcal) || 0
    sum.protein += Number(it?.protein) || 0
    sum.carbs += Number(it?.carbs) || 0
    sum.fat += Number(it?.fat) || 0
  }
  return {
    kcal: Math.round(sum.kcal),
    protein: r(sum.protein, 1),
    carbs: r(sum.carbs, 1),
    fat: r(sum.fat, 1),
  }
}

/* ------------------------------------------------------------------- dates */

/** ISO date in LOCAL time. `toISOString()` is UTC and files dinner on tomorrow. */
export function isoDate(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function shiftDate(iso: string, days: number) {
  const d = new Date(`${iso}T12:00:00`)
  d.setDate(d.getDate() + days)
  return isoDate(d)
}

export function dayLabel(iso: string, today = isoDate()) {
  if (iso === today) return 'Today'
  if (iso === shiftDate(today, -1)) return 'Yesterday'
  if (iso === shiftDate(today, 1)) return 'Tomorrow'
  const d = new Date(`${iso}T12:00:00`)
  const sameYear = d.getFullYear() === new Date(`${today}T12:00:00`).getFullYear()
  return d.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/* ------------------------------------------------------------------- meals */

/*
 * Four, fixed. A tracker that lets you invent meal names ends up with "Lunch",
 * "lunch" and "Lunch 2" and a day that will not group. The time of day picks one
 * so the commonest case is already answered when the sheet opens.
 */
export const MEALS = [
  { id: 'breakfast', label: 'Breakfast', until: 10.5 },
  { id: 'lunch', label: 'Lunch', until: 15 },
  { id: 'dinner', label: 'Dinner', until: 21 },
  { id: 'snack', label: 'Snack', until: 24 },
] as const

export function mealNow(d = new Date()): string {
  const hour = d.getHours() + d.getMinutes() / 60
  return (MEALS.find(m => hour < m.until) || MEALS[3]).id
}

export const mealLabel = (id?: string | null) => MEALS.find(m => m.id === id)?.label || 'Other'

/* ------------------------------------------------------------------ naming */

/** "Clif · Chocolate Chip Energy Bar", or just the name when there is no brand. */
export function titleOf(food: { name?: string | null; brand?: string | null } | null | undefined) {
  if (!food) return ''
  const name = String(food.name || '').trim()
  const brand = String(food.brand || '').trim()
  if (!brand) return name
  // A name that already starts with the brand does not need it twice.
  if (name.toLowerCase().startsWith(brand.toLowerCase())) return name
  return `${brand} · ${name}`
}

/* ------------------------------------------------------------- identity */

/**
 * What makes two logged rows THE SAME FOOD. A barcode where there is one, the
 * name and brand where there is not. This is the key the product screen groups a
 * history by and the key recents de-duplicate on — one definition, so "how many
 * times have I had this" and "is this already in my recents" cannot disagree.
 */
export function foodKey(food: Partial<Food> | null | undefined) {
  if (!food) return ''
  if (food.gtin) return `g:${food.gtin}`
  if (food.comboId) return `c:${food.comboId}`
  const name = String(food.name || '').trim().toLowerCase()
  if (!name) return ''
  return `n:${name}|${String(food.brand || '').trim().toLowerCase()}`
}

/* ------------------------------------------------------------------ photos */

/**
 * Where to load a food's picture from. Always this app's own proxy, never OFF's
 * CDN directly — see the /api/image handler for why (offline, the cache, and not
 * turning his shopping into somebody else's request log). A path on the server;
 * Thumb turns it into a request with the session on it (connection.imageSource).
 *
 * Null where there is nothing to show, which is every hand-typed food and about
 * one packaged product in five. Callers draw a letter tile instead.
 */
export function imageUrl(food: { gtin?: string | null; image?: string | null } | null | undefined) {
  // A GTIN is enough. The known URL is passed as a HINT when there is one, but
  // the server can resolve a photo from the barcode alone.
  if (!food?.gtin) return null
  const hint = food.image ? `&u=${encodeURIComponent(food.image)}` : ''
  return `/api/image?gtin=${encodeURIComponent(food.gtin)}${hint}`
}

/**
 * A stable colour for a food with no photo. Hashing the NAME rather than picking
 * at random is the whole point: the same yoghurt is the same green every time,
 * so the list stays scannable by shape and colour even where nothing has a
 * picture. Hue only — saturation and lightness are fixed so every tile clears
 * contrast against its text.
 */
export function tileHue(name: string) {
  const s = String(name || '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return h
}

/** The letter in that tile. First letter of the name, or a dot for nothing. */
export const tileLetter = (name: string) => (String(name || '').trim()[0] || '·').toUpperCase()

/** "2 × 1 bar (68 g)" — what he actually ate, for the row under the name. */
export function portionLabel(qty: number | null | undefined, portion: Partial<Portion> | null | undefined) {
  const label = portion?.label || 'serving'
  const q = Number(qty) || 1
  return q === 1 ? label : `${round(q, 2)} × ${label}`
}
