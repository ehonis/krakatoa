/*
 * Krakatoa — asking the world what a barcode is.
 *
 * Two databases, in order, because they miss different things: Open Food Facts is
 * free, keyless and crowdsourced (excellent in the EU, patchy and improving in the
 * US); USDA's Branded dataset is manufacturer label submissions (trustworthy,
 * US-only, staler). A UPC that one has never heard of is routinely in the other —
 * verified on the way in: Coca-Cola 049000042566 is in OFF and not in USDA.
 *
 * Everything here is best effort. A lookup that fails returns null and the app
 * offers manual entry; it never throws into a request the phone is waiting on.
 */

const nutrition = require('./nutrition.js')

/*
 * OFF asks that clients identify themselves and rate-limits product reads to
 * roughly 100/min. One person scanning their groceries is nowhere near that, but
 * the header is a condition of use, not a nicety.
 */
const OFF_UA = process.env.KRAKATOA_OFF_UA || 'Krakatoa/0.1 (self-hosted personal tracker)'
const OFF_BASE = process.env.KRAKATOA_OFF_BASE || 'https://world.openfoodfacts.org'
/* Which country's shelf SEARCH is scoped to. See searchFoods. */
const OFF_COUNTRY = process.env.KRAKATOA_OFF_COUNTRY || 'us'
const OFF_COUNTRY_NAME = process.env.KRAKATOA_OFF_COUNTRY_NAME || 'united-states'
const OFF_SEARCH = process.env.KRAKATOA_OFF_SEARCH || 'https://search.openfoodfacts.org'

/*
 * DEMO_KEY works and is rate-limited to about 30 requests/hour per IP, which is
 * enough for the fallback path but not enough to lean on. A free key from
 * https://fdc.nal.usda.gov/api-key-signup.html lifts it to 1000/hour; drop it in
 * data/config.json as { "usdaKey": "..." } or set KRAKATOA_USDA_KEY.
 */
const USDA_BASE = 'https://api.nal.usda.gov/fdc/v1'

const TIMEOUT_MS = Number(process.env.KRAKATOA_LOOKUP_TIMEOUT_MS || 8000)

/** The fields OFF needs to return. Asking for all of them moves ~40 KB per scan. */
const OFF_FIELDS = [
  'code', 'product_name', 'generic_name', 'brands',
  'serving_size', 'serving_quantity', 'serving_quantity_unit', 'nutriments',
  // The front-of-pack photo. Asked for by name like everything else — requesting
  // the whole product doc moves ~40 KB a scan for the sake of two strings.
  'image_front_small_url', 'image_small_url',
].join(',')

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

/* ------------------------------------------------------------------ barcode */

/** One GTIN form against Open Food Facts. Returns a food or null. */
async function offProduct(gtin) {
  const url = `${OFF_BASE}/api/v2/product/${encodeURIComponent(gtin)}.json?fields=${OFF_FIELDS}`
  const body = await getJson(url, { 'User-Agent': OFF_UA, Accept: 'application/json' })
  // OFF answers 200 with status 0 for "no such product", so the HTTP code says
  // nothing about whether the barcode is known.
  if (body?.status === 0 && !body?.product) return null
  return nutrition.fromOpenFoodFacts(body, { gtin })
}

/** One GTIN form against USDA Branded. Returns a food or null. */
async function usdaProduct(gtin, key) {
  const url = `${USDA_BASE}/foods/search?query=${encodeURIComponent(gtin)}`
    + `&dataType=Branded&pageSize=5&api_key=${encodeURIComponent(key)}`
  const body = await getJson(url, { Accept: 'application/json' })
  const foods = Array.isArray(body?.foods) ? body.foods : []
  // A UPC query is a full-text search, so it can match a food whose DESCRIPTION
  // happens to contain the digits. Only an exact gtinUpc match is this barcode.
  const want = new Set(nutrition.gtinCandidates(gtin))
  const hit = foods.find(f => want.has(String(f.gtinUpc || '').trim()))
  return hit ? nutrition.fromUsda(hit) : null
}

