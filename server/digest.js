/*
 * Krakatoa — what the agents read.
 *
 * Bushido's coach and Totem both get to look at what he ate, and neither should
 * have to understand this app's store to do it. `dayDigest` and `digest` turn the
 * entry bag into the shape a model can reason about in one read: a day is a total,
 * a target, and the list of what filled it.
 *
 * Pure. Every instant is handed in by the caller, so this is testable arithmetic
 * rather than something that behaves differently at midnight.
 */

const { totals } = require('./nutrition.js')
const { balanceFor } = require('./whoop.js')

const live = (e) => e && !e.deleted && e.kind === 'food'

/** ISO date for a Date, in local time. Never toISOString — that is UTC. */
function isoDate(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The N dates ending at `today`, oldest first. */
function recentDates(today, days) {
  const out = []
  const base = new Date(`${today}T12:00:00`)
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(base)
    d.setDate(d.getDate() - i)
    out.push(isoDate(d))
  }
  return out
}

/** Everything logged on one date, in the order it was eaten. */
function itemsOn(state, date) {
  return Object.values(state?.entries || {})
    .filter(e => live(e) && e.date === date)
    .sort((a, b) => String(a.data?.at || a.updatedAt || '').localeCompare(String(b.data?.at || b.updatedAt || '')))
    .map(e => ({ id: e.id, ...e.data }))
}

/** Ounces of water logged on a date. Its own entry kind, one per day. */
function waterOn(state, date) {
  const e = state?.entries?.[`water-${date}`]
  return e && !e.deleted ? Math.max(0, Number(e.data?.oz) || 0) : 0
}

/** The standing targets, or nulls. A target nobody set is not a target of zero. */
function targetsOf(state) {
  const t = state?.entries?.targets?.data || {}
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null)
  return { kcal: n(t.kcal), protein: n(t.protein), carbs: n(t.carbs), fat: n(t.fat), water: n(t.water) }
}

/**
 * One day, resolved. `remaining` is null rather than a number when no target is
 * set, because "0 left" and "no target" are different states and only one of them
 * should turn a ring red.
 */
function dayDigest(state, date) {
  const items = itemsOn(state, date)
  const total = totals(items)
  const target = targetsOf(state)
  const remaining = {}
  for (const k of ['kcal', 'protein', 'carbs', 'fat']) {
    remaining[k] = target[k] == null ? null : Math.round((target[k] - total[k]) * 10) / 10
  }
  const byMeal = {}
  for (const it of items) {
    const meal = it.meal || 'other'
    byMeal[meal] = byMeal[meal] || []
    byMeal[meal].push(it)
  }
  return { date, total, target, remaining, count: items.length, items, byMeal, waterOz: waterOn(state, date) }
}

/**
 * A run of days, for an agent. Deliberately compact: the per-item detail is only
 * on TODAY, and earlier days are a total and a count. A fortnight of every food
 * he ate is 40 KB of prompt that mostly says "he eats oats", and the week planner
 * in Bushido already learned that lesson the expensive way — it timed out reading a
 * whole log it should have been grepping.
 */
function digest(state, { today, days = 14, whoop = null } = {}) {
  const dates = recentDates(today, days)
  const history = dates.map(date => {
    const d = dayDigest(state, date)
    // The balance rides along where WHOOP has a figure for that day, so an agent
    // reading this can see a fortnight of deficit without joining two files.
    const balance = whoop ? balanceFor(whoop, date, d.total.kcal, { today }) : null
    return {
      date: d.date, total: d.total, count: d.count, waterOz: d.waterOz,
      ...(balance ? { balance } : {}),
    }
  })
  const logged = history.filter(d => d.count > 0)
  const avg = logged.length
    ? totals(logged.map(d => d.total))
    : { kcal: 0, protein: 0, carbs: 0, fat: 0 }
  for (const k of Object.keys(avg)) {
    if (!logged.length) { avg[k] = null; continue }
    const mean = avg[k] / logged.length
    avg[k] = k === 'kcal' ? Math.round(mean) : Math.round(mean * 10) / 10
  }
  const todayDay = dayDigest(state, today)
  return {
    today: {
      ...todayDay,
      balance: whoop ? balanceFor(whoop, today, todayDay.total.kcal, { today }) : null,
    },
    targets: targetsOf(state),
    history,
    // Averaged over DAYS HE LOGGED, not over the window. A day he did not open the
    // app is missing data, and averaging it in as zero reads as a crash diet.
    average: avg,
    daysLogged: logged.length,
    daysInWindow: days,
  }
}

/**
 * The foods worth offering again, most-recently-eaten first. This is the feature
 * that makes a tracker survivable — nobody scans the same oats every morning for
 * a month — so it is counted across the whole log rather than a recent window.
 */
function recentFoods(state, { limit = 30 } = {}) {
  const seen = new Map()
  const entries = Object.values(state?.entries || {})
    .filter(live)
    .sort((a, b) => String(b.data?.at || b.updatedAt || '').localeCompare(String(a.data?.at || a.updatedAt || '')))

  for (const e of entries) {
    const d = e.data || {}
    const key = d.gtin || (d.name ? `${d.name}|${d.brand || ''}`.toLowerCase() : '')
    if (!key) continue
    // A food eaten twenty times is still one row, but the count is worth keeping:
    // it is what makes "the usual" sortable by more than recency.
    if (seen.has(key)) { seen.get(key).times++; continue }
    if (seen.size >= limit) continue
    seen.set(key, {
      key,
      name: d.name,
      brand: d.brand || null,
      gtin: d.gtin || null,
      source: d.source || null,
      portion: d.portion || null,
      qty: d.qty ?? 1,
      meal: d.meal || null,
      lastAt: d.at || e.updatedAt,
      times: 1,
    })
  }
  return [...seen.values()]
}

module.exports = { dayDigest, digest, recentFoods, itemsOn, targetsOf, waterOn, isoDate, recentDates }
