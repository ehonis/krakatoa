/*
 * Krakatoa — "Ask AI": a receipt, a plate, or a sentence, turned into things to log.
 *
 * One door for everything that is not a barcode or a label: a photo of a
 * receipt, a photo of the food, or words ("2 carne asada tacos and a horchata
 * from the taqueria"). What comes back is a LIST TO REVIEW, never a log —
 * he ticks what he ate, fixes what is off, and logs it.
 *
 * THE MODEL NEVER DOES THE ARITHMETIC ON A FOOD KRAKATOA ALREADY KNOWS. Every food
 * with real numbers — his own combos, stars and recent foods, any chain
 * menus built or learned, the 299 basics — is written to a table (`foods.tsv`, one line per
 * portion, each with an id). The model searches it and answers with an id and a
 * quantity; `resolve()` computes the numbers from the table. So a Chipotle bowl
 * off a receipt is Chipotle's own figures for each scoop, and a "protein shake"
 * is his own combo, both to the calorie. Only what is NOT in the table — a taco
 * from a place that publishes nothing, a home-cooked plate — is the model's
 * estimate, and it is marked as one on screen.
 *
 * THE BOUNDARY is the label reader's: one headless `claude` run with `Read` and
 * `Grep` only, able to see its own temp directory (the photo and the table) and
 * nothing else; everything that could write, run or fetch is denied by flag, and
 * the directory is deleted before the answer goes back.
 */

const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { verifyFound, verifyItem } = require('./learned.js')

/* ------------------------------------------------------------- the table */

const r1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : 0)
const clean = (s) => String(s ?? '').replace(/[\t\n\r]+/g, ' ').trim()

function nutrientsOf(p, k = 1) {
  return {
    kcal: Math.round((Number(p.kcal) || 0) * k),
    protein: r1((Number(p.protein) || 0) * k),
    carbs: r1((Number(p.carbs) || 0) * k),
    fat: r1((Number(p.fat) || 0) * k),
  }
}

function sumComponents(components) {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0 }
  for (const c of components || []) {
    const n = nutrientsOf(c.portion || {}, Number(c.qty) || 1)
    t.kcal += n.kcal; t.protein += n.protein; t.carbs += n.carbs; t.fat += n.fat
  }
  return { kcal: Math.round(t.kcal), protein: r1(t.protein), carbs: r1(t.carbs), fat: r1(t.fat) }
}

/**
 * Every food with real numbers, one row per portion. `rows` is what the model
 * greps; `byId` is what `resolve` reads back. His own foods come first and are
 * marked `yours`, because "my shake" means his shake and not a database's.
 */
