/*
 * Reader: a PDF whose tables WRAP their names across lines. Bibibop's.
 *
 * `pdftotext -layout` flattens a table into lines, and these tables wrap their
 * NAMES — "Korean Crispy" sits on the line above its numbers and "Chicken
 * (5oz)" on the line below. Read line by line, the fragment between two rows
 * belongs to either. So this reads WORD COORDINATES (`pdftotext -bbox`) and
 * gives every name fragment to the data row whose vertical centre is nearest,
 * within its own table. That is the geometry the eye uses.
 *
 * It then CROSS-CHECKS against the chain's web page where one exists, and the
 * build refuses to write if they disagree. A parse that is almost right is the
 * dangerous kind.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fetchTo, portion, tidyName } from './common.mjs'

/* --------------------------------------------------------- reading the PDF */

const NUMERIC = /^(<1|N\/A|\d+(\.\d+)?)$/
/* The eleven columns every Bibibop table uses, in order. */
const COLS = ['kcal', 'kcalFat', 'fat', 'satFat', 'transFat', 'cholesterol', 'sodium', 'carbs', 'fiber', 'sugar', 'protein']

function wordsByPage(pdfPath) {
  const tmp = path.join(os.tmpdir(), `krakatoa-${process.pid}-bbox.html`)
  execFileSync('pdftotext', ['-bbox', pdfPath, tmp])
  const html = fs.readFileSync(tmp, 'utf8')
  fs.unlinkSync(tmp)
  const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  return html.split('<page ').slice(1).map(chunk =>
    [...chunk.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)<\/word>/g)]
      .map(m => ({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], t: decode(m[5]), cy: (+m[2] + +m[4]) / 2 })))
}

/** Words sharing a baseline, within a couple of points. */
function lines(words) {
  const sorted = [...words].sort((a, b) => a.cy - b.cy || a.x0 - b.x0)
  const out = []
  for (const w of sorted) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.cy - w.cy) < 2.5) { last.words.push(w); last.cy = (last.cy + w.cy) / 2 } else out.push({ cy: w.cy, words: [w] })
  }
  for (const l of out) l.words.sort((a, b) => a.x0 - b.x0)
  return out
}

const num = (s) => (s === '<1' ? 0.5 : s === 'N/A' ? null : Number(s))

/*
 * Read one page into rows. A DATA row is a line ending in eleven numeric tokens.
 * A HEADER is a line containing "Calories" — each table's column heads, which
 * span three lines and carry the table's own name down the left edge.
 */
function parsePage(words, sectionNames) {
  const ls = lines(words)
  const data = []
  const headers = []

  for (const l of ls) {
    const nums = l.words.filter(w => NUMERIC.test(w.t))
    const tail = nums.slice(-11)
    if (tail.length === 11) {
      data.push({ cy: l.cy, valueX: tail[0].x0, values: tail.map(w => num(w.t)), name: [] })
    } else if (l.words.some(w => w.t === 'Calories')) {
      headers.push(l.cy)
    }
  }
  if (!data.length) return []

  /*
   * The tables are separated by their header bands. A header band is ~20 pt
   * tall; anything in the name column inside one is the table's TITLE, not an
   * item name. Everything else in the name column is a name fragment.
   */
  const bands = []
  for (const h of headers) {
    const last = bands[bands.length - 1]
    if (last && h - last.hi < 16) last.hi = h
    else bands.push({ lo: h, hi: h })
  }
  const inBand = (cy) => bands.find(b => cy >= b.lo - 12 && cy <= b.hi + 12)
  const blockOf = (cy) => bands.filter(b => b.lo - 12 <= cy).length // how many headers above

  for (const d of data) d.block = blockOf(d.cy)

  /*
   * Where the names stop and the numbers start, PER TABLE. Measured per page it
   * was the narrowest table's edge, and the drinks tables at the foot of the
   * last page start their first column twenty points further left than the food
   * tables — so Kombucha and Honest Kids were not recognised as rows at all and
   * silently fell out of the menu.
   */
  const edge = {}
  for (const d of data) edge[d.block] = Math.min(edge[d.block] ?? Infinity, d.valueX)

  // Each table's title, from the name-column words inside its header band.
  const titles = bands.map((b, i) => words
    .filter(w => w.x1 < (edge[i + 1] ?? 200) + 60 && w.cy >= b.lo - 14 && w.cy <= b.hi + 14)
    .filter(w => !/^(Calories|from|Fat|\(g\)|Saturated|Trans|Cholesterol|Sodium|\(mg\)|Carbs|Dietary|Fiber|Sugars|Protein)$/.test(w.t))
    .sort((a, b) => a.cy - b.cy || a.x0 - b.x0)
    .map(w => w.t).join(' ').replace(/\s+/g, ' ').trim())

  const nameWords = words.filter(w => !NUMERIC.test(w.t) && !inBand(w.cy))
  for (const w of nameWords) {
    const block = blockOf(w.cy)
    if (!(w.x1 < (edge[block] ?? 0) - 2)) continue
    const candidates = data.filter(d => d.block === block)
    if (!candidates.length) continue
    const nearest = candidates.reduce((a, b) => (Math.abs(b.cy - w.cy) < Math.abs(a.cy - w.cy) ? b : a))
    // A stray banner far from any row is not a name.
    if (Math.abs(nearest.cy - w.cy) < 22) nearest.name.push(w)
  }

  return data.map(d => {
    const title = titles[d.block - 1] || ''
    const key = Object.keys(sectionNames).find(k => title.toUpperCase().startsWith(k)) || null
    let name = d.name.sort((a, b) => a.cy - b.cy || a.x0 - b.x0).map(w => w.t).join(' ').replace(/\s+/g, ' ').trim()
    /*
     * A word that ends in a hyphen at a line break is ONE word — "Diet Coca-" /
     * "Cola®" is Diet Coca-Cola. Only a hyphen stuck to the letters before it;
     * a spaced dash ("Passionfruit - Tangerine") is punctuation and stays.
     */
    name = name.replace(/(\w)- (\w)/g, '$1-$2')
    /*
     * A table title that runs to four lines can put its last line below the
     * header band, where it reads as the first item's name: "1/3 cup ice)
     * Coca-Cola Classic". A name never starts with a CLOSING bracket it did not
     * open, so anything up to one is title, not name.
     */
    const stray = name.match(/^[^()]*\)\s*/)
    if (stray) name = name.slice(stray[0].length)
    return { section: key, title, name, values: Object.fromEntries(COLS.map((c, i) => [c, d.values[i]])) }
  })
}

