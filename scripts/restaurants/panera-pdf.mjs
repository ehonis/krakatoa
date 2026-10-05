/*
 * Reader: Panera Bread's nutrition guide, as the Internet Archive kept it.
 *
 * Panera publishes a new guide every menu cycle at
 *   panerabread.com/content/dam/panerabread/documents/c<cycle>-<yy>-nutrition-guide.pdf
 * and panerabread.com answers 403 to anything that is not a real browser — the
 * guide, the menu and the home page alike. Same call as McDonald's: that block
 * is not worked around. The Archive's capture of the guide is Panera's own PDF,
 * byte for byte, so that is what is read. `chain.pdf` names the exact capture.
 *
 * THE TABLE. One row per serving, twelve numbers, exported from Excel:
 *
 *   Honey Walnut Cream Cheese Spread -
 *                         1 Container   130  90  10  6  0  25  160  9  0  8  4  N/A
 *   1.5 oz
 *
 * A long name wraps ABOVE and BELOW its numbers, vertically centred in its cell
 * — the Bibibop problem again — so this reads word coordinates too and gives
 * every name fragment to the nearest numbers line on its page. Section headings
 * ("SANDWICHES") are the all-caps lines, and every one must be in the chain's
 * `sections` map, or the build fails: a new section is a change worth seeing.
 *
 * THE SELF-CHECK. The guide prints fat twice: grams, and "calories from fat".
 * Those are two columns that must agree (about 9 kcal a gram, both label-
 * rounded), so a row read one column out of place disagrees with itself.
 *
 * SIZES. Panera names a size as a dash-separated part of the name —
 * "Asian Sesame Chicken - Half", "Bistro French Onion - Cup", "Agave Lemonade -
 * 20 fl oz" — so that part becomes a PORTION of one item, as with the other
 * chains. Group and catering sizes are dropped: they feed an office, not him.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fetchTo, portion, sortPortions, tidyName, usualPortion } from './common.mjs'

const COLS = ['kcal', 'kcalFat', 'fat', 'satFat', 'transFat', 'cholesterol', 'sodium', 'carbs', 'fiber', 'sugar', 'protein', 'caffeine']
const NUMERIC = /^(<1|N\/A|\d+(\.\d+)?)$/
const num = (s) => (s === '<1' ? 0.5 : s === 'N/A' ? null : Number(s))

function words(pdfPath) {
  const tmp = path.join(os.tmpdir(), `krakatoa-${process.pid}-panera.html`)
  execFileSync('pdftotext', ['-bbox', pdfPath, tmp])
  const html = fs.readFileSync(tmp, 'utf8')
  fs.unlinkSync(tmp)
  const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  return html.split('<page ').slice(1).map(chunk => {
    const ws = [...chunk.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)<\/word>/g)]
      .map(m => ({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], t: decode(m[5]), cy: (+m[2] + +m[4]) / 2 }))
    // "less than 1" is one value in three words.
    for (let i = 0; i + 2 < ws.length; i++) {
      if (ws[i].t === 'less' && ws[i + 1].t === 'than' && ws[i + 2].t === '1') {
        ws.splice(i, 3, { ...ws[i], x1: ws[i + 2].x1, t: '<1' })
      }
    }
    return ws
  })
}

function lines(ws) {
  const sorted = [...ws].sort((a, b) => a.cy - b.cy || a.x0 - b.x0)
  const out = []
  for (const w of sorted) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.cy - w.cy) < 2.5) { last.words.push(w); last.cy = (last.cy + w.cy) / 2 } else out.push({ cy: w.cy, words: [w] })
  }
  for (const l of out) l.words.sort((a, b) => a.x0 - b.x0)
  return out
}

/*
 * The columns, measured off each page's own header rather than assumed: the
 * numbers start at the "Calories" heading, and the serving column is what sits
 * between the names and the numbers. Names start at the left margin and never
 * reach the serving column's left edge, which the build asserts.
 */
