/*
 * Krakatoa — the MCP server. Krakatoa, driven by an AI, without the UI.
 *
 * The goal: an assistant can do anything the UI does, so "log my usual
 * breakfast" or "I had two BLTs" works from a chat, using the owner's own
 * combos and the menus by their real numbers.
 *
 * Served at POST /mcp as MCP Streamable HTTP (plain JSON responses), and usable from
 * any MCP client that speaks HTTP (with a bearer token unless sign-in is left
 * to a proxy). A gateway that namespaces tools shows them as
 * `krakatoa__<name>`, which is why the names carry no prefix of their own.
 *
 * Every write goes through the same `commit()` the phone's sync uses, with the
 * same entry shapes the phone writes, so an entry logged from a Totem chat is
 * indistinguishable from one logged by a tap — and the phone picks it up the
 * next time it comes to the foreground.
 *
 * THE FOOD REFERENCE. Search and the saved lists hand back a `ref` per portion —
 * `y:combo-…` (his combo), `y:star-…@p0` (a starred food), `y:food-…` (something
 * he logged), `m:<item>@<portion>` (a chain menu), `b:<basic>@<portion>` (a USDA
 * basic). Logging by ref uses Krakatoa's own numbers. Anything with no ref is logged
 * as the caller's ESTIMATE, `source: 'ai'`, and the app shows it as one.
 */

const crypto = require('crypto')

const PROTOCOL = '2025-06-18'
const MEALS = ['breakfast', 'lunch', 'dinner', 'snack']

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
const EDIT = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
const WEB = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }

const S = { type: 'string' }
const N = { type: 'number' }
const DATE = { type: 'string', description: 'YYYY-MM-DD, the user\'s local date. Defaults to today.' }
const MEAL = { type: 'string', enum: MEALS }
const PORTION = {
  type: 'object',
  description: 'One unit of the food, with its numbers for ONE unit.',
  properties: {
    label: { type: 'string', description: 'e.g. "1 sandwich", "1 cup", "16 oz"' },
    kcal: N, protein: N, carbs: N, fat: N, fiber: N, sugar: N, sodium: { type: 'number', description: 'mg' }, grams: N,
  },
  required: ['label', 'kcal'],
}
const FOOD = {
  type: 'object',
  properties: { name: S, brand: S, gtin: { type: 'string', description: 'barcode, if known' } },
  required: ['name'],
}
const LOG_ITEM = {
  type: 'object',
  description: 'Either a `ref` from search_foods / list_saved (Krakatoa\'s own numbers), or `food` + `portion` (your estimate).',
  properties: {
    ref: { type: 'string' },
    portionId: { type: 'string', description: 'which portion of a ref\'d food, when the ref has none' },
    qty: { type: 'number', description: 'how many of the portion (0.5 for half). Default 1.' },
    food: FOOD,
    portion: PORTION,
    meal: MEAL,
    note: S,
  },
}

