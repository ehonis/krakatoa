/*
 * Krakatoa — menus Ask AI learned, and the check that decides what it may keep.
 *
 * A receipt from a chain Krakatoa does not know (The Cheesecake Factory, say)
 * should teach it that chain's menu for next time. The model may look a chain up on the web
 * and say "their site gives the Chicken Madeira 1,250 kcal". That sentence is
 * where a made-up number would get in, so NOTHING the model reports from the web
 * is kept on its say-so:
 *
 *   the server fetches the page itself, and an item is VERIFIED only when that
 *   page shows the item's name with that exact calorie figure beside it.
 *
 * Verified items are saved here (data/menus/learned.json) as a chain Krakatoa now
 * knows: they appear under Restaurant menus, in search, and in Ask AI's own
 * table next time, marked as read by Ask AI from the chain's own page, with the
 * address. Anything that could not be verified is used once as an estimate that
 * says so, and never saved.
 */

const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const UA = 'Mozilla/5.0 (Krakatoa personal food log; checking one nutrition page)'

const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/* ------------------------------------------------------------- the page */

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&reg;|&trade;|®|™/g, '')
    .replace(/[ \t]+/g, ' ')
}

/**
 * A nutrition page as plain text, fetched by the SERVER. PDFs through
 * pdftotext, HTML with its tags off, JSON as it is. Rejects with the reason —
 * most often a 403, because plenty of chains refuse anything but a browser, and
 * that block is not worked around.
 */