function buildIndex({ state, restaurants, basics, today = new Date().toISOString().slice(0, 10) }) {
  const rows = []
  const byId = new Map()
  // `tableLabel` is what the MODEL reads for the portion when that differs from
  // what he should see: a combo spells out what one of it holds for the model,
  // and is just "1 combo" on his screen and in his log.
  const add = (id, basis, where, food, portion, tableLabel = portion?.label) => {
    if (!portion || !Number.isFinite(Number(portion.kcal))) return
    const n = nutrientsOf(portion)
    byId.set(id, { basis, where, food, portion })
    rows.push([id, basis, clean(where), clean(food.name), clean(tableLabel), n.kcal, n.protein, n.carbs, n.fat].join('\t'))
  }

  const entries = Object.values(state?.entries || {}).filter(e => e && !e.deleted)
  for (const e of entries.filter(x => x.kind === 'combo' && x.data?.components?.length)) {
    const t = sumComponents(e.data.components)
    // The portion SAYS what one combo is. With "1 (your combo)" the model logged
    // three of his three-taco combo for three tacos — 2,637 kcal for 879.
    const inside = e.data.components.map(c => `${Number(c.qty) === 1 ? '' : `${c.qty}× `}${c.name}`).join(', ')
    add(`y:${e.id}`, 'yours', 'your combo', { name: e.data.name, source: 'combo', comboId: e.id, components: e.data.components },
      { id: 'combo', label: '1 combo', ...t }, `1 whole combo = ${inside}`.slice(0, 200))
  }
  for (const e of entries.filter(x => x.kind === 'star')) {
    const d = e.data || {}
    for (const p of d.portions || []) add(`y:${e.id}@${p.id}`, 'yours', d.brand ? `starred · ${d.brand}` : 'starred', d, p)
  }
  // What he has logged in the last 45 days, once per food — the portion he used.
  const since = new Date(Date.parse(`${today}T12:00:00Z`) - 45 * 86400e3).toISOString().slice(0, 10)
  const seen = new Set()
  // A logged combo is already in the table as the combo itself.
  for (const e of entries.filter(x => x.kind === 'food' && x.date >= since && !x.data?.components && !x.data?.comboId).sort((a, b) => b.date.localeCompare(a.date))) {
    const d = e.data || {}
    const key = `${d.name}|${d.brand || ''}`.toLowerCase()
    if (seen.has(key) || !d.portion) continue
    seen.add(key)
    add(`y:${e.id}`, 'yours', d.brand ? `you logged · ${d.brand}` : 'you logged', d, d.portion)
  }

  for (const chain of restaurants?.chains || []) {
    for (const it of chain.items || []) {
      for (const p of it.portions || []) {
        add(`m:${it.id}@${p.id}`, 'menu', `${chain.short} · ${it.category}`, { ...it, brand: chain.short, source: 'restaurant' }, p)
      }
    }
  }
  for (const f of basics?.foods || []) {
    for (const p of f.portions || []) add(`b:${f.id}@${p.id}`, 'basic', `generic · ${f.category}`, { ...f, source: 'basic' }, p)
  }

  return {
    tsv: ['id\tbasis\twhere\tname\tportion\tkcal\tprotein\tcarbs\tfat', ...rows].join('\n'),
    // His own foods, also handed to the model directly. Left to Grep for them it
    // found an "El Sol Steak Tacos" combo on two taqueria receipts in three;
    // shown them outright, it cannot miss them. They are a few dozen lines.
    yours: rows.filter(r => r.split('\t')[1] === 'yours').slice(0, 120).join('\n'),
    byId,
    size: rows.length,
    chains: (restaurants?.chains || []).map(c => ({ short: c.short, name: c.name })),
  }
}

/* ------------------------------------------------------------ the answer */

const ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'qty', 'portion', 'matchId', 'parts', 'estimate', 'eaten', 'confidence', 'note'],
  properties: {
    name: { type: 'string', description: 'what it is, in plain words ("Carne asada taco")' },
    qty: { type: 'number', description: 'how many of `portion` (0.5 for half)' },
    portion: { type: 'string', description: 'one unit, in words ("1 taco", "1 medium", "16 oz")' },
    matchId: { type: ['string', 'null'], description: 'id of the foods.tsv row this IS, or "w:N" for found[N], or null' },
    parts: {
      type: 'array',
      description: 'for a built dish (a Chipotle bowl): the foods.tsv rows it is made of, per ONE of it',
      items: {
        type: 'object', additionalProperties: false, required: ['matchId', 'qty'],
        properties: { matchId: { type: 'string' }, qty: { type: 'number' } },
      },
    },
    estimate: {
      type: ['object', 'null'],
      description: 'ONLY when there is no match: your estimate for ONE unit',
      additionalProperties: false,
      required: ['kcal', 'protein', 'carbs', 'fat'],
      properties: { kcal: { type: 'number' }, protein: { type: 'number' }, carbs: { type: 'number' }, fat: { type: 'number' } },
    },
    eaten: { type: 'boolean', description: 'false for things bought but not obviously eaten (a grocery receipt)' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    note: { type: ['string', 'null'], description: 'a few words if something was assumed ("assumed flour tortilla")' },
  },
}

const MEAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'place', 'items', 'found', 'skipped', 'question', 'reply'],
  properties: {
    found: {
      type: 'array',
      description: "items of THIS order read from a chain's OFFICIAL nutrition page on the web, exactly as printed there",
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['chain', 'sourceUrl', 'name', 'category', 'portion', 'kcal', 'protein', 'carbs', 'fat'],
        properties: {
          chain: { type: 'string' }, sourceUrl: { type: 'string', description: 'the exact page or PDF the numbers are on' },
          name: { type: 'string', description: 'the item name as the page prints it' }, category: { type: 'string' },
          portion: { type: 'string' },
          kcal: { type: 'number' }, protein: { type: ['number', 'null'] }, carbs: { type: ['number', 'null'] }, fat: { type: ['number', 'null'] },
        },
      },
    },
    kind: { type: 'string', enum: ['receipt', 'grocery', 'plate', 'words', 'label', 'unclear'] },
    place: { type: ['string', 'null'], description: 'the restaurant or shop, if known' },
    items: { type: 'array', items: ITEM },
    skipped: { type: 'array', items: { type: 'string' }, description: 'receipt lines left out and why, e.g. "Tax", "Tip", "Bag fee", "Gift card"' },
    question: { type: ['string', 'null'], description: 'ONE question whose answer would change the numbers most, or null' },
    reply: { type: 'string', description: 'one or two sentences to him: what you found and what you assumed' },
  },
}