/* ----------------------------------------------------------- tidying names */

/** "Korean BBQ Beef (5oz)" -> { name: 'Korean BBQ Beef', serving: '5 oz', grams: 141.7 } */
function splitServing(raw) {
  const m = raw.match(/\(?\s*([\d.]+)\s*(fl\s*oz|oz)\s*\)?\s*$/i)
  if (!m) return { name: raw.trim(), serving: null, grams: null }
  const qty = Number(m[1])
  const unit = m[2].toLowerCase().replace(/\s+/g, ' ')
  const name = raw.slice(0, m.index).replace(/\bSide\s*$/i, 'Side').trim()
  return {
    name,
    serving: `${qty} ${unit}`,
    // Weight only for WEIGHT ounces. A fluid ounce of sauce is a volume, and
    // converting it to grams would be guessing its density.
    grams: unit === 'oz' ? Math.round(qty * 28.3495 * 10) / 10 : null,
  }
}


/* --------------------------------------------------------- the web page */

/*
 * The web page's ingredient cards, for the cross-check only. Each is a modal
 * with its category in the id and "Nutrition: Calories N Fat Ng Carbs Ng
 * Protein Ng" in its body. Some cards format that line differently and are
 * skipped rather than guessed at — the check is only as strong as what it can
 * read, and it says how many it compared.
 */
function pageCards(html) {
  const clean = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;/g, "'").replace(/\s+/g, ' ').trim()
  const out = []
  for (const m of html.matchAll(/id="([a-z0-9-]+)-ingredient-reveal"([\s\S]*?)class="close-button"/g)) {
    const title = m[2].match(/class="ingredient-title">([\s\S]*?)<\/h2>/)
    const nut = clean(m[2]).match(/Calories\s*([\d.]+)\s*Fat\s*([\d.]+)\s*g\s*Carbs\s*([\d.]+)\s*g\s*Protein\s*([\d.]+)\s*g/)
    if (title && nut) out.push({ name: clean(title[1]), kcal: +nut[1], fat: +nut[2], carbs: +nut[3], protein: +nut[4] })
  }
  return out
}

const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, '')


/* ------------------------------------------------------------------ read */

export async function read(chain) {
  const pdfPath = await fetchTo(chain.pdf, path.join(os.tmpdir(), `krakatoa-${chain.id}.pdf`))
  const rows = wordsByPage(pdfPath).flatMap(ws => parsePage(ws, chain.sections))
  const items = []
  const unplaced = []

  for (const r of rows) {
    const section = r.section && chain.sections[r.section]
    if (!section || !r.name || !Number.isFinite(r.values.kcal)) { unplaced.push(r); continue }
    const { name, serving, grams } = splitServing(r.name)
    const clean = tidyName(name)
    items.push({
      name: clean,
      category: section.category,
      step: section.step,
      portions: [portion('serving', serving || section.serving || '1 serving', r.values, grams)],
    })
  }

  /* ---------------------------------------------------- the cross-check */
  let compared = 0
  const mismatches = []
  if (chain.page) {
    const pageFile = await fetchTo(chain.page, path.join(os.tmpdir(), `krakatoa-${chain.id}.html`))
    for (const c of pageCards(fs.readFileSync(pageFile, 'utf8'))) {
      // One name can appear in two tables ("Citrus Honey Kale" the base, "Honey
      // Citrus Kale" the topping), so a card passes if ANY same-named item
      // agrees. Where the page and the PDF name a thing differently there is an
      // explicit alias rather than a looser match — a fuzzy matcher is how a
      // card gets checked against the wrong item and passes.
      const alias = chain.pageAliases?.[norm(c.name)]
      const want = norm(alias || c.name)
      const hits = items.filter(i => {
        const n = norm(i.name)
        return n === want || n === `${want}s` || `${n}s` === want
          || n.split('').sort().join('') === want.split('').sort().join('')
      })
      if (!hits.length) { mismatches.push(`${c.name}: on the page, not found in the PDF`); continue }
      compared++
      const ok = hits.some(i => {
        const p = i.portions[0]
        return p.kcal === c.kcal && p.fat === c.fat && p.carbs === c.carbs && p.protein === c.protein
      })
      if (!ok) {
        const p = hits[0].portions[0]
        mismatches.push(`${c.name}: page says ${c.kcal}/${c.fat}F/${c.carbs}C/${c.protein}P, PDF says ${p.kcal}/${p.fat}F/${p.carbs}C/${p.protein}P`)
      }
    }
  }

  return {
    items,
    unplaced: unplaced.map(u => `[${u.title || '?'}] "${u.name}" ${u.values.kcal} kcal`),
    checks: chain.page ? [`${compared} cross-checked against ${chain.page}`] : [],
    mismatches,
    published: chain.published,
  }
}
