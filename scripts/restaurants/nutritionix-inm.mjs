/*
 * Reader: a chain whose OWN nutrition page is a hosted Nutritionix menu.
 * Culver's.
 *
 * Culver's nutrition guide (culvers.com/nutrition-and-allergen-guide) is an
 * iframe of r.nutritionix.com/culvers/landing, which loads one static public
 * file — the same file every visitor to Culver's site is served:
 *
 *   https://nix-vue-inm.s3.amazonaws.com/restaurant/<slug>/data/menu-latest.json.gz
 *
 * So these are Culver's numbers, current to the hour (`generatedAt`), with no
 * key involved. This is NOT the Nutritionix developer API that closed its free
 * tier; it is the chain's published menu. Nutritionix hosts dead copies for
 * other chains too — McDonald's is from 2020 with no active items — which is
 * why `generatedAt` and `isActive` are both checked rather than trusted.
 *
 * Items are named "Name, Size" ("Crinkle Cut Fries, Medium"), so a size becomes
 * a PORTION of one item rather than an item of its own: four chips of fries is
 * a list you scroll past, one with a size picker is a question you answer.
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import zlib from 'node:zlib'
import { fetchTo, labelRound, portion, sortPortions, tidyName, usualPortion } from './common.mjs'

const BASE = 'https://nix-vue-inm.s3.amazonaws.com/restaurant'

/* A Nutritionix field is `calculatedX` when the item is built from defaults,
   and plain `X` when it was entered whole. Whichever is non-zero is the number. */
const pick = (n, field) => {
  const cap = field[0].toUpperCase() + field.slice(1)
  const calc = Number(n[`calculated${cap}`])
  const plain = Number(n[field])
  return Number.isFinite(calc) && calc !== 0 ? calc : Number.isFinite(plain) ? plain : null
}

export async function read(chain) {
  const file = await fetchTo(`${BASE}/${chain.slug}/data/menu-latest.json.gz`, path.join(os.tmpdir(), `krakatoa-${chain.id}.json.gz`))
  const raw = fs.readFileSync(file)
  const d = JSON.parse(raw[0] === 0x1f ? zlib.gunzipSync(raw) : raw)

  const ageDays = (Date.now() - Date.parse(d.generatedAt)) / 86400000
  if (!(ageDays < (chain.maxAgeDays ?? 120))) {
    throw new Error(`${chain.name}: hosted menu is ${Math.round(ageDays)} days old (${d.generatedAt}) — not trusted`)
  }

  const cats = Object.fromEntries(d.categories.map(c => [c.id, c.name]))
  const groups = new Map()
  const skipped = []

  for (const it of d.items) {
    const cat = cats[it.categoryId]
    if (!it.isActive) continue
    if (!cat || chain.skipCategories?.includes(cat)) { skipped.push(tidyName(it.name)); continue }
    const place = chain.categories[cat]
    if (!place) { skipped.push(`${tidyName(it.name)} [${cat}]`); continue }

    const full = tidyName(it.name)
    // "Crinkle Cut Fries, Medium" -> item "Crinkle Cut Fries", size "Medium".
    // Only a comma followed by a SIZE-shaped word splits, so "Deluxe, Single"
    // does and a name that merely contains a comma would not.
    const m = full.match(/^(.*),\s*((?:Mini|Small|Medium|Large|Family|Single|Double|Triple|Regular|\d+ Scoops?|\d+ Pieces?))$/i)
    const base = m ? m[1].trim() : full
    const size = m ? m[2] : null

    const n = it.nutrition || {}
    const v = {
      kcal: pick(n, 'calories'), protein: pick(n, 'protein'), carbs: pick(n, 'totalCarb'),
      fat: pick(n, 'totalFat'), fiber: pick(n, 'fiber'), sugar: pick(n, 'sugars'),
      sodium: pick(n, 'sodium'), satFat: pick(n, 'saturatedFat'), cholesterol: pick(n, 'cholesterol'),
    }
    if (!Number.isFinite(v.kcal)) { skipped.push(`${full} (no calories)`); continue }

    const gKey = `${place.step}|${base}`
    if (!groups.has(gKey)) groups.set(gKey, { name: base, category: place.category, step: place.step, portions: [] })
    const g = groups.get(gKey)
    const label = size || (it.servingUnitName && it.servingUnitName !== 'Order' ? it.servingUnitName : '1 order')
    g.portions.push(portion(`p${g.portions.length}`, label, labelRound(v)))
  }

  const items = [...groups.values()]
  for (const it of items) {
    it.portions = sortPortions(it.portions)
    it.defaultPortion = usualPortion(it.portions)
  }

  return {
    items,
    unplaced: [],
    checks: [`hosted menu generated ${d.generatedAt}`, `${skipped.length} inactive, test or uncategorised entries left out`],
    mismatches: [],
    published: d.generatedAt.slice(0, 10),
  }
}