function systemPrompt(yours = '', chains = []) {
  const menus = chains.length
    ? `chain menus (basis "menu": ${chains.map(c => c.short).join(', ')})`
    : 'no chain menus on this server (so no "menu" rows)'
  return [
    'You turn what someone ate into a list of foods for a calorie log. You get a photo',
    '(a receipt, a plate of food, a menu) and/or their words. You do not log anything;',
    'they review your list and log it themselves.',
    '',
    'THE FOOD TABLE. `foods.tsv` in your working directory has every food with real',
    'nutrition numbers: their own foods (basis "yours" — combos, starred, recently',
    `logged), ${menus}, and generic USDA foods (basis "basic"). Columns: id, basis, where, name,`,
    'portion, kcal, protein, carbs, fat. Search it with Grep (case-insensitive) for',
    'EVERY item before estimating anything. Prefer, in order: their own food > the',
    'chain\'s own menu > a generic basic > your estimate.',
    '',
    'For each item give `matchId` (the row it IS) and `qty` (how many of that row\'s',
    'portion). A built dish — a Chipotle burrito or bowl, a Bibibop bowl — is ONE item',
    'with `parts`: each part a row and a qty per one dish (a burrito: the burrito',
    'tortilla, rice, beans, protein, salsa, cheese…). Receipts from Chipotle list the',
    'toppings under the entrée; use them. If the receipt does not list them, use the',
    'usual build and say so in `note`. Double meat is qty 2 on the protein.',
    'Only when NO row fits, set matchId null, parts [], and `estimate` per ONE unit,',
    'from what you know of that food at a typical restaurant. Never put numbers in',
    '`estimate` when there is a match — the app computes matched numbers itself.',
    '',
    'SEARCHING. FIRST, if you know the restaurant or shop, Grep its name ("El Sol",',
    '"Chipotle") — their own combos are often named after the place they eat, and',
    'one of those beats anything else. Then grep one distinctive word at a time',
    '("milk", "banana", "egg",',
    '"quesadilla"), not the whole phrase: the table says "Milk, 2%", not "2% milk".',
    'A chain\'s menu row is that chain\'s food ONLY. Chips at a taqueria are not',
    'Chipotle\'s chips: for another restaurant use a generic basic, or estimate.',
    'If they have their OWN combo for this place or dish, use it — they built it for',
    'exactly this — and say in `note` how the receipt differs from it, if it does.',
    '',
    'CHAINS KRAKATOA DOES NOT KNOW YET. If the order is from a restaurant CHAIN (several',
    'locations) that is not in foods.tsv — Grep its name to be sure — look up that',
    'chain\'s OWN published nutrition: WebSearch for "<chain> nutrition" and WebFetch',
    'the chain\'s own site or nutrition PDF. Never a third-party calorie site. Use the',
    'CURRENT document: an address or title with an old year in it ("2021-10") is',
    'probably out of date — look for a newer one first. For each',
    'item of THIS order you find there, add a `found` entry with the numbers exactly',
    'as printed and the exact address of the page that shows them, and give the item',
    'matchId "w:<its index in found>". Krakatoa checks every one against that page itself',
    'and throws away anything it cannot see there, so never write a number you did',
    'not read on the page. Do not look up single-location restaurants (they publish',
    'nothing) or chains already in the table. If their site will not load or has no',
    'nutrition, estimate as usual and say so.',
    '',
    'RECEIPTS. Read every line. Leave out tax, tip, totals, fees, bags, discounts,',
    'gift cards and payment lines — list them in `skipped`. Expand abbreviations',
    '("CRN ASDA TCO" is a carne asada taco). A quantity column is qty. Modifiers',
    'printed under an item ("NO CHEESE", "XTRA GUAC") change that item.',
    'A GROCERY receipt is things bought, not eaten: kind "grocery", every item',
    'eaten false. One unit is ONE SERVING as the package label would give it (1 cup',
    'of milk, 1 slice of bread, 1 egg, 1 banana), qty 1 — never the whole package.',
    'Name it as the product ("Dave\'s Killer Bread 21 Whole Grains"), with the brand.',
    '',
    'PLATES. Estimate portions from what is visible (plate size, utensils) and say',
    'what you assumed in `note`; confidence is at most "medium" for a photo of food.',
    '',
    'LABELS. If the photo is a Nutrition Facts label, set kind "label" and return one',
    'item with the label\'s per-serving numbers as `estimate` and confidence "high".',
    '',
    'Several people\'s food on one receipt is normal: include everything, and if it',
    'looks shared, ask in `question` which were theirs. Ask at most one question, only',
    'if the answer changes the numbers a lot. `reply` is to them, plain, one or two',
    'sentences: what you found, what you assumed. Never say you logged anything —',
    'nothing is logged until they tap; say "found" or "matched". No markdown. Do not repeat the',
    '`question` inside `reply` — the screen shows it right under.',
    ...(yours ? [
      '',
      'THEIR OWN FOODS — the "yours" rows of foods.tsv, here so you cannot miss them.',
      'Check every item against these first, and use one ONLY when it is the same',
      'food — a glazed donut is not the cake donut they logged last week; for that,',
      'search foods.tsv for the exact thing. A combo named after a place or a dish',
      '("El Sol Steak Tacos") is what they eat there — use it for that order. One',
      'combo is the WHOLE thing its portion lists: three tacos ordered is qty 1 of a',
      'combo that already holds three tortillas, not qty 3.',
      yours,
    ] : []),
  ].join('\n')
}