/**
 * Look a scanned barcode up. Tries every plausible GTIN form against OFF, then
 * the same against USDA — a 12-digit UPC-A and its zero-padded 13-digit EAN are
 * the same physical barcode and the two databases store different ones, which is
 * the commonest reason a scan reads as "not found" when the product is right there.
 *
 * `sources` is for tests and for the offline path; default is the live two.
 */
async function lookupBarcode(raw, { usdaKey = 'DEMO_KEY', sources } = {}) {
  const candidates = nutrition.gtinCandidates(raw)
  if (!candidates.length) return { food: null, tried: [], error: 'not a barcode' }

  const chain = sources || [
    { name: 'off', fn: (g) => offProduct(g) },
    { name: 'usda', fn: (g) => usdaProduct(g, usdaKey) },
  ]

  const tried = []
  for (const source of chain) {
    for (const gtin of candidates) {
      try {
        const food = await source.fn(gtin)
        tried.push({ source: source.name, gtin, hit: !!food })
        if (food) return { food: { ...food, gtin: nutrition.normalizeGtin(raw) }, tried }
      } catch (e) {
        // A source being down is not a miss — the NEXT source still gets a turn,
        // and the reason travels back so the screen can say "USDA is down" rather
        // than "not found", which are different problems with different fixes.
        tried.push({ source: source.name, gtin, error: String(e.message || e) })
      }
    }
  }
  return { food: null, tried }
}

/* ------------------------------------------------------------------- search */

/**
 * Search by name. This is the door for everything with no barcode on it — an
 * apple, a restaurant meal, the rice you cooked — and for a scan that missed.
 * OFF and USDA are both searched and the results interleaved, OFF first because
 * its names are human ("Clif Bar Chocolate Chip" vs "BAR, CHOCOLATE CHIP").
 */
async function searchFoods(query, { usdaKey = 'DEMO_KEY', limit = 20 } = {}) {
  const q = String(query || '').trim()
  if (q.length < 2) return { foods: [], tried: [] }

  const hit = searchCache.get(q.toLowerCase())
  if (hit && Date.now() - hit.at < hit.ttl) return { ...hit.result, cached: true }
  // Typing "donut" asks for "do", "don", "donu" and "donut" within a second or
  // two; the same query in flight twice is one request, not two.
  const inflight = searching.get(q.toLowerCase())
  if (inflight) return inflight
  const run = searchUncached(q, { usdaKey, limit })
    .then((result) => {
      // Cache what came back whole for twenty minutes, and a partial answer (one
      // database down) for one — long enough to absorb a retype, short enough
      // that a recovered database is asked again soon.
      const failed = result.tried.some(t => t.error)
      if (!result.tried.every(t => t.error)) {
        searchCache.set(q.toLowerCase(), { at: Date.now(), ttl: failed ? 60e3 : 20 * 60e3, result })
        if (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value)
      }
      return result
    })
    .finally(() => searching.delete(q.toLowerCase()))
  searching.set(q.toLowerCase(), run)
  return run
}

const searchCache = new Map()
const searching = new Map()
let usdaResting = 0

/*
 * Open Food Facts search. Its newer search service first
 * (search.openfoodfacts.org — "search-a-licious"): 0.3–0.7 s where the old
 * cgi/search.pl took seconds, better ranking, and it is not the endpoint OFF
 * rate-limits hardest — the old one answered "503" to "life savers" and to one
 * "donut" in five when measured, which on screen was "Nothing found". The old
 * endpoint stays as the fallback, and either gets one retry on a 5xx.
 *
 * Scoped to products sold in the US by `countries_tags`, for the reason the old
 * one used the `us.` subdomain: searching the world index for "greek yogurt"
 * from the US returns German and British brands.
 */