async function fetchText(url, { timeoutMs = 20000, maxBytes = 12 * 1024 * 1024 } = {}) {
  if (!/^https?:\/\//i.test(String(url))) throw new Error('not a web address')
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > maxBytes) throw new Error('too large')
  const type = String(res.headers.get('content-type') || '')
  // How old the document is, so a menu learned from a 2021 guide says 2021 and
  // not the day it was read: the PDF's own dates, else the server's.
  const served = res.headers.get('last-modified')
  let date = served && !Number.isNaN(Date.parse(served)) ? new Date(served).toISOString().slice(0, 10) : null
  if (type.includes('pdf') || buf.subarray(0, 5).toString() === '%PDF-') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krakatoa-learn-'))
    try {
      fs.writeFileSync(path.join(dir, 'doc.pdf'), buf)
      execFileSync('pdftotext', ['-layout', path.join(dir, 'doc.pdf'), path.join(dir, 'doc.txt')], { timeout: 30000 })
      try {
        const info = execFileSync('pdfinfo', [path.join(dir, 'doc.pdf')], { timeout: 10000 }).toString()
        const d = info.match(/^(?:ModDate|CreationDate):\s+(.+)$/m)?.[1]
        if (d && !Number.isNaN(Date.parse(d))) date = new Date(d).toISOString().slice(0, 10)
      } catch { /* no dates in it */ }
      return { text: fs.readFileSync(path.join(dir, 'doc.txt'), 'utf8'), date }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  const body = buf.toString('utf8')
  return { text: type.includes('json') ? body : htmlToText(body), date }
}

/* ------------------------------------------------------------ the check */

const STOP = new Set(['the', 'and', 'with', 'of', 'a', 'an', 'our', 'on', 'in', 'for', 'or', 'w', 'side', 'regular', 'small', 'large', 'order'])
// Thousands separators go first ("1,250" -> "1250"), or the comma becomes a
// space and "1 250" is two numbers; line breaks survive, because a blank line
// is where one item's stretch of the page ends.
const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/(\d),(\d{3})\b/g, '$1$2').replace(/[’']/g, '')
  .replace(/[^a-z0-9.\n]+/g, ' ').replace(/ *\n */g, '\n')

/**
 * Does `text` show this item with this calorie figure? The item's distinctive
 * words must appear together, and the kcal as a number of its own within the
 * same stretch of the document — a table row, or a card on a page. Deliberately
 * strict: a false "no" costs an estimate label; a false "yes" puts a wrong
 * number in his log under the chain's name.
 */
function verifyItem(text, item) {
  const kcal = Math.round(Number(item.kcal))
  if (!Number.isFinite(kcal) || kcal < 0) return false
  const t = norm(text)
  const words = norm(item.name).split(' ').filter(w => w.length > 2 && !STOP.has(w))
  if (!words.length) return false
  const key = [...words].sort((a, b) => b.length - a.length).slice(0, 3)
  const need = Math.min(key.length, 2)
  const anchor = key[0]
  let at = t.indexOf(anchor)
  let tries = 0
  while (at !== -1 && tries < 300) {
    // The name: its words within a line's length of each other.
    const around = t.slice(Math.max(0, at - 80), at + 120)
    if (key.filter(w => around.includes(w)).length >= need) {
      // The number: among the first few numbers AFTER the name, in the same
      // row or card — up to a blank line, which is where the next item starts.
      // A table's first column after the name is calories on every chain
      // guide seen so far; a serving size ("20 fl oz") can come first, hence
      // a few and not one.
      let after = t.slice(at, at + 240)
      const gap = after.indexOf('\n\n')
      if (gap > 0) after = after.slice(0, gap)
      const nums = [...after.matchAll(/(?:^|[^0-9.])(\d+(?:\.\d+)?)(?![0-9])/g)].map(n => Number(n[1])).slice(0, 4)
      if (nums.includes(kcal)) return true
    }
    at = t.indexOf(anchor, at + anchor.length)
    tries++
  }
  return false
}

/**
 * Check everything the model says it found, one fetch per page. Returns, per
 * found item (same order), `{ ok, why }`, plus the pages' text so a verified
 * page can be read in full afterwards for the rest of the menu.
 */
async function verifyFound(found, { fetcher = fetchText } = {}) {
  const pages = new Map()
  for (const f of found || []) {
    if (!f?.sourceUrl || pages.has(f.sourceUrl)) continue
    try {
      const got = await fetcher(f.sourceUrl)
      pages.set(f.sourceUrl, typeof got === 'string' ? { text: got, date: null } : got)
    } catch (e) { pages.set(f.sourceUrl, { error: String(e.message || e) }) }
  }
  const checks = (found || []).map((f) => {
    const page = pages.get(f?.sourceUrl)
    if (!page) return { ok: false, why: 'no source given' }
    if (page.error) return { ok: false, why: `their page would not load for Krakatoa (${page.error})` }
    return verifyItem(page.text, f) ? { ok: true } : { ok: false, why: 'not found on the page it named' }
  })
  return { checks, pages }
}

/* ------------------------------------------------------------ the store */

function makeLearned(dataDir) {
  const file = path.join(dataDir, 'menus', 'learned.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let cache = null

  async function load() {
    if (cache) return cache
    try { cache = JSON.parse(await fsp.readFile(file, 'utf8')) } catch { cache = { chains: [] } }
    return cache
  }

  async function save(doc) {
    cache = doc
    await fsp.writeFile(`${file}.tmp`, JSON.stringify(doc, null, 1))
    await fsp.rename(`${file}.tmp`, file)
  }

  /**
   * Add verified items to a chain, creating it if it is new. Items are keyed by
   * category + name + portion, so learning the same thing twice updates it.
   * Returns how many items were new.
   */
  async function add({ chain, url, items, what, docDate = null }) {
    const doc = await load()
    const id = `learned-${slug(chain)}`
    let c = doc.chains.find(x => x.id === id)
    if (!c) {
      c = {
        id,
        name: chain,
        short: chain.replace(/^The /i, ''),
        kind: 'order',
        learned: true,
        note: `Read by Ask AI from ${chain}'s own nutrition information, and kept only where Krakatoa could find each item's calories on that page itself.`,
        source: { what: `${chain}'s own nutrition information, read by Ask AI`, dateWord: 'read', url, published: new Date().toISOString().slice(0, 10), built: new Date().toISOString().slice(0, 10) },
        steps: [],
        items: [],
      }
      doc.chains.push(c)
    }
    if (url) c.source.url = url
    if (what) c.source.what = what
    // The document's own date where it has one ("dated 2021-10-12"), else the
    // day it was read ("read 2026-09-25") — and the screen says which.
    c.source.published = docDate || new Date().toISOString().slice(0, 10)
    c.source.dateWord = docDate ? 'dated' : 'read'
    let fresh = 0
    for (const it of items) {
      // One spelling per section: a receipt said "Specialties", the guide
      // "SPECIALTIES", and they were two sections with the same dish in each.
      const category = tidyCategory(it.category)
      const name = String(it.name).slice(0, 100)
      const itemId = `${id}-${slug(`${category}-${name}`)}`
      let item = c.items.find(x => x.id === itemId)
      if (!item) {
        item = { id: itemId, name, brand: c.short, category, step: slug(category) || 'menu', source: 'restaurant', portions: [], defaultPortion: 'p0' }
        c.items.push(item)
        fresh++
      }
      const label = String(it.portion || '1 serving').slice(0, 60)
      const portion = {
        id: `p${item.portions.length}`,
        label,
        grams: null,
        kcal: Math.round(Number(it.kcal) || 0),
        protein: numOr(it.protein), carbs: numOr(it.carbs), fat: numOr(it.fat),
        fiber: numOr(it.fiber, null), sugar: numOr(it.sugar, null), sodium: numOr(it.sodium, null),
      }
      const have = item.portions.find(p => p.label === label)
      // The same numbers under another label ("1 entrée" off a receipt, "1
      // serving" off the guide) are one portion, not two sizes of a dish.
      const same = item.portions.find(p => p.kcal === portion.kcal && p.protein === portion.protein && p.fat === portion.fat)
      if (have) Object.assign(have, { ...portion, id: have.id })
      else if (!same) item.portions.push(portion)
    }
    // Steps follow the chain's own categories, in the order they were learned,
    // one per category id.
    const cats = [...new Map(c.items.map(i => [slug(i.category) || 'menu', i.category])).entries()]
    c.steps = cats.map(([sid, label]) => ({ id: sid, label, collapsed: cats.length > 3 }))
    for (const i of c.items) i.step = slug(i.category) || 'menu'
    await save(doc)
    return fresh
  }

  return { load, add, file }
}

/* "CHEESECAKES AND DESSERTS" -> "Cheesecakes and Desserts". Small words stay small. */
function tidyCategory(raw) {
  const s = String(raw || 'Menu').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Menu'
  if (s !== s.toUpperCase()) return s[0].toUpperCase() + s.slice(1)
  return s.toLowerCase().replace(/(^|[\s&(/-])([a-z])/g, (m, a, b) => a + b.toUpperCase())
    .replace(/\b(And|Of|The|With|Or|Per|A)\b/g, w => w.toLowerCase()).replace(/^./, c => c.toUpperCase())
}

const numOr = (v, dflt = 0) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? dflt : Math.round(Number(v) * 10) / 10)

module.exports = { fetchText, htmlToText, verifyItem, verifyFound, makeLearned, slug, tidyCategory }
