/*
 * Reader: Balance Pan-Asian Grille, from the nutrition its own menu site
 * published, as the Internet Archive kept it.
 *
 * Balance (Toledo, Sylvania, Perrysburg, Cleveland) no longer publishes
 * nutrition: balancegrille.com/nutrition/ is a 404, the dish pages list
 * ingredients only, and its ordering system (LoyaltyPlant) carries no calories.
 * Its old menu site, balance.menu, DID — its 2022 FAQ says "We feature certain
 * food items' nutritional information on balance.menu" — and the Archive's last
 * capture of that site, 2025-07-21, has the numbers compiled into the page's
 * script: every bowl, protein, starch, snack and taco as
 *
 *   title:"green curry", …, nutrition:[{value:"300",unit:"Calories"},{value:"6g",unit:"Protein"}, …]
 *
 * That is what this reads. Two honest limits the chain note says out loud: it
 * is July 2025, and the menu has moved since (lentils are gone, crispy chicken
 * and poppers arrived with no published numbers); and no serving sizes were
 * ever given.
 *
 * HOW A BOWL ADDS UP, per the site's own three steps (choose a bowl, a protein,
 * a starch): a bowl's figure is its sauce and vegetables only. The build is the
 * sum of the three, which is why this is a builder and not a list of dishes.
 *
 * Cross-check: the site published Cleveland and Toledo menus separately. Every
 * item that appears in both must carry the same numbers, or the build fails.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fetchTo, key, portion } from './common.mjs'

const UNITS = { Calories: 'kcal', Protein: 'protein', 'Total Carbohydrate': 'carbs', 'Total Fat': 'fat' }
const titleCase = (s) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b4\b/g, '4')

export async function read(chain) {
  const file = await fetchTo(chain.archive, path.join(os.tmpdir(), `krakatoa-${chain.id}.js`))
  let raw = fs.readFileSync(file)
  if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw)
  const js = raw.toString('utf8')

  /*
   * Anchored on each nutrition block, and named by the LAST item title before
   * it. Not the first title after the previous block: an item with no numbers
   * (the kids bowl) would lend its name to the next one. And not just any
   * title: each item's dietary badges have titles of their own ("Vegan
   * Option", "Choose Tofu or Lentils…"), always right after a `type:"…"`.
   */
  const seen = new Map()
  const mismatches = []
  let from = 0
  for (const m of js.matchAll(/nutrition:\[([^\]]*)\]/g)) {
    const before = js.slice(from, m.index)
    from = m.index + m[0].length
    // (?<![a-z]): "subtitle:" contains "title:", and a badge subtitle is not a name.
    const titles = [...before.matchAll(/(?<![a-z])title:"([^"]{2,60})"/g)]
      .filter(t => !/type:"[^"]*",\s*$/.test(before.slice(Math.max(0, t.index - 40), t.index)))
    if (!titles.length) continue
    const name = titles[titles.length - 1][1].trim()
    const v = {}
    for (const n of m[1].matchAll(/value:"([\d.]+)g?",unit:"([^"]+)"/g)) {
      const k = UNITS[n[2]]
      if (k) v[k] = Number(n[1])
    }
    if (!Number.isFinite(v.kcal)) continue
    const k = key(name)
    const prev = seen.get(k)
    if (prev) {
      if (['kcal', 'protein', 'carbs', 'fat'].some(x => prev.v[x] !== v[x])) {
        mismatches.push(`${name}: ${JSON.stringify(prev.v)} on one city's menu, ${JSON.stringify(v)} on another`)
      }
      continue
    }
    seen.set(k, { name, v })
  }

  const items = []
  const unplaced = []
  for (const [k, { name, v }] of seen) {
    const place = chain.rows[k]
    if (!place) { unplaced.push(`"${name}" ${v.kcal} kcal — add it to the balance rows map`); continue }
    items.push({
      name: titleCase(name),
      category: place.category,
      step: place.step,
      portions: [portion('p0', place.portion, v)],
      defaultPortion: 'p0',
    })
  }

  return {
    items,
    unplaced,
    checks: [`${seen.size} items with published numbers; every item on both city menus agrees`],
    mismatches,
    published: chain.published,
  }
}