function readPage(ws, state, problems) {
  const serving = ws.find(w => w.t === 'Serving')
  // Two headings say "Calories" — "Calories (kcal)" and "Calories from Fat" —
  // and the numbers start at the LEFT one.
  const calories = ws.filter(w => w.t === 'Calories').sort((a, b) => a.x0 - b.x0)[0]
  if (!serving || !calories) return []
  const bodyTop = Math.max(serving.cy, calories.cy) + 10
  const valueX = calories.x0 - 15
  // Everything above the column headings is the page's own header: the title,
  // the edition, the copyright line.
  const body = ws.filter(w => w.cy > bodyTop)

  const ls = lines(body).filter(l => !/^Page \d+$/.test(l.words.map(w => w.t).join(' ')))
  const valuesOf = (l) => l.words.filter(w => w.x0 >= valueX && NUMERIC.test(w.t))

  // Where each column sits on this page, from the rows that fill all twelve.
  // A row with an empty cell (a bottled drink with no fibre figure) is then read
  // by POSITION, so the blank stays blank instead of shifting sugar into fibre.
  const full = ls.map(valuesOf).filter(v => v.length === COLS.length)
  const centre = COLS.map((_, i) => {
    const xs = full.map(v => (v[i].x0 + v[i].x1) / 2).sort((a, b) => a - b)
    return xs[Math.floor(xs.length / 2)]
  })
  const byPosition = (vals) => {
    const out = COLS.map(() => undefined)
    for (const w of vals) {
      const cx = (w.x0 + w.x1) / 2
      const i = centre.reduce((best, c, j) => (Math.abs(c - cx) < Math.abs(centre[best] - cx) ? j : best), 0)
      if (out[i] !== undefined) return null // two values in one column: not a row this can read
      out[i] = w.t
    }
    return out.map(t => (t === undefined ? 'N/A' : t))
  }

  const rows = []
  const loose = []
  for (const l of ls) {
    const vals = valuesOf(l)
    const left = l.words.filter(w => w.x0 < valueX)
    const cells = vals.length === COLS.length ? vals.map(w => w.t) : vals.length >= COLS.length - 2 && full.length ? byPosition(vals) : null
    if (cells && cells[0] !== 'N/A') {
      rows.push({ cy: l.cy, values: cells.map(num), left, name: [], serving: [], section: null })
      continue
    }
    const text = left.map(w => w.t).join(' ').trim()
    if (text && !vals.length && /[A-Z]{3}/.test(text) && text === text.toUpperCase() && !/\d/.test(text)) {
      loose.push({ heading: text, cy: l.cy })
      continue
    }
    if (vals.length) problems.push(`page line "${l.words.map(w => w.t).join(' ')}" has ${vals.length} numbers, not ${COLS.length}`)
    for (const w of left) loose.push({ word: w })
  }

  // The serving column's left edge on this page: the leftmost serving word on
  // a numbers line, found as the first word after the widest gap.
  const servingX = Math.min(...rows.flatMap(r => {
    const ws2 = r.left
    let best = null
    for (let i = 1; i < ws2.length; i++) {
      const gap = ws2[i].x0 - ws2[i - 1].x1
      if (!best || gap > best.gap) best = { gap, x: ws2[i].x0 }
    }
    // A numbers line whose only text is the serving (the name wrapped away).
    return best && best.gap > 12 ? [best.x] : ws2.length && ws2[0].x0 > 150 ? [ws2[0].x0] : []
  }), serving.x0)

  // Headings in reading order, so a row's section is the last heading above it,
  // carried across pages.
  const headings = loose.filter(x => x.heading).sort((a, b) => a.cy - b.cy)
  for (const r of rows) {
    const above = headings.filter(h => h.cy < r.cy).pop()
    r.section = above ? above.heading : state.section
    for (const w of r.left) (w.x0 < servingX - 2 ? r.name : r.serving).push(w)
  }
  if (headings.length) state.section = headings[headings.length - 1].heading

  // Every other left-hand word is a wrapped fragment of the nearest row.
  for (const { word: w } of loose.filter(x => x.word)) {
    if (!rows.length) continue
    const nearest = rows.reduce((a, b) => (Math.abs(b.cy - w.cy) < Math.abs(a.cy - w.cy) ? b : a))
    if (Math.abs(nearest.cy - w.cy) > 16) continue // a stray line, not a name
    ;(w.x0 < servingX - 2 ? nearest.name : nearest.serving).push(w)
  }

  return rows.map(r => {
    const join = (ws2) => ws2.sort((a, b) => a.cy - b.cy || a.x0 - b.x0).map(w => w.t).join(' ').replace(/\s+/g, ' ').trim()
    return {
      section: r.section,
      name: join(r.name).replace(/(\w)- (\w)/g, '$1-$2'),
      serving: join(r.serving),
      nameRight: Math.max(0, ...r.name.map(w => w.x1)),
      servingX,
      values: Object.fromEntries(COLS.map((c, i) => [c, r.values[i]])),
    }
  })
}