function userPrompt({ text, hasPhoto, previous, message }) {
  const out = []
  if (hasPhoto) out.push('The photo is `photo.jpg` in your working directory. Read it.')
  if (text) out.push(`What they said:\n${text}`)
  if (previous) {
    out.push(
      'You already gave them this list, and they may have edited it since — ticks,',
      'quantities and numbers they changed are theirs, keep them. An item marked',
      '"edited" has numbers they typed: return it with matchId null, parts [] and',
      'those `per` numbers as its `estimate`, unless they ask you to change it.',
      '`eaten` false means they unticked it: keep it unticked.',
      'Items they did not mention come back EXACTLY as they were: same matchId, parts,',
      'qty and estimate. An item with `per` numbers: return those as its `estimate`',
      'unchanged. To change HOW MUCH of something, change `qty` only — `parts` are the',
      'recipe for ONE and never change for an amount ("half the chips" is qty 0.5 with',
      'the same parts, not halved parts).',
      JSON.stringify(previous),
      `They now say:\n${message}`,
      'Return the WHOLE list again, revised, and say what you changed in `reply`.',
    )
  }
  return out.join('\n\n')
}

/**
 * The chain a row belongs to, when that is NOT where he ate: Chipotle's chips
 * matched on a El Sol Taqueria receipt. Null when it is the same place, when
 * the place is unknown, or when the row is not a chain's (a basic, his combo).
 */
