/*
 * Reader: McDonald's, from their own nutrition data AS ARCHIVED.
 *
 * McDonald's publishes current US nutrition only through its calculator, and
 * mcdonalds.com answers 403 to anything that is not a real browser — the page,
 * its data endpoint and every product page, with full browser headers. That is
 * a deliberate block and this does not try to get round it.
 *
 * What it reads instead is the Internet Archive's copies of the calculator's
 * own data calls:
 *
 *   https://www.mcdonalds.com/dnaapp/itemList?country=US&...&nutrient_req=Y&item=…
 *
 * — the JSON McDonald's serves to every visitor, captured by the Wayback
 * Machine between 2024 and now. Each call covers the few items one calculator
 * page asked for, so the menu is the UNION of every capture, and where an item
 * was captured more than once the NEWEST copy wins. The capture date of every
 * item is kept, so how old each number is stays visible rather than implied.
 *
 * Two honest limits, said here so they are said somewhere: the menu is only as
 * complete as the archive's captures, and a reformulation since the newest
 * capture of an item will not be in it.
 *
 * Slow on purpose: the Archive throttles, so captures are fetched one at a time
 * with a pause, and the harvest is RESUMABLE — it caches what it has in the temp
 * directory and a re-run fetches only what it has not.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { portion, sortPortions, tidyName, usualPortion } from './common.mjs'

const CACHE = path.join(os.tmpdir(), 'mcd-harvest.json')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** Archived bytes arrive gzipped, brotli'd or plain depending on the capture. */
function decode(buf) {
  for (const fn of [
    (b) => (b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : null),
    (b) => { try { return zlib.brotliDecompressSync(b) } catch { return null } },
    (b) => b,
  ]) {
    const out = fn(buf)
    if (!out) continue
    try { return JSON.parse(out.toString('utf8')) } catch { /* try the next */ }
  }
  return null
}

async function cdx(endpoint, from) {
  const url = `https://web.archive.org/cdx/search/cdx?url=mcdonalds.com/dnaapp/${endpoint}*`
    + `&output=json&from=${from}&filter=statuscode:200&filter=original:.*country=US.*&limit=5000`
  for (let i = 0; i < 4; i++) {
    const res = await fetch(url)
    if (res.ok) return (await res.json()).slice(1).map(([, ts, orig]) => ({ ts, orig }))
    await sleep(5000 * (i + 1))
  }
  throw new Error(`the Archive would not list ${endpoint} captures`)
}

async function harvest(chain, log) {
  const state = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {}
  const items = state.items || {}
  const capturedAt = state.capturedAt || {}
  const done = new Set(state.done || [])
  // A capture that failed three times is remembered and not asked for again,
  // or every build spends minutes re-failing the same few. MCD_RETRY=1 retries.
  const failed = new Set(process.env.MCD_RETRY ? [] : state.failed || [])
  const save = () => fs.writeFileSync(CACHE, JSON.stringify({ items, capturedAt, done: [...done], failed: [...failed] }))

  const captures = [
    ...(await cdx('itemList', chain.archiveFrom)).filter(c => /nutrient_req=Y/.test(c.orig)),
    // One item per call, so fewer items per capture, but some items were only
    // ever archived this way. Optional: the Archive's index of it 503s often.
    ...(await cdx('itemDetails', chain.archiveFrom).catch((e) => { log(`  archive: ${e.message}; using itemList alone`); return [] })),
  ].sort((a, b) => b.ts.localeCompare(a.ts)) // newest first: the first copy seen is the one kept

  const todo = captures.filter(c => !done.has(`${c.ts}|${c.orig}`) && !failed.has(`${c.ts}|${c.orig}`))
  log(`  archive: ${captures.length} captures, ${todo.length} not yet fetched${failed.size ? `, ${failed.size} unreadable (MCD_RETRY=1 to try again)` : ''}`)

  for (const [n, c] of todo.entries()) {
    let body = null
    for (let attempt = 0; attempt < 3 && !body; attempt++) {
      try {
        const res = await fetch(`https://web.archive.org/web/${c.ts}id_/${c.orig}`)
        if (res.ok) body = decode(Buffer.from(await res.arrayBuffer()))
      } catch { /* the Archive dropped the connection; back off and try again */ }
      if (!body) await sleep(4000 * (attempt + 1))
    }
    if (body) {
      // itemList wraps a list; itemDetails wraps one item.
      let its = body.items?.item ?? body.item ?? body.items ?? []
      if (!Array.isArray(its)) its = [its]
      for (const it of its) {
        const id = String(it?.item_id ?? '')
        if (id && !items[id] && it.nutrient_facts?.nutrient) { items[id] = it; capturedAt[id] = c.ts }
      }
      done.add(`${c.ts}|${c.orig}`)
    } else {
      failed.add(`${c.ts}|${c.orig}`)
    }
    save()
    if ((n + 1) % 10 === 0) log(`  archive: ${n + 1}/${todo.length} fetched, ${Object.keys(items).length} items`)
    await sleep(1200)
  }
  return { items, capturedAt }
}