/* ------------------------------------------------------------ the sizes */

const SIZE = /^(Half|Whole|Cup|Bowl|Bread Bowl|Small|Medium|Large|Regular|(?:Breakfast )?Sandwich Portion|\d+(?:\.\d+)? fl oz|\d+(?:\.\d+)? oz)\b\s*(.*)$/i
const GROUP = /^(Group|Serves \d+|Family|Catering)\b/i

/**
 * "Market Bowl - Sesame Ginger Chicken - Half - No Almonds"
 *   -> { name: 'Market Bowl - Sesame Ginger Chicken - No Almonds', size: 'Half' }
 * A dash only separates where it has a space on at least one side, so
 * "Chipotle-Honey" is one word and "Chicken- Half" is two parts.
 */
export function splitSize(raw) {
  // "Ciabatta Cheesesteak on Ciabatta-Half", "Mac & Cheese-Cup": a size glued
  // on with a bare hyphen is still a size.
  const spaced = tidyName(raw).replace(/(\w)-(Half|Whole|Cup|Bowl|Bread Bowl|Sandwich Portion)\b/gi, '$1 - $2')
  const parts = spaced.split(/\s+-\s*|\s*-\s+/).map(s => s.trim()).filter(Boolean)
  let size = null
  let group = false
  const keep = []
  for (const [i, p] of parts.entries()) {
    const m = i > 0 && !size ? p.match(SIZE) : null
    if (m) {
      size = m[1].replace(/\bfl oz\b/i, 'fl oz')
      size = size[0].toUpperCase() + size.slice(1)
      // "Asian Sesame Vinaigrette - Half Portion": the word after the size is
      // just more size.
      if (m[2] && !/^portions?$/i.test(m[2])) keep.push(m[2])
      continue
    }
    if (i > 0 && GROUP.test(p)) { group = true; continue }
    keep.push(p)
  }
  // A qualifier in brackets ("(no nuts)") rides on the name, not after a dash.
  const name = keep.reduce((acc, p) => (!acc ? p : p.startsWith('(') ? `${acc} ${p}` : `${acc} - ${p}`), '')
  if (size && /sandwich portion/i.test(size)) size = 'Sandwich'
  return { name, size, group }
}