function proxyOf(hit, place, index) {
  const brand = String(hit.food.brand || '').toLowerCase()
  const chain = (index.chains || []).find(c => c.short.toLowerCase() === brand)
  if (!chain || !place) return null
  const at = String(place).toLowerCase()
  return at.includes(chain.short.toLowerCase().replace(/'s$/, '')) || at.includes(chain.name.toLowerCase()) ? null : chain.short
}

/**
 * The model's items with real numbers put in. A `matchId` or `parts` that
 * resolves takes the table's numbers; one that does not falls back to the
 * model's estimate and says so; an item with neither is dropped rather than
 * logged at zero.
 */
function resolve(answer, index, checks = null) {
  const items = []
  for (const raw of answer?.items || []) {
    const qty = Math.max(0, Number(raw.qty) || 1)
    const base = {
      name: clean(raw.name).slice(0, 100) || 'Something',
      qty,
      portion: clean(raw.portion).slice(0, 60) || '1 serving',
      eaten: raw.eaten !== false,
      confidence: ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'medium',
      note: raw.note ? clean(raw.note).slice(0, 160) : null,
      // Kept so a revision can send them back and stay matched rather than
      // decaying into estimates on the second turn.
      matchId: raw.matchId && index.byId.has(raw.matchId) ? raw.matchId : null,
      parts: (raw.parts || []).filter(p => index.byId.has(p.matchId)).map(p => ({ matchId: p.matchId, qty: Number(p.qty) || 1 })),
    }
    const parts = (raw.parts || []).map(p => ({ hit: index.byId.get(p.matchId), qty: Math.max(0, Number(p.qty) || 1) }))
    const partsProxy = parts.length && parts.every(p => p.hit) ? parts.map(p => proxyOf(p.hit, answer?.place, index)).find(Boolean) : null
    if (parts.length && parts.every(p => p.hit)) {
      const components = parts.map(p => ({
        name: p.hit.food.name, brand: p.hit.food.brand || null, gtin: p.hit.food.gtin || null, image: null,
        source: p.hit.food.source || 'restaurant', portion: p.hit.portion, qty: p.qty,
      }))
      const per = sumComponents(components)
      const bases = [...new Set(parts.map(p => p.hit.basis))]
      items.push(partsProxy
        ? { ...base, basis: 'estimate', where: null, per, components, note: [base.note, `built from ${partsProxy}'s menu`].filter(Boolean).join('; ') }
        : { ...base, basis: bases.length === 1 ? bases[0] : 'menu', where: parts[0].hit.where.split(' · ')[0], per, components })
      continue
    }
    const web = /^w:\d+$/.test(String(raw.matchId || '')) ? Number(raw.matchId.slice(2)) : null
    if (web !== null && answer?.found?.[web]) {
      const f = answer.found[web]
      const check = checks?.[web] || { ok: false, why: 'not checked' }
      const portion = { id: 'web', label: clean(f.portion).slice(0, 60) || base.portion, grams: null, ...nutrientsOf(f) }
      items.push(check.ok
        ? {
            ...base, basis: 'menu', where: `${clean(f.chain)} · their site`, portion: portion.label, per: nutrientsOf(f), matchId: null,
            matched: { name: clean(f.name), brand: clean(f.chain), gtin: null, source: 'restaurant', comboId: null, components: null, portion },
            sourceUrl: f.sourceUrl,
          }
        : {
            ...base, basis: 'estimate', where: null, per: nutrientsOf(f), matchId: null,
            note: [base.note, `from ${clean(f.chain)}'s site, not verified — ${check.why}`].filter(Boolean).join('; '),
          })
      continue
    }
    const hit = raw.matchId ? index.byId.get(raw.matchId) : null
    const proxy = hit && proxyOf(hit, answer?.place, index)
    if (hit && proxy) {
      // Another restaurant's number standing in for this one's: useful, and an
      // estimate, and it says whose it borrowed.
      items.push({
        ...base,
        basis: 'estimate',
        where: null,
        per: nutrientsOf(hit.portion),
        note: [base.note, `based on ${proxy}'s ${hit.food.name.toLowerCase()}`].filter(Boolean).join('; '),
      })
      continue
    }
    if (hit) {
      items.push({
        ...base,
        name: base.name,
        portion: hit.portion.label || base.portion,
        basis: hit.basis,
        where: hit.where,
        per: nutrientsOf(hit.portion),
        matched: { name: hit.food.name, brand: hit.food.brand || null, gtin: hit.food.gtin || null, source: hit.food.source || null, comboId: hit.food.comboId || null, components: hit.food.components || null, portion: hit.portion },
      })
      continue
    }
    const e = raw.estimate
    if (e && Number.isFinite(Number(e.kcal))) {
      items.push({
        ...base,
        basis: answer.kind === 'label' ? 'label' : 'estimate',
        where: null,
        per: nutrientsOf(e),
        // A match it claimed and the table does not have is an estimate now, and
        // says so rather than silently passing for a menu number.
        note: raw.matchId || parts.length ? [base.note, 'no exact match — estimated'].filter(Boolean).join('; ') : base.note,
      })
    }
  }
  return {
    kind: answer?.kind || 'unclear',
    place: answer?.place ? clean(answer.place).slice(0, 80) : null,
    items,
    skipped: (answer?.skipped || []).map(s => clean(s).slice(0, 60)).filter(Boolean).slice(0, 20),
    question: answer?.question ? clean(answer.question).slice(0, 240) : null,
    reply: clean(answer?.reply).slice(0, 500),
  }
}

/* ---------------------------------------------------------------- the run */

/**
 * One turn. `image` is an optional JPEG Buffer. `previous` + `message` make it
 * a revision of a list already given — stateless, like Bushido's planner: the
 * whole list goes up and the whole list comes back.
 */
/*
 * Medium effort, measured: on "my protein shake and a glazed donut", low effort
 * found USDA's glazed donut once in three (twice it reached for the cake donut
 * he logged last week, or estimated); medium found it three times in three.
 * The price is time — 15–20 s for a sentence, 35–60 s for a receipt.
 */
function askMeal({ bin, model, effort = 'medium', timeoutMs = 240000, index, text = '', image = null, previous = null, message = '', fetcher, env }) {
  return new Promise((resolvePromise, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krakatoa-ask-'))
    fs.writeFileSync(path.join(dir, 'foods.tsv'), index.tsv)
    if (image) fs.writeFileSync(path.join(dir, 'photo.jpg'), image)
    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* gone */ } }
    const started = Date.now()

    const child = spawn(bin, [
      '--print',
      '--model', model,
      '--effort', effort,
      '--output-format', 'json',
      '--no-session-persistence',
      '--add-dir', dir,
      // The web, to look up a chain Krakatoa does not know yet. Nothing it reads there
      // is trusted: verifyFound() fetches the page itself. It still cannot write,
      // run anything, or touch a file outside its own temp directory.
      '--allowedTools', 'Read,Grep,WebSearch,WebFetch',
      '--disallowedTools', ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Task', 'Glob'].join(','),
      '--append-system-prompt', systemPrompt(index.yours, index.chains || []),
      '--json-schema', JSON.stringify(MEAL_SCHEMA),
    ], { cwd: dir, env: env || process.env, stdio: ['pipe', 'pipe', 'pipe'] })

    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      cleanup()
      reject(new Error('That took too long — try again, or with fewer things at once.'))
    }, timeoutMs)
    child.stdout.on('data', c => { out += c })
    child.stderr.on('data', c => { err += c })
    child.on('error', (e) => { clearTimeout(timer); cleanup(); reject(new Error(`cannot run ${bin}: ${e.message}`)) })
    child.on('close', (code) => {
      clearTimeout(timer)
      cleanup()
      if (code !== 0) return reject(new Error(err.trim().split('\n').pop() || `claude exited ${code}`))
      let doc
      try { doc = JSON.parse(out) } catch { return reject(new Error('The AI did not answer properly — try again.')) }
      let raw = doc.structured_output
      if (!raw) { try { raw = JSON.parse(String(doc.result)) } catch { raw = null } }
      if (!raw) return reject(new Error('The AI returned nothing usable — try again.'))
      // What it says it read on the web, checked against the page by Krakatoa.
      verifyFound(raw.found || [], { fetcher })
        .then(({ checks, pages }) => {
          const learn = []
          for (const [i, f] of (raw.found || []).entries()) {
            if (!checks[i].ok) continue
            let group = learn.find(g => g.chain === clean(f.chain) && g.url === f.sourceUrl)
            if (!group) { group = { chain: clean(f.chain), url: f.sourceUrl, items: [], text: pages.get(f.sourceUrl)?.text || '', docDate: pages.get(f.sourceUrl)?.date || null }; learn.push(group) }
            group.items.push({ name: clean(f.name), category: clean(f.category) || 'Menu', portion: clean(f.portion) || '1 serving', kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat })
          }
          resolvePromise({
            ...resolve(raw, index, checks),
            model: doc.model || model, ms: Date.now() - started, cost: doc.total_cost_usd ?? null,
            // For the server to save and to read in full; never stored on the thread.
            _learn: learn,
          })
        })
        .catch(e => reject(e))
    })
    child.stdin.end(userPrompt({ text, hasPhoto: !!image, previous, message }))
  })
}