/* ------------------------------------------------------------- the names */

/*
 * McDonald's names a size four different ways — "Small French Fries", "Diet
 * Coke (Small)", "Chicken McNuggets® (4 piece)", "Chicken McNuggets 10 piece" —
 * so a size is found wherever it sits and the rest of the name is the item.
 */
const SIZES = 'Extra Small|Extra Large|Kids|Snack|Small|Medium|Large|Mini|Regular'
const LEAD = new RegExp(`^(${SIZES})\\s+`, 'i')           // "Small French Fries", "Kids Fries"
const PAREN = new RegExp(`\\((${SIZES}|S|M|L)\\)`, 'i')    // "Diet Coke (Small)", "Fanta (S)"
const TAIL = new RegExp(`\\s(${SIZES})$`, 'i')              // "Frappe Dulce De Leche Small"
const PIECES = /\(?\b(\d+)\s*(?:piece|pc)\b\)?/i
const OUNCES = /\(?\b(\d+)\s*Oz\.?\)?/i                      // "Lemonade (16 Oz.)", "Sprite Berry Blast 22 Oz"
const LETTER = { s: 'Small', m: 'Medium', l: 'Large' }

/*
 * A size word counts only where McDonald's puts one — leading, in brackets, or
 * trailing. Anywhere in the middle it is part of a name: "Honest KIDS Appley
 * Ever After" is a juice box, not a kids' size of something.
 */
export function splitSize(raw) {
  let name = tidyName(raw).replace(/\s*§\s*$/, '')
  let size = null
  const take = (m, label) => { if (!size && m) { size = label; name = name.replace(m[0], ' ') } }
  take(name.match(PIECES), name.match(PIECES) && `${name.match(PIECES)[1]} piece`)
  take(name.match(OUNCES), name.match(OUNCES) && `${name.match(OUNCES)[1]} oz`)
  for (const re of [PAREN, LEAD, TAIL]) {
    const m = name.match(re)
    if (m) {
      const w = LETTER[m[1].toLowerCase()] || m[1]
      take(m, w[0].toUpperCase() + w.slice(1).toLowerCase())
    }
  }
  name = name.replace(/\(\s*\)/g, ' ').replace(/\s+/g, ' ').replace(/\s+([,)])/g, '$1').trim()
  return { name, size }
}

const NUTRIENTS = {
  calories: 'kcal', protein: 'protein', carbohydrate: 'carbs', fat: 'fat', fibre: 'fiber',
  sugars: 'sugar', sodium: 'sodium', saturated_fat: 'satFat', cholesterol: 'cholesterol',
}

/* The weight McDonald's gives an item, where it does: 100 g of product carries
   `hundred_g_per_product`, so weight = value / per-100g × 100. */