export async function read(chain) {
  const file = await fetchTo(chain.pdf, path.join(os.tmpdir(), `krakatoa-${chain.id}.pdf`))
  // The Archive hands this PDF back gzipped.
  const raw = fs.readFileSync(file)
  if (raw[0] === 0x1f && raw[1] === 0x8b) fs.writeFileSync(file, zlib.gunzipSync(raw))

  const problems = []
  const state = { section: null }
  const rows = words(file).flatMap(ws => readPage(ws, state, problems))

  const unplaced = []
  const skipped = new Set()
  const groups = new Map()
  let groupsDropped = 0
  let namesDropped = 0
  let fatChecked = 0
  const fatOff = []

  for (const r of rows) {
    if (!r.section || !(r.section in chain.sections)) { unplaced.push(`[${r.section ?? 'no heading'}] "${r.name}" — add the section to the panera sections map`); continue }
    const place = chain.sections[r.section]
    if (!place) { skipped.add(r.section); continue }
    if (!r.name) { unplaced.push(`[${r.section}] a row with no name, ${r.values.kcal} kcal`); continue }
    if (r.nameRight >= r.servingX - 2) problems.push(`"${r.name}" runs into the serving column`)

    const v = r.values
    if (Number.isFinite(v.fat) && Number.isFinite(v.kcalFat) && v.kcal >= 40) {
      fatChecked++
      if (Math.abs(v.kcalFat - 9 * v.fat) > Math.max(15, v.kcalFat * 0.2)) fatOff.push(`${r.name}: ${v.fat} g fat but ${v.kcalFat} kcal from fat`)
    }

    if (chain.skipNames?.some(re => re.test(r.name))) { namesDropped++; continue }
    // Panera writes some names back to front ("Cookie - Candy"); the chain's
    // `rename` rules turn them round before anything is grouped on them.
    let rawName = r.name
    for (const [re, to] of [...(chain.rename || []), ...(place.rename || [])]) rawName = rawName.replace(re, to)
    const { name, size, group } = splitSize(rawName)
    if (group) { groupsDropped++; continue }
    const k = `${place.step}|${name.toLowerCase()}`
    if (!groups.has(k)) groups.set(k, { name, category: place.category, step: place.step, portions: [] })
    const g = groups.get(k)
    // "20 fl oz · 20 fl oz (591 mL)" says it twice; the size alone will do.
    const label = !size ? r.serving || '1 serving'
      : r.serving.toLowerCase().startsWith(size.toLowerCase()) ? size : `${size} · ${r.serving}`
    if (g.portions.some(p => p.label === label)) continue // the guide repeats a few rows across pages
    // "2 oz (about 2 3/4 inch slice / 57g)" carries its own weight.
    const grams = r.serving.match(/(\d+(?:\.\d+)?)\s*g\)/)?.[1]
    g.portions.push(portion(`p${g.portions.length}`, label, v, grams ? Number(grams) : null))
  }

  const SIZE_ORDER = ['sandwich', 'cup', 'half', 'bowl', 'whole', 'bread bowl']
  const items = [...groups.values()].map(g => {
    const first = (p) => p.label.split(' · ')[0].toLowerCase()
    const ps = g.portions.every(p => SIZE_ORDER.includes(first(p)))
      ? [...g.portions].sort((a, b) => SIZE_ORDER.indexOf(first(a)) - SIZE_ORDER.indexOf(first(b))).map((p, i) => ({ ...p, id: `p${i}` }))
      : sortPortions(g.portions)
    // A sandwich opens on the whole one and a soup on the bowl — what you get
    // if you just say the name at the counter.
    const whole = ps.find(p => /^(whole|bowl)\b/i.test(p.label))
    return { ...g, portions: ps, defaultPortion: whole?.id || usualPortion(ps) }
  })

  // Fewer than one in thirty disagreeing is the guide's own rounding; more is
  // the columns being read out of place, which is a failed build.
  const mismatches = [...problems]
  if (fatOff.length > fatChecked / 30) mismatches.push(`${fatOff.length} of ${fatChecked} rows disagree with their own fat columns:`, ...fatOff.slice(0, 8))

  return {
    items,
    unplaced,
    checks: [
      `${fatChecked} rows' fat grams agree with their own "calories from fat" column${fatOff.length ? ` (${fatOff.length} off by more than rounding)` : ''}`,
      `${[...skipped].join(', ') || 'no sections'} left out; ${groupsDropped} group and catering sizes and ${namesDropped} drive-thru duplicates dropped`,
    ],
    mismatches,
    published: chain.published,
  }
}
