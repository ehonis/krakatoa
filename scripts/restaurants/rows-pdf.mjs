/*
 * Reader: a PDF table with ONE ROW PER LINE and an explicit portion column.
 * Chipotle's.
 *
 *   Chicken                           4 oz      180  60  7  3  0  125  310  0  0  0  32
 *   Coca-Cola Classic                22 fl oz   260   0  0  ...
 *                                    32 fl oz   380   0  0  ...
 *
 * The second drink line has NO NAME: it is the same drink's large cup, so it
 * becomes a second portion of the row above rather than an item of its own.
 *
 * Every FOOD row must be placed by the chain's `rows` map — the build fails on
 * one it has not seen, because a new menu item arriving unplaced is exactly the
 * change worth noticing. Drinks are placed by rule (a fluid-ounce cup of twelve
 * or more), because the chain adds and drops sodas constantly and none of them
 * is a question about how to build a burrito.
 *
 * Cross-check: the same PDF prints each ingredient's calories a SECOND time on
 * its front page ("CHICKEN* 180 cal | 4 oz"), typeset separately from the table.
 * Two independent printings of one number agreeing is the check.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fetchTo, key, portion, tidyName } from './common.mjs'

const NUM = String.raw`(?:\d+(?:\.\d+)?|<1)`
const PORTION = String.raw`\d+(?:\.\d+)?\s*(?:ea|fl oz|oz)`
const ELEVEN = `${NUM}(?:\\s+${NUM}){10}`
const ROW = new RegExp(String.raw`^\s{0,6}(\S.*?)\s{2,}(${PORTION})\s+(${ELEVEN})\s*$`)
const CONT = new RegExp(String.raw`^\s{10,}(${PORTION})\s+(${ELEVEN})\s*$`)
/* Chipotle's column order, same eleven as Bibibop's. */
const COLS = ['kcal', 'kcalFat', 'fat', 'satFat', 'transFat', 'cholesterol', 'sodium', 'carbs', 'fiber', 'sugar', 'protein']

const toNum = (s) => (s === '<1' ? 0.5 : Number(s))
const values = (s) => Object.fromEntries(s.trim().split(/\s+/).map((v, i) => [COLS[i], toNum(v)]))

/** "4 oz" -> 113.4 g. Weight ounces only; a fluid ounce is a volume. */
const gramsOf = (label) => {
  const m = label.match(/^([\d.]+)\s*oz$/)
  return m ? Number(m[1]) * 28.3495 : null
}

/*
 * `skipFrom` / `resumeAt` cut out a region — Chipotle's kids' table repeats every
 * ingredient at kids' portions under the same names, and read as the main table
 * it would give "Chicken" a second, smaller row. The region ends at the next
 * page's first row.
 */
function tableRows(text, { skipFrom, resumeAt } = {}) {
  const rows = []
  let last = null
  let skipping = false
  for (const line of text.split('\n')) {
    if (skipFrom && skipFrom.test(line)) { skipping = true; last = null; continue }
    let m = line.match(ROW)
    if (skipping && m && resumeAt?.test(m[1].trim())) skipping = false
    if (skipping) continue
    if (m) {
      last = { name: m[1].trim(), portions: [{ label: m[2].replace(/\s+/g, ' '), v: values(m[3]) }] }
      rows.push(last)
      continue
    }
    m = line.match(CONT)
    if (m && last) last.portions.push({ label: m[1].replace(/\s+/g, ' '), v: values(m[2]) })
  }
  return rows
}

/** "CHICKEN* 180 cal | 4 oz" and "Cilantro-Lime Rice 210 cal | 4 oz" off the front page. */
function frontPageCalories(text) {
  const out = []
  // Name and number on the SAME line only. The front page is two columns, and
  // where a name wraps, the number under it lines up with the OTHER column's
  // next line — letting the match cross a newline paired "Queso Blanco" with
  // the fresh tomato salsa's 25 calories.
  for (const m of text.matchAll(/([A-Z][A-Za-z&'\- ]{2,40}?)\*?[ \t]+(\d+)[ \t]*cal[ \t]*\|[ \t]*([\d.]+[ \t]*(?:fl[ \t]*)?oz)/g)) {
    out.push({ name: m[1].trim(), kcal: Number(m[2]), portion: m[3].replace(/\s+/g, ' ') })
  }
  return out
}

export async function read(chain) {
  const pdfPath = await fetchTo(chain.pdf, path.join(os.tmpdir(), `krakatoa-${chain.id}.pdf`))
  const txtPath = `${pdfPath}.txt`
  execFileSync('pdftotext', ['-layout', pdfPath, txtPath])
  const text = fs.readFileSync(txtPath, 'utf8')

  const rows = tableRows(text, chain)
  const byKey = new Map()
  const unplaced = []
  const seen = new Set()

  for (const row of rows) {
    const k = key(row.name)
    if (seen.has(k)) continue // a later page repeating the table
    seen.add(k)

    const isDrink = row.portions.every(p => /fl oz/.test(p.label) && parseFloat(p.label) >= 12)
    const place = chain.rows[k] || (isDrink ? { item: row.name, step: 'drinks', category: 'Drinks' } : null)
    if (!place) { unplaced.push(`"${row.name}" ${row.portions[0].v.kcal} kcal — add it to the ${chain.id} rows map`); continue }

    for (const target of [].concat(place)) {
      const itemKey = key(target.item || row.name)
      if (!byKey.has(itemKey)) {
        byKey.set(itemKey, {
          name: tidyName(target.item || row.name),
          category: target.category,
          step: target.step,
          portions: [],
        })
      }
      const it = byKey.get(itemKey)
      for (const p of row.portions) {
        const label = target.portion
          ? `${target.portion} · ${p.label}`
          : isDrink ? `${p.label.startsWith('22') ? 'Regular' : 'Large'} · ${p.label}` : p.label
        const out = portion(`p${it.portions.length}`, label, p.v, gramsOf(p.label))
        // What choosing this portion makes the order: a burrito tortilla makes a burrito.
        if (target.vessel) out.vessel = target.vessel
        it.portions.push(out)
      }
    }
  }

  const items = [...byKey.values()]

  /* ------------------------------------------ the front page, independently */
  const front = frontPageCalories(text.split(/nutrition\s*\n/i)[0] || text)
  let compared = 0
  const mismatches = []
  for (const f of front) {
    const alias = chain.frontAliases?.[key(f.name)]
    const want = key(alias || f.name)
    const it = items.find(i => key(i.name) === want)
    if (!it) continue // the front page also lists whole dishes ("BURRITO 740–1210 cal")
    const p = it.portions.find(x => x.label.replace(/^.*· /, '') === f.portion) || it.portions[0]
    compared++
    if (p.kcal !== f.kcal) mismatches.push(`${f.name}: front page says ${f.kcal} kcal for ${f.portion}, table says ${p.kcal}`)
  }

  return {
    items,
    unplaced,
    checks: [`${compared} front-page calorie figures agree with the table`],
    mismatches,
    published: chain.published,
  }
}