/* ------------------------------------------------------ a whole menu */

const MENU_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'category', 'portion', 'kcal', 'protein', 'carbs', 'fat'],
        properties: {
          name: { type: 'string' }, category: { type: 'string' }, portion: { type: 'string' },
          kcal: { type: 'number' }, protein: { type: ['number', 'null'] }, carbs: { type: ['number', 'null'] }, fat: { type: ['number', 'null'] },
        },
      },
    },
  },
}

/* ------------------------------------------- a menu that is a table */

const NUMCELL = String.raw`(?:\d{1,4}(?:\.\d+)?|<\s?1|-)`
const ROW = new RegExp(String.raw`^\s*([A-Za-z&'"(][^\n]{1,90}?)\s{2,}(${NUMCELL}(?:\s+${NUMCELL}){4,})\s*$`)

/**
 * A nutrition guide laid out as a table — one row per item, a column per
 * nutrient, as nearly every chain's PDF is (the Cheesecake Factory's has 11).
 * The rows are read by Krakatoa itself, so every number comes off the page and not
 * out of a model; the model is only asked which column is which, from the
 * header and a few rows. Returns null when the page is not a table.
 */
async function tableMenu({ bin, model, chain, text, timeoutMs = 90000, env }) {
  const lines = text.split('\n')
  const hits = []
  let section = 'Menu'
  for (const [i, line] of lines.entries()) {
    const m = line.match(ROW)
    if (m) {
      hits.push({ i, name: m[1].replace(/\s+/g, ' ').trim(), cells: m[2].trim().split(/\s+/), section })
      continue
    }
    const t = line.trim()
    // A heading: short, words only, not a column header.
    if (t && t.length < 50 && !/\d/.test(t) && !/calorie|protein|carbohydrate|carbs|sodium|sugars?|fiber|fibre|choles|satur|trans\b|fat\b|\(g\)|\(mg\)/i.test(t) && /[a-z]/i.test(t)) section = t.replace(/\s+/g, ' ')
  }
  if (hits.length < 25) return null
  // The usual row width; stragglers (a footnote with numbers) are not items.
  const widths = {}
  for (const h of hits) widths[h.cells.length] = (widths[h.cells.length] || 0) + 1
  const width = Number(Object.entries(widths).sort((a, b) => b[1] - a[1])[0][0])
  // "Tropical Mimosa (PR)", "Peach Bellini (UT)": another state's version of the
  // row above it, for a state's own liquor or labelling law. Not his.
  const rows = hits.filter(h => h.cells.length === width && !/\((?:[A-Z]{2}|[A-Z]{2}\/[A-Z]{2})\)$/.test(h.name) && !/\((?:[A-Z]{2})\)$/.test(h.section))
  if (rows.length < 25) return null

  const first = rows[0].i
  const sample = lines.slice(Math.max(0, first - 18), first + 4).join('\n')
  const COLMAP = {
    type: 'object', additionalProperties: false,
    required: ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium'],
    properties: Object.fromEntries(['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium'].map(k => [k, { type: ['integer', 'null'] }])),
  }
  const map = await new Promise((resolve, reject) => {
    const child = spawn(bin, [
      '--print', '--model', model, '--effort', 'low', '--output-format', 'json', '--no-session-persistence',
      '--tools', '', '--json-schema', JSON.stringify(COLMAP),
    ], { env: env || process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('column mapping timed out')) }, timeoutMs)
    child.stdout.on('data', c => { out += c })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', () => {
      clearTimeout(timer)
      try { const d = JSON.parse(out); resolve(d.structured_output || JSON.parse(String(d.result))) } catch { reject(new Error('column mapping unreadable')) }
    })
    child.stdin.end([
      `This is the top of ${chain}'s nutrition table, as text. Each item row has ${width} numbers after its name.`,
      'Say which of those numbers (0-based, counting only the numbers) is calories, protein (g), total carbohydrate (g),',
      'total fat (g), dietary fiber (g), total sugars (g) and sodium (mg). null for any column the table does not have.',
      'Careful: "calories from fat" is not calories, and saturated or trans fat is not total fat.',
      '', sample,
    ].join('\n'))
  })
  if (!Number.isInteger(map?.kcal)) return null

  const cell = (h, k) => {
    const j = map[k]
    if (!Number.isInteger(j) || j < 0 || j >= width) return null
    const c = h.cells[j]
    return c === '-' ? null : /^<\s?1$/.test(c) ? 0.5 : Number(c)
  }
  const items = rows.map(h => ({
    name: h.name, category: h.section.slice(0, 40), portion: '1 serving',
    kcal: cell(h, 'kcal'), protein: cell(h, 'protein'), carbs: cell(h, 'carbs'), fat: cell(h, 'fat'),
    fiber: cell(h, 'fiber'), sugar: cell(h, 'sugar'), sodium: cell(h, 'sodium'),
  })).filter(it => Number.isFinite(it.kcal))
  // The mapping is the one thing a model decided here, so it is checked the way
  // the label reader checks a panel: calories against 4/4/9 of the macros. A
  // table whose rows mostly disagree was mapped wrong, and none of it is kept.
  const off = items.filter(it => it.kcal >= 80 && Math.abs(it.kcal - (4 * (it.protein || 0) + 4 * (it.carbs || 0) + 9 * (it.fat || 0))) > Math.max(60, it.kcal * 0.25))
  if (off.length > items.length * 0.2) return { items: [], offered: items.length, why: `${off.length} of ${items.length} rows disagree with their own macros — columns misread` }
  return { items, offered: items.length }
}