function gramsOf(nutrients) {
  const cal = nutrients.find(n => n.nutrient_name_id === 'calories')
  const v = Number(cal?.value)
  const per100 = Number(cal?.hundred_g_per_product)
  return v > 0 && per100 > 0 ? (v / per100) * 100 : null
}

export async function read(chain, log = console.log) {
  const { items: raw, capturedAt } = await harvest(chain, log)

  const groups = new Map()
  const skipped = []
  let promo = 0
  let newest = ''
  let oldest = '9'

  for (const [id, it] of Object.entries(raw)) {
    const rawName = tidyName(it.item_name).replace(/\s*§\s*$/, '')
    // McDonald's own flag: "Core" is the standing menu; "Promotional" is a
    // limited run that has mostly ended (Grimace Shake, the Minecraft sauces)
    // and "Do not Show" is their test kitchen ("Samurai Mac (mhq)"). A menu of
    // everything ever archived is a menu of things he cannot order.
    if (chain.onlyCore && String(it.do_not_show) !== 'Core') { promo++; continue }
    // "Coca-Cola (Medium) No Ice" is the same drink with more of it in the cup;
    // the with-ice figure is what is poured by default.
    if (chain.skipNames?.some(re => re.test(rawName))) { skipped.push(rawName); continue }
    let cat = it.default_category?.category?.name ?? null
    if (!cat || cat === 'None') {
      // Some captures carry no category at all. Placed by name — which only
      // decides the HEADING it sits under, never a number.
      cat = chain.guessCategory?.find(([re]) => re.test(rawName))?.[1] ?? cat
    }
    const place = cat && chain.categories[cat]
    if (!place) { skipped.push(`${rawName} [${cat}]`); continue }

    const nutrients = it.nutrient_facts.nutrient
    const v = {}
    for (const n of nutrients) {
      const k = NUTRIENTS[n.nutrient_name_id]
      // `value` is the figure McDonald's DISPLAYS, already label-rounded. It is
      // used over `raw_value` so a number here matches their app and board.
      if (k) v[k] = n.value === '<1' ? 0.5 : Number(n.value)
    }
    if (!Number.isFinite(v.kcal)) { skipped.push(`${tidyName(it.item_name)} (no calories)`); continue }

    const split = splitSize(it.item_name)
    const name = chain.nameAliases?.[split.name] || split.name
    const size = split.size
    const gKey = `${place.step}|${name.toLowerCase()}`
    if (!groups.has(gKey)) groups.set(gKey, { name, category: place.category, step: place.step, portions: [], captured: [] })
    const g = groups.get(gKey)
    // "Chicken McNuggets" over "Chicken Mcnuggets": captures disagree on case,
    // and the one with more capitals is the one off the menu board.
    const caps = (x) => (x.match(/[A-Z]/g) || []).length
    if (caps(name) > caps(g.name)) g.name = name
    const label = size || '1 serving'
    // Two captures of the same size (a regional variant, a re-capture under a new
    // id) are one portion: the newer is kept and the older dropped.
    if (g.portions.some(p => p.label === label)) continue
    g.portions.push(portion(`p${g.portions.length}`, label, v, gramsOf(nutrients)))
    g.captured.push(capturedAt[id])
    if (capturedAt[id] > newest) newest = capturedAt[id]
    if (capturedAt[id] < oldest) oldest = capturedAt[id]
  }

  const items = [...groups.values()].map(g => {
    g.portions = sortPortions(g.portions)
    const oldestCapture = g.captured.sort()[0]
    delete g.captured
    return { ...g, defaultPortion: usualPortion(g.portions), capturedAt: oldestCapture.slice(0, 8) }
  })

  const d = (ts) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`
  return {
    items,
    unplaced: [],
    checks: [
      `${Object.keys(raw).length} archived items, captured ${d(oldest)} to ${d(newest)}`,
      `${promo} promotional or test-kitchen items left out; ${skipped.length} no-ice, meal or unplaceable entries left out`,
    ],
    mismatches: [],
    published: d(newest),
    capturedFrom: d(oldest),
  }
}
