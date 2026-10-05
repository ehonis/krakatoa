/*
 * Krakatoa — chain restaurant menus.
 *
 * THERE IS NO FREE KEYLESS SOURCE FOR THIS, and that was checked rather than
 * assumed. On the way in: MenuStat (the public chain-nutrition dataset) answers
 * 403; Open Food Facts has chipotle-FLAVOURED groceries and zero products under
 * the brand `chipotle-mexican-grill`; USDA's Branded set has no restaurant
 * chains and its survey set (FNDDS, 5,432 foods) has seven McDonald's items and
 * nothing else — no Chipotle, Subway, Taco Bell or Panera; and Chipotle's own
 * nutrition calculator is a JavaScript app with no server-rendered data and no
 * public endpoint (three plausible paths all 404).
 *
 * Nutritionix is the industry database behind most of those calculators and it
 * needs a key (business accounts only since its free tier closed). With an app
 * ID and key from https://developer.nutritionix.com, enter them in Settings →
 * Food databases (or KRAKATOA_NUTRITIONIX_ID / _KEY). No restart needed.
 *
 * Until then everything here returns "not configured" and the rest of the app is
 * unaffected — search still runs Open Food Facts and USDA, which is where the
 * groceries are anyway.
 *
 * TWO CALLS, NOT NINE. `/search/instant` gives a list with calories only; the
 * macros need one `/search/item` per food. Fetching detail for a whole page of
 * results would burn a day's quota on a single search, so detail is fetched when
 * he TAPS one, and cached from then on.
 */

const BASE = 'https://trackapi.nutritionix.com/v2'
const TIMEOUT_MS = Number(process.env.KRAKATOA_LOOKUP_TIMEOUT_MS || 8000)

/** The credentials, or null. Null is a normal state, not an error. */
function credsFrom(config = {}) {
  const id = process.env.KRAKATOA_NUTRITIONIX_ID || config.nutritionixId
  const key = process.env.KRAKATOA_NUTRITIONIX_KEY || config.nutritionixKey
  return id && key ? { id, key } : null
}

async function call(path, creds) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'x-app-id': creds.id,
      'x-app-key': creds.key,
      'x-remote-user-id': '0',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await res.text()
  if (!res.ok) {
    let msg = `${res.status}`
    try { msg = JSON.parse(text).message || msg } catch { /* not JSON */ }
    const err = new Error(msg)
    err.status = res.status
    throw err
  }
  return JSON.parse(text)
}

/*
 * `Number(null)` is 0 and `Number('')` is 0, both of which are finite — so the
 * obvious one-liner turned a menu item with no calories into a 0 kcal food that
 * logged silently and looked perfectly correct on screen. Absent has to stay
 * absent all the way through.
 */
const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const round = (n, dp = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** dp) / 10 ** dp : null)

/**
 * One branded search row -> a food with ONE portion and calories only.
 *
 * `partial: true` is the contract with the client: this row is enough to show in
 * a list and NOT enough to log, so tapping it has to fetch the detail first.
 * Without that flag a restaurant item would log as 0 g of protein and look fine.
 */
function fromBranded(row) {
  const kcal = num(row.nf_calories)
  if (!Number.isFinite(kcal)) return null
  const qty = num(row.serving_qty) ?? 1
  const unit = String(row.serving_unit || 'serving').trim()
  return {
    gtin: null,
    nixItemId: String(row.nix_item_id || ''),
    name: String(row.food_name || '').trim() || 'Menu item',
    brand: String(row.brand_name || '').trim() || null,
    image: null,
    source: 'restaurant',
    partial: true,
    portions: [{
      id: 'serving',
      label: qty === 1 ? unit : `${qty} ${unit}`,
      grams: num(row.serving_weight_grams),
      kcal: Math.round(kcal),
      protein: null, carbs: null, fat: null,
    }],
  }
}

/** A full item -> a food that can actually be logged. */
function fromItem(f) {
  const kcal = num(f.nf_calories)
  if (!Number.isFinite(kcal)) return null
  const qty = num(f.serving_qty) ?? 1
  const unit = String(f.serving_unit || 'serving').trim()
  const grams = num(f.serving_weight_grams)

  const serving = {
    id: 'serving',
    label: qty === 1 ? unit : `${qty} ${unit}`,
    grams,
    kcal: Math.round(kcal),
    protein: round(num(f.nf_protein)),
    carbs: round(num(f.nf_total_carbohydrate)),
    fat: round(num(f.nf_total_fat)),
    fiber: round(num(f.nf_dietary_fiber)),
    sugar: round(num(f.nf_sugars)),
    sodium: round(num(f.nf_sodium), 0),
  }

  const portions = [serving]
  // A 100 g portion only where the serving's WEIGHT is known. Deriving one from
  // a serving measured in "burrito" would be inventing a density.
  if (grams && grams > 0) {
    const k = 100 / grams
    portions.push({
      id: '100g',
      label: '100 g',
      grams: 100,
      kcal: Math.round(serving.kcal * k),
      protein: round((serving.protein || 0) * k),
      carbs: round((serving.carbs || 0) * k),
      fat: round((serving.fat || 0) * k),
    })
  }

  return {
    gtin: null,
    nixItemId: String(f.nix_item_id || ''),
    name: String(f.food_name || '').trim() || 'Menu item',
    brand: String(f.brand_name || '').trim() || null,
    image: null,
    source: 'restaurant',
    partial: false,
    portions,
  }
}

/** Search the branded/restaurant side. Returns [] when there is no key. */
async function search(query, config, limit = 12) {
  const creds = credsFrom(config)
  const q = String(query || '').trim()
  if (!creds) return { foods: [], configured: false }
  if (q.length < 2) return { foods: [], configured: true }

  const body = await call(
    `/search/instant?query=${encodeURIComponent(q)}&branded=true&common=false&detailed=false`,
    creds,
  )
  const foods = (body.branded || []).map(fromBranded).filter(Boolean).slice(0, limit)
  return { foods, configured: true }
}

/** One item in full, by its Nutritionix id. */
async function item(nixItemId, config) {
  const creds = credsFrom(config)
  if (!creds) return null
  const id = String(nixItemId || '').trim()
  if (!id) return null
  const body = await call(`/search/item?nix_item_id=${encodeURIComponent(id)}`, creds)
  const f = (body.foods || [])[0]
  return f ? fromItem(f) : null
}

module.exports = { search, item, fromBranded, fromItem, credsFrom }