const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10
const isoToday = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/* Same clock as the phone's mealNow(): before 10:30 breakfast, 15:00 lunch, 21:00 dinner. */
function mealNow() {
  const d = new Date()
  const h = d.getHours() + d.getMinutes() / 60
  return h < 10.5 ? 'breakfast' : h < 15 ? 'lunch' : h < 21 ? 'dinner' : 'snack'
}
function amountOf(portion, qty) {
  const q = Number.isFinite(qty) && qty > 0 ? qty : 1
  return {
    kcal: Number.isFinite(Number(portion?.kcal)) ? Math.round(Number(portion.kcal) * q) : 0,
    protein: r1((Number(portion?.protein) || 0) * q),
    carbs: r1((Number(portion?.carbs) || 0) * q),
    fat: r1((Number(portion?.fat) || 0) * q),
  }
}
function foodKey(food) {
  if (food.gtin) return `g:${food.gtin}`
  if (food.comboId) return `c:${food.comboId}`
  return `n:${String(food.name || '').trim().toLowerCase()}|${String(food.brand || '').trim().toLowerCase()}`
}
const newFoodId = (date) => `food-${date}-${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`
const cleanPortion = (p, id = 'mcp') => ({
  id: p.id || id,
  label: String(p.label || '1 serving').slice(0, 80),
  grams: Number.isFinite(Number(p.grams)) ? Number(p.grams) : null,
  kcal: Math.round(Number(p.kcal) || 0),
  protein: r1(p.protein), carbs: r1(p.carbs), fat: r1(p.fat),
  ...(p.fiber != null ? { fiber: r1(p.fiber) } : {}),
  ...(p.sugar != null ? { sugar: r1(p.sugar) } : {}),
  ...(p.sodium != null ? { sodium: Math.round(Number(p.sodium) || 0) } : {}),
})
const shortPortion = (p) => ({ id: p.id, label: p.label, kcal: p.kcal, protein: p.protein, carbs: p.carbs, fat: p.fat })
const wordsOf = (q) => String(q || '').toLowerCase().split(/[^a-z0-9%']+/).filter(w => w.length > 1)

function makeMcp(ctx) {
  /* --------------------------------------------------------- the table */

  async function table() {
    return ctx.buildIndex({ state: await ctx.readState(), restaurants: await ctx.restaurants(), basics: await ctx.basics() })
  }

  /** A ref, as the food and portion it stands for. Accepts a ref with or without its @portion. */
  function resolveRef(index, ref, portionId) {
    let hit = index.byId.get(ref)
    if (!hit) {
      const keys = [...index.byId.keys()].filter(k => k.startsWith(`${ref}@`))
      const pick = keys.find(k => k === `${ref}@${portionId}`) || keys.find(k => k.endsWith(`@${index.byId.get(keys[0])?.food?.defaultPortion}`)) || keys[0]
      hit = pick ? index.byId.get(pick) : null
    }
    if (!hit) return null
    const f = hit.food
    const food = {
      name: f.name, brand: f.brand || null, gtin: f.gtin || null, image: f.image || null,
      source: f.source === 'combo' ? 'combo' : f.source || (hit.basis === 'basic' ? 'basic' : hit.basis === 'menu' ? 'restaurant' : 'manual'),
      comboId: f.comboId || null,
      components: f.source === 'combo' ? f.components || null : null,
    }
    return { food, portion: hit.portion, basis: hit.basis, where: hit.where }
  }

  /** Grouped search over Krakatoa's own table: his foods first, then menus, then basics. */
  function searchTable(index, query, { include, limit }) {
    const words = wordsOf(query)
    if (!words.length) return []
    const groups = new Map()
    for (const [id, hit] of index.byId) {
      if (!include.includes(hit.basis === 'yours' ? 'yours' : hit.basis === 'menu' ? 'menus' : 'basics')) continue
      const name = String(hit.food.name || '').toLowerCase()
      const hay = `${name} ${String(hit.where || '').toLowerCase()} ${String(hit.food.brand || '').toLowerCase()} ${String(hit.food.usdaName || '').toLowerCase()}`
      if (!words.every(w => hay.includes(w))) continue
      const base = id.includes('@') ? id.slice(0, id.lastIndexOf('@')) : id
      if (!groups.has(base)) {
        let score = { yours: 300, menu: 100, basic: 150 }[hit.basis] || 0
        for (const w of words) score += name.startsWith(w) ? 40 : name.includes(` ${w}`) ? 20 : 5
        // The thing itself over things named after it: "Coffee, brewed" before
        // "Coffee cake" for "coffee".
        if (words.length === 1 && (name === words[0] || name.startsWith(`${words[0]},`) || name === `${words[0]}s`)) score += 60
        groups.set(base, { ref: base, name: hit.food.name, brand: hit.food.brand || null, basis: hit.basis, where: hit.where, score: score - name.length / 10, portions: [] })
      }
      groups.get(base).portions.push({ ref: id, ...shortPortion(hit.portion) })
    }
    return [...groups.values()].sort((a, b) => b.score - a.score).slice(0, limit).map(({ score, ...g }) => g)
  }

  /* --------------------------------------------------------- writing */

  async function writeEntries(entries) {
    const stamped = {}
    const at = new Date().toISOString()
    for (const e of entries) stamped[e.id] = { ...e, updatedAt: at }
    await ctx.withState(doc => ctx.commit(doc, stamped))
  }

  function foodEntry({ food, portion, qty, meal, date, note }) {
    const day = date || isoToday()
    return {
      id: newFoodId(day),
      kind: 'food',
      date: day,
      data: {
        at: new Date().toISOString(),
        name: String(food.name).slice(0, 120),
        brand: food.brand || null,
        gtin: food.gtin || null,
        source: food.source || 'ai',
        image: food.image || null,
        imageGtin: null,
        meal: MEALS.includes(meal) ? meal : mealNow(),
        qty,
        portion,
        note: note ? String(note).slice(0, 300) : null,
        comboId: food.comboId || null,
        components: food.source === 'combo' ? food.components || null : null,
        via: 'mcp',
        ...amountOf(portion, qty),
      },
    }
  }

  /** One log item (ref or estimate) as {food, portion, qty}, or an error sentence. */
  function itemToLog(index, it) {
    const qty = Number(it.qty) > 0 ? Number(it.qty) : 1
    if (it.ref) {
      const hit = resolveRef(index, it.ref, it.portionId)
      if (!hit) return { error: `no food with ref "${it.ref}" — search again with search_foods` }
      return { food: hit.food, portion: hit.portion, qty, basis: hit.basis }
    }
    if (it.food?.name && it.portion && Number.isFinite(Number(it.portion.kcal))) {
      return {
        food: { name: it.food.name, brand: it.food.brand || null, gtin: it.food.gtin || null, source: it.food.source || 'ai' },
        portion: cleanPortion(it.portion),
        qty,
        basis: 'estimate',
      }
    }
    return { error: 'an item needs either a ref, or a food with a name and a portion with kcal' }
  }

  async function dayView(date) {
    const state = await ctx.readState()
    const day = ctx.digest.dayDigest(state, date)
    const balance = ctx.balanceFor(date, day.total.kcal)
    const meals = {}
    for (const [meal, list] of Object.entries(day.byMeal)) {
      meals[meal] = list.map(it => ({
        id: it.id, name: it.name, brand: it.brand || null, qty: it.qty, portion: it.portion?.label,
        kcal: it.kcal, protein: it.protein, carbs: it.carbs, fat: it.fat, source: it.source,
      }))
    }
    return { date, total: day.total, target: day.target, remaining: day.remaining, count: day.count, waterOz: day.waterOz, meals, balance }
  }

  /* --------------------------------------------------------- the tools */

  const tools = [
    {
      name: 'get_day',
      title: 'Read a day in Krakatoa',
      description: 'What the user ate on a day, by meal, with totals, the user\'s targets, what is left, water, and the WHOOP burn balance when WHOOP has it. Every entry has an id for edit_entry / delete_entry.',
      inputSchema: { type: 'object', properties: { date: DATE }, additionalProperties: false },
      annotations: READ,
      run: async ({ date }) => dayView(date || isoToday()),
    },
    {
      name: 'get_history',
      title: 'Read recent days',
      description: 'A run of recent days: each day\'s total and count, the average over days the user logged, the user\'s targets, and today in full.',
      inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 90, description: 'default 14' } }, additionalProperties: false },
      annotations: READ,
      run: async ({ days = 14 }) => ctx.digest.digest(await ctx.readState(), { today: isoToday(), days, whoop: ctx.whoop() }),
    },
    {
      name: 'search_foods',
      title: 'Search foods',
      description: 'Find foods to log. Searches, in order: the user\'s own foods (combos, starred, recently logged — "yours"), any chain restaurant menus this server has, built or learned ("menus"; get_menu lists them, and there may be none), and ~300 generic USDA foods ("basics"); optionally the Open Food Facts + USDA databases ("databases", slower, network). Each result has a `ref` per portion to pass to log_food. Search ONE food at a time with a short query ("eggs", "coffee", "big mac"), not a whole meal.',
      inputSchema: {
        type: 'object',
        properties: {
          query: S,
          include: { type: 'array', items: { type: 'string', enum: ['yours', 'menus', 'basics', 'databases'] }, description: 'default yours, menus, basics' },
          limit: { type: 'integer', minimum: 1, maximum: 25 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: WEB,
      run: async ({ query, include = ['yours', 'menus', 'basics'], limit = 8 }) => {
        const index = await table()
        const results = searchTable(index, query, { include, limit })
        let databases = []
        if (include.includes('databases')) {
          const r = await ctx.searchDatabases(query)
          databases = (r.foods || []).slice(0, limit).map(f => ({
            name: f.name, brand: f.brand || null, gtin: f.gtin || null, source: f.source,
            portions: (f.portions || []).slice(0, 4).map(shortPortion),
            logWith: 'pass { food: {name, brand, gtin}, portion: <one of portions> } to log_food',
          }))
        }
        return { query, results, databases }
      },
    },
    {
      name: 'list_saved',
      title: 'List the user\'s saved foods',
      description: 'The user\'s combos (saved meals like "Scrambled eggs", "Protein shake", "Homemade Iced Latte"), starred foods, or recently eaten foods, each with a ref to log it. Check this first when the user says "my usual", "my shake", "my breakfast".',
      inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['combos', 'starred', 'recent', 'all'] }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
      annotations: READ,
      run: async ({ kind = 'all', limit = 40 }) => {
        const index = await table()
        const out = { combos: [], starred: [], recent: [] }
        for (const [id, hit] of index.byId) {
          if (hit.basis !== 'yours') continue
          const bucket = id.startsWith('y:combo') ? 'combos' : id.startsWith('y:star') ? 'starred' : 'recent'
          if (kind !== 'all' && kind !== bucket) continue
          if (out[bucket].length >= limit) continue
          const row = { ref: id, name: hit.food.name, brand: hit.food.brand || null, portion: shortPortion(hit.portion) }
          if (bucket === 'combos') row.contains = (hit.food.components || []).map(c => `${c.qty} × ${c.name} (${c.portion?.label})`)
          out[bucket].push(row)
        }
        return kind === 'all' ? out : { [kind]: out[kind] }
      },
    },
    {
      name: 'log_food',
      title: 'Log food',
      description: 'Log one or several foods to the user\'s day. For each item pass a `ref` from search_foods / list_saved (Krakatoa\'s own numbers — always prefer this), or, only when nothing matches, `food` + `portion` with YOUR estimate per one unit (logged as an AI estimate). "Two BLTs" = one item, qty 2, portion "1 sandwich". A combo ref logs the whole combo. Returns the new entries and the day\'s totals after.',
      inputSchema: {
        type: 'object',
        properties: { items: { type: 'array', items: LOG_ITEM, minItems: 1 }, meal: MEAL, date: DATE },
        required: ['items'],
        additionalProperties: false,
      },
      annotations: WRITE,
      run: async ({ items, meal, date }) => {
        const index = await table()
        const day = date || isoToday()
        const resolved = items.map(it => itemToLog(index, it))
        const bad = resolved.map((r, i) => (r.error ? `item ${i + 1}: ${r.error}` : null)).filter(Boolean)
        if (bad.length) throw new Error(bad.join('; '))
        const entries = resolved.map((r, i) => foodEntry({ ...r, meal: items[i].meal || meal, date: day, note: items[i].note }))
        await writeEntries(entries)
        return {
          logged: entries.map((e, i) => ({ id: e.id, name: e.data.name, qty: e.data.qty, portion: e.data.portion.label, meal: e.data.meal, kcal: e.data.kcal, protein: e.data.protein, carbs: e.data.carbs, fat: e.data.fat, basis: resolved[i].basis })),
          day: (await dayView(day)).total,
        }
      },
    },
    {
      name: 'ask',
      title: 'Work out a meal (Ask AI)',
      description: 'Hand Krakatoa\'s own meal reader a description ("3 carne asada tacos and a horchata from El Sol", "chipotle chicken burrito with guac") and get back its list: matched to the user\'s combos, the chain menus and USDA where it can, and — for a chain Krakatoa does not know — looked up on the chain\'s own nutrition page and checked by Krakatoa (then saved as a menu). Takes 15–60 s. With log: true it logs the eaten items too. The conversation appears in the app\'s Ask AI list.',
      inputSchema: {
        type: 'object',
        properties: { text: S, log: { type: 'boolean', description: 'log the eaten items as well (default false: return them for review)' }, meal: MEAL, date: DATE },
        required: ['text'],
        additionalProperties: false,
      },
      annotations: { ...WRITE, openWorldHint: true },
      run: async ({ text, log = false, meal, date }) => {
        const thread = await ctx.askAndWait(text)
        const answer = [...thread.turns].reverse().find(x => x.role === 'ai')?.answer
        if (thread.status !== 'ready' || !answer) throw new Error(thread.error || 'Ask AI did not finish — try list_ask_threads later')
        const items = answer.items.map(it => ({
          name: it.name, qty: it.qty, portion: it.portion, eaten: it.eaten, basis: it.basis, where: it.where || null,
          kcal: Math.round((it.per?.kcal || 0) * it.qty), per: it.per, note: it.note || null,
        }))
        let logged = null
        if (log) {
          const eaten = answer.items.filter(it => it.eaten !== false)
          const entries = eaten.map(it => {
            const m = it.matched
            const portion = m ? m.portion : cleanPortion({ label: it.portion, ...it.per }, 'ai')
            const food = it.components?.length
              ? { name: it.name, brand: answer.place || null, source: 'combo', components: it.components }
              : m ? { name: it.name, brand: m.brand || answer.place || null, gtin: m.gtin || null, source: m.source === 'combo' ? 'combo' : m.source || 'restaurant', comboId: m.comboId || null, components: m.components || null }
                : { name: it.name, brand: answer.place || null, source: 'ai' }
            return foodEntry({ food, portion, qty: it.qty, meal, date: date || isoToday() })
          })
          await writeEntries(entries)
          await ctx.markLogged(thread.id)
          logged = { count: entries.length, ids: entries.map(e => e.id), day: (await dayView(date || isoToday())).total }
        }
        return { threadId: thread.id, kind: answer.kind, place: answer.place, reply: answer.reply, question: answer.question, items, skipped: answer.skipped, learned: answer.learned || [], logged }
      },
    },
    {
      name: 'edit_entry',
      title: 'Change a logged food',
      description: 'Change a logged entry: its quantity, meal, date, or the portion\'s numbers. Get ids from get_day.',
      inputSchema: {
        type: 'object',
        properties: { id: S, qty: N, meal: MEAL, date: DATE, portion: PORTION, name: S },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: EDIT,
      run: async ({ id, qty, meal, date, portion, name }) => {
        const state = await ctx.readState()
        const have = state.entries?.[id]
        if (!have || have.deleted || have.kind !== 'food') throw new Error(`no logged food with id ${id}`)
        const data = { ...have.data }
        if (qty !== undefined) data.qty = Number(qty) > 0 ? Number(qty) : data.qty
        if (meal) data.meal = meal
        if (name) data.name = String(name).slice(0, 120)
        if (portion) { data.portion = cleanPortion({ ...data.portion, ...portion }); data.source = data.source === 'ai' ? 'ai' : data.source }
        Object.assign(data, amountOf(data.portion, data.qty))
        await writeEntries([{ ...have, date: date || have.date, data }])
        return { id, name: data.name, qty: data.qty, meal: data.meal, date: date || have.date, kcal: data.kcal }
      },
    },
    {
      name: 'delete_entry',
      title: 'Delete a logged food',
      description: 'Remove a logged entry from the user\'s day (kept as a tombstone so every device agrees). Ask the user before deleting anything the user did not ask to remove.',
      inputSchema: { type: 'object', properties: { id: S }, required: ['id'], additionalProperties: false },
      annotations: EDIT,
      run: async ({ id }) => {
        const state = await ctx.readState()
        const have = state.entries?.[id]
        if (!have || have.deleted) throw new Error(`no entry with id ${id}`)
        await writeEntries([{ ...have, deleted: true }])
        return { deleted: id, name: have.data?.name || null }
      },
    },
    {
      name: 'save_food',
      title: 'Save a food',
      description: 'Save a food the user will eat again (from its label, or a homemade thing) as one of the user\'s starred foods, with one or more portions. With a barcode it is also remembered under that barcode, so scanning it finds it. Returns its ref.',
      inputSchema: {
        type: 'object',
        properties: { name: S, brand: S, gtin: S, portions: { type: 'array', items: PORTION, minItems: 1 } },
        required: ['name', 'portions'],
        additionalProperties: false,
      },
      annotations: WRITE,
      run: async ({ name, brand, gtin, portions }) => {
        const clean = portions.map((p, i) => cleanPortion(p, `p${i}`))
        const food = { name: String(name).slice(0, 120), brand: brand || null, gtin: ctx.normalizeGtin(gtin) || null, source: 'label' }
        const key = foodKey(food)
        await writeEntries([{
          id: `star-${key}`, kind: 'star', date: null,
          data: { key, ...food, image: null, usdaName: null, portions: clean, starredAt: new Date().toISOString() },
        }])
        if (food.gtin) await ctx.cacheFood({ ...food, image: null, portions: clean })
        return { ref: `y:star-${key}`, name: food.name, portions: clean.map(shortPortion) }
      },
    },
    {
      name: 'save_combo',
      title: 'Save a combo',
      description: 'Save a combo — several foods the user has together, like "scrambled eggs (4 eggs, 1 tbsp butter, a splash of milk)" or "protein shake" — so it logs in one go. Components are refs (preferred) or food+portion estimates, each with qty. Pass id to update an existing combo.',
      inputSchema: {
        type: 'object',
        properties: { name: S, id: S, components: { type: 'array', items: LOG_ITEM, minItems: 1 } },
        required: ['name', 'components'],
        additionalProperties: false,
      },
      annotations: WRITE,
      run: async ({ name, id, components }) => {
        const index = await table()
        const resolved = components.map(c => itemToLog(index, c))
        const bad = resolved.map((r, i) => (r.error ? `component ${i + 1}: ${r.error}` : null)).filter(Boolean)
        if (bad.length) throw new Error(bad.join('; '))
        const comboId = id || `combo-${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`
        const comps = resolved.map(r => ({ name: r.food.name, brand: r.food.brand || null, gtin: r.food.gtin || null, image: null, source: r.food.source, portion: r.portion, qty: r.qty }))
        await writeEntries([{ id: comboId, kind: 'combo', date: null, data: { name: String(name).slice(0, 80), components: comps, meal: null, createdAt: new Date().toISOString() } }])
        const total = comps.reduce((t, c) => { const a = amountOf(c.portion, c.qty); return { kcal: t.kcal + a.kcal, protein: r1(t.protein + a.protein), carbs: r1(t.carbs + a.carbs), fat: r1(t.fat + a.fat) } }, { kcal: 0, protein: 0, carbs: 0, fat: 0 })
        return { ref: `y:${comboId}`, id: comboId, name, total }
      },
    },
    {
      name: 'delete_combo',
      title: 'Delete a combo',
      description: 'Delete one of the user\'s combos. Anything already logged from it stays logged. Ask the user first.',
      inputSchema: { type: 'object', properties: { id: S }, required: ['id'], additionalProperties: false },
      annotations: EDIT,
      run: async ({ id }) => {
        const state = await ctx.readState()
        const have = state.entries?.[id.replace(/^y:/, '')]
        if (!have || have.kind !== 'combo' || have.deleted) throw new Error(`no combo with id ${id}`)
        await writeEntries([{ ...have, deleted: true }])
        return { deleted: have.id, name: have.data?.name }
      },
    },
    {
      name: 'add_water',
      title: 'Log water / liquids',
      description: 'Add water or other liquids to a day, in fluid ounces (negative to take some off). 500 mL is about 17 oz.',
      inputSchema: { type: 'object', properties: { oz: N, date: DATE }, required: ['oz'], additionalProperties: false },
      annotations: WRITE,
      run: async ({ oz, date }) => {
        const day = date || isoToday()
        const state = await ctx.readState()
        const have = state.entries?.[`water-${day}`]
        const next = Math.max(0, Math.round((Number(have?.data?.oz) || 0) + Number(oz)))
        await writeEntries([{ id: `water-${day}`, kind: 'water', date: day, data: { oz: next, at: new Date().toISOString() } }])
        return { date: day, waterOz: next, target: ctx.digest.targetsOf(state).water }
      },
    },
    {
      name: 'set_targets',
      title: 'Set daily targets',
      description: 'Set the user\'s daily targets: kcal, protein/carbs/fat in grams, water in oz. Only the ones given change.',
      inputSchema: { type: 'object', properties: { kcal: N, protein: N, carbs: N, fat: N, water: N }, additionalProperties: false },
      annotations: EDIT,
      run: async (patch) => {
        const state = await ctx.readState()
        const data = { ...(state.entries?.targets?.data || {}), ...patch }
        await writeEntries([{ id: 'targets', kind: 'settings', date: null, data }])
        return { targets: ctx.digest.targetsOf({ entries: { targets: { data } } }) }
      },
    },
    {
      name: 'lookup_barcode',
      title: 'Look up a barcode',
      description: 'A barcode (UPC/EAN) to a food, from the user\'s saved foods, Open Food Facts and USDA. Log it with food + one of its portions.',
      inputSchema: { type: 'object', properties: { code: S }, required: ['code'], additionalProperties: false },
      annotations: WEB,
      run: async ({ code }) => {
        const r = await ctx.lookupBarcode(code)
        return r.food ? { found: true, food: { name: r.food.name, brand: r.food.brand, gtin: r.food.gtin, source: r.food.source, portions: r.food.portions.map(shortPortion) } } : { found: false, reason: r.reason }
      },
    },
    {
      name: 'get_menu',
      title: 'Read a restaurant menu',
      description: 'With no chain: the chains Krakatoa has menus for. With a chain: its items by category, each portion with a ref to log. Use search_foods to find one item; this is for browsing.',
      inputSchema: { type: 'object', properties: { chain: { type: 'string', description: 'a chain name as listed by get_menu with no chain' }, category: S }, additionalProperties: false },
      annotations: READ,
      run: async ({ chain, category }) => {
        const doc = await ctx.restaurants()
        if (!chain && !doc.chains.length) return { chains: [], note: 'No chain menus on this server. They are optional and built by the owner; Ask AI can learn one from a chain\'s own nutrition page.' }
        if (!chain) return { chains: doc.chains.map(c => ({ name: c.name, short: c.short, items: c.items.length, learned: !!c.learned, source: c.source?.what, dated: c.source?.published })) }
        const c = doc.chains.find(x => [x.name, x.short, x.id].some(n => String(n).toLowerCase() === chain.toLowerCase()))
          || doc.chains.find(x => x.name.toLowerCase().includes(chain.toLowerCase()))
        if (!c) throw new Error(`no menu for "${chain}" — get_menu with no chain lists them`)
        const items = c.items.filter(i => !category || i.category.toLowerCase().includes(category.toLowerCase()))
        const byCat = {}
        for (const i of items.slice(0, 250)) {
          (byCat[i.category] ||= []).push({ name: i.name, portions: i.portions.map(p => ({ ref: `m:${i.id}@${p.id}`, label: p.label, kcal: p.kcal, protein: p.protein, carbs: p.carbs, fat: p.fat })) })
        }
        return { chain: c.name, source: c.source, note: c.note, categories: byCat, truncated: items.length > 250 }
      },
    },
    {
      name: 'list_ask_threads',
      title: 'List Ask AI conversations',
      description: 'The Ask AI conversations in the app (receipts, photos, descriptions), newest first, with status and totals.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: READ,
      run: async () => ({ threads: (await ctx.listThreads()).slice(0, 30) }),
    },
  ]

  const byName = new Map(tools.map(t => [t.name, t]))
  const listed = tools.map(({ run, ...t }) => t)

  const INSTRUCTIONS = [
    'Krakatoa is the user\'s food log. To log what they ate: check list_saved for their own combos',
    'and foods first ("my usual breakfast" is probably a combo), then search_foods one food',
    'at a time, then log_food with the refs. Only estimate (food + portion) when nothing',
    'matches. For a restaurant meal or anything complicated, ask hands it to Krakatoa\'s own',
    'meal reader. Say what you logged and its calories. Ask before deleting anything.',
  ].join(' ')

  /** One JSON-RPC message in, one out (or null for a notification). */
  async function handle(msg) {
    const { id, method, params } = msg || {}
    const reply = (result) => ({ jsonrpc: '2.0', id, result })
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })
    if (id === undefined || id === null) return null // a notification
    try {
      if (method === 'initialize') {
        return reply({
          protocolVersion: params?.protocolVersion || PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'krakatoa', title: 'Krakatoa', version: '1.0.0' },
          instructions: INSTRUCTIONS,
        })
      }
      if (method === 'ping') return reply({})
      if (method === 'tools/list') return reply({ tools: listed })
      if (method === 'tools/call') {
        const tool = byName.get(params?.name)
        if (!tool) return fail(-32602, `no tool ${params?.name}`)
        try {
          const payload = { ...(await tool.run(params.arguments || {})), fetchedAt: new Date().toISOString() }
          return reply({ content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload })
        } catch (e) {
          return reply({ isError: true, content: [{ type: 'text', text: `Krakatoa: ${e.message || e}` }] })
        }
      }
      return fail(-32601, `method not found: ${method}`)
    } catch (e) {
      return fail(-32603, String(e.message || e))
    }
  }

  return { handle, tools: listed }
}

module.exports = { makeMcp, PROTOCOL }