async function offSearch(q, limit) {
  const headers = { 'User-Agent': OFF_UA, Accept: 'application/json' }
  const sal = `${OFF_SEARCH}/search?q=${encodeURIComponent(`${q} countries_tags:"en:${OFF_COUNTRY_NAME}"`)}`
    + `&page_size=${limit * 2}&fields=${OFF_FIELDS}`
  const old = `${OFF_BASE.replace('//world.', `//${OFF_COUNTRY}.`)}/cgi/search.pl?search_terms=${encodeURIComponent(q)}`
    + `&search_simple=1&action=process&json=1&page_size=${limit}&fields=${OFF_FIELDS}`
  const attempt = async (url, pick) => {
    for (let i = 0; i < 2; i++) {
      try {
        return pick(await getJson(url, headers))
      } catch (e) {
        if (i === 1 || !(e.status >= 500 || e.name === 'TimeoutError' || e.name === 'AbortError')) throw e
        await new Promise(r => setTimeout(r, 600))
      }
    }
    return null
  }
  try {
    return await attempt(sal, b => b?.hits || [])
  } catch {
    return attempt(old, b => b?.products || [])
  }
}

async function searchUncached(q, { usdaKey, limit }) {
  const tried = []
  const usdaUrl = `${USDA_BASE}/foods/search?query=${encodeURIComponent(q)}`
    + `&dataType=Branded,Foundation,SR%20Legacy&pageSize=${limit}&api_key=${encodeURIComponent(usdaKey)}`

  /*
   * A 429 from USDA is not worth asking again for a while — DEMO_KEY is ~30 an
   * hour for every user of it, and each refused request spends the hour faster.
   * Rest it for fifteen minutes and SAY so, rather than failing silently on
   * every keystroke.
   */
  const usdaCall = Date.now() < usdaResting
    ? Promise.reject(Object.assign(new Error('rate-limited — add a free USDA key (see README)'), { status: 429 }))
    : getJson(usdaUrl, { Accept: 'application/json' }).catch((e) => {
      if (e.status === 429) {
        usdaResting = Date.now() + 15 * 60e3
        e.message = usdaKey === 'DEMO_KEY' ? 'rate-limited — add a free USDA key (see README)' : 'rate-limited'
      }
      throw e
    })

  // BOTH, always, and in parallel. Running USDA only when OFF came up short meant
  // it never ran at all — OFF fills the page every time — so the database with
  // the best US coverage was reachable in theory and dead in practice.
  const [offRes, usdaRes] = await Promise.allSettled([offSearch(q, limit), usdaCall])

  const offFoods = []
  if (offRes.status === 'fulfilled') {
    for (const raw of offRes.value || []) {
      // The newer search sends brands as a list; the converter reads text.
      const product = Array.isArray(raw.brands) ? { ...raw, brands: raw.brands.join(', ') } : raw
      const food = nutrition.fromOpenFoodFacts({ code: product.code, product })
      if (food) offFoods.push(food)
    }
    tried.push({ source: 'off', hits: offFoods.length })
  } else {
    tried.push({ source: 'off', error: String(offRes.reason?.message || offRes.reason) })
  }

  const usdaFoods = []
  if (usdaRes.status === 'fulfilled') {
    for (const f of usdaRes.value?.foods || []) {
      const food = nutrition.fromUsda(f)
      if (food) usdaFoods.push(food)
    }
    tried.push({ source: 'usda', hits: usdaFoods.length })
  } else {
    tried.push({ source: 'usda', error: String(usdaRes.reason?.message || usdaRes.reason) })
  }

  // Interleaved, not concatenated. Appending one list to the other buries the
  // whole of the second database below a full page of the first.
  const merged = []
  for (let i = 0; i < Math.max(offFoods.length, usdaFoods.length); i++) {
    if (offFoods[i]) merged.push(offFoods[i])
    if (usdaFoods[i]) merged.push(usdaFoods[i])
  }

  // The same product from both databases is common. Keyed by gtin where there is
  // one, by name+brand where there is not.
  const seen = new Set()
  const unique = []
  for (const f of merged) {
    const key = f.gtin || `${f.name}|${f.brand}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(f)
  }
  return { foods: unique.slice(0, limit), tried }
}

module.exports = { lookupBarcode, searchFoods, offProduct, usdaProduct }