/**
 * The rest of a chain's menu, from the nutrition page Krakatoa already fetched and
 * verified items on. The model reads the page's TEXT (Krakatoa's own copy, not the
 * web) and lists every item; every one is then checked against that same text
 * the way a receipt's were, and only those that check out are returned.
 */
async function learnMenu({ bin, model, chain, text, effort = 'low', limit = 1200, env }) {
  const table = await tableMenu({ bin, model, chain, text, env }).catch(() => null)
  if (table && table.items.length) return { ...table, items: table.items.slice(0, limit), how: 'table' }
  // Not a table: the model reads it, a chunk at a time, three at once — one
  // pass over 167 KB ran past five minutes. Every item is checked afterwards.
  const chunks = []
  const lines = text.split('\n')
  let cur = []
  let size = 0
  for (const l of lines) {
    cur.push(l); size += l.length + 1
    if (size > 30000) { chunks.push(cur.join('\n')); cur = []; size = 0 }
  }
  if (cur.length) chunks.push(cur.join('\n'))
  const out = []
  let offered = 0
  for (let i = 0; i < chunks.length; i += 3) {
    const got = await Promise.all(chunks.slice(i, i + 3).map(c => learnChunk({ bin, model, chain, text: c, effort, env }).catch(() => ({ items: [], offered: 0 }))))
    for (const g of got) { out.push(...g.items); offered += g.offered }
  }
  const seen = new Set()
  const items = out.filter(it => { const k = `${it.category}|${it.name}|${it.portion}`.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true })
  return { items: items.slice(0, limit), offered, how: 'read' }
}

function learnChunk({ bin, model, chain, text, effort = 'low', timeoutMs = 240000, limit = 300, env }) {
  return new Promise((resolvePromise, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krakatoa-menu-'))
    fs.writeFileSync(path.join(dir, 'nutrition.txt'), text)
    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* gone */ } }
    const child = spawn(bin, [
      '--print', '--model', model, '--effort', effort, '--output-format', 'json', '--no-session-persistence',
      '--add-dir', dir,
      '--allowedTools', 'Read,Grep',
      '--disallowedTools', ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Task', 'WebSearch', 'WebFetch', 'Glob'].join(','),
      '--json-schema', JSON.stringify(MENU_SCHEMA),
    ], { cwd: dir, env: env || process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); cleanup(); reject(new Error('reading the whole menu took too long')) }, timeoutMs)
    child.stdout.on('data', c => { out += c })
    child.stderr.on('data', c => { err += c })
    child.on('error', (e) => { clearTimeout(timer); cleanup(); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      cleanup()
      if (code !== 0) return reject(new Error(err.trim().split('\n').pop() || `claude exited ${code}`))
      let raw = null
      try { const doc = JSON.parse(out); raw = doc.structured_output || JSON.parse(String(doc.result)) } catch { raw = null }
      const items = (raw?.items || []).slice(0, limit).map(it => ({
        name: clean(it.name).slice(0, 100), category: clean(it.category).slice(0, 40) || 'Menu', portion: clean(it.portion).slice(0, 60) || '1 serving',
        kcal: it.kcal, protein: it.protein, carbs: it.carbs, fat: it.fat,
      })).filter(it => it.name && verifyItem(text, it))
      resolvePromise({ items, offered: raw?.items?.length || 0 })
    })
    child.stdin.end([
      `nutrition.txt in your working directory is ${chain}'s own published nutrition information, as text.`,
      'List EVERY menu item it gives calories for: the name as printed, its section as `category`,',
      'the serving or size as `portion` (one entry per size where it lists several), and calories,',
      'protein, carbs and fat exactly as printed (null where not printed). Copy numbers; never compute',
      'or estimate one. Leave out anything that is not a dish or drink he could order (headings,',
      'allergen notes, per-ingredient add-ons without calories).',
    ].join('\n'))
  })
}

module.exports = {
  learnMenu, tableMenu, MENU_SCHEMA, buildIndex, resolve, askMeal, MEAL_SCHEMA, systemPrompt, userPrompt, sumComponents }
