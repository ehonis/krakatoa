/*
 * Krakatoa -> Totem.
 *
 * Totem owns the dashboard and the habit history; this app is a WRITER into one
 * habit, not a second store — exactly the arrangement Bushido has with
 * `move-every-day`. The day's calories go in as the habit's numeric `value`, the
 * macro split as its `parts`, and what he ate as the note.
 *
 * Three rules, all of them Bushido's and all of them learned there:
 *
 *   - ONE DAY, ONE RECORD. The rollup is rebuilt from the whole day's entries
 *     every time, never patched per food. Syncing foods individually made the
 *     last write win and silently discarded the rest of the day.
 *   - FIRE AND FORGET. Totem being down, slow, or mid-restart must never fail a
 *     food log. The log is the thing that matters; the dashboard is a mirror.
 *   - THE SECRET NEVER REACHES THE BROWSER. It is read here, server-side, from
 *     Totem's own .env — the same file and the same way Bushido reads it.
 */

/*
 * Every call takes the bridge config, `{ url, secret, habit }`, from Settings
 * (see server/settings.js `totemConfig`). Null means the bridge is off, and
 * nothing is sent. A fresh install has it off.
 */

const HABIT_NAME = 'Krakatoa'

let last = { at: null, ok: null, detail: 'no sync attempted yet' }

async function call(cfg, method, route, body) {
  if (!cfg?.url || !cfg?.secret) throw new Error('the Totem bridge is not configured')
  const res = await fetch(`${cfg.url}${route}`, {
    method,
    headers: { authorization: `Bearer ${cfg.secret}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : {}
}

/** "1,840 kcal · 142 P / 180 C / 61 F — oats, Clif bar, chicken burrito" */
function noteFor(day) {
  const t = day.total
  const head = `${t.kcal.toLocaleString('en-US')} kcal · ${Math.round(t.protein)} P / ${Math.round(t.carbs)} C / ${Math.round(t.fat)} F`
  const names = day.items.map(i => i.name).filter(Boolean)
  const build = (list) => (list.length ? `${head} — ${list.join(', ')}` : head)

  // Totem caps the note at 500 characters. Drop the tail of the food list rather
  // than the totals: the numbers are the point and the names are the colour.
  let note = build(names)
  for (let n = names.length; note.length > 500 && n > 0; n--) {
    note = build([...names.slice(0, n - 1), `+${names.length - (n - 1)} more`])
  }
  return note.length > 500 ? head : note
}

/**
 * Push one day's rollup. `count` is how many foods were logged, so the habit's
 * streak means "I tracked", which is the behaviour worth building; the calories
 * ride along as the metric rather than as the streak, because a day he ate badly
 * is still a day he tracked and breaking the streak for it would teach him to
 * stop logging the bad days — which is exactly the data worth having.
 */
async function syncDay(state, digest, date, cfg) {
  if (!cfg) return { skipped: 'the Totem bridge is off' }
  const today = date || digest.isoDate(new Date())
  const day = digest.dayDigest(state, today)
  if (!day.count) return { skipped: 'nothing logged that day' }

  try {
    await call(cfg, 'POST', '/api/habits/log', {
      id: cfg.habit,
      date: today,
      count: day.count,
      note: noteFor(day),
      value: day.total.kcal,
      parts: { protein: day.total.protein, carbs: day.total.carbs, fat: day.total.fat },
    })
    last = { at: new Date().toISOString(), ok: true, detail: `logged ${today}` }
    return last
  } catch (e) {
    // Including "unknown habit", which is what you get before --ensure has run.
    last = { at: new Date().toISOString(), ok: false, detail: String(e.message || e) }
    return last
  }
}

/** The habit this app writes to, or null when Totem does not have it. Read-only: the Settings Test. */
async function findHabit(cfg) {
  const payload = await call(cfg, 'GET', '/api/habits')
  const habits = payload?.habits || payload || []
  return habits.find(h => h.id === cfg?.habit || String(h.name || '').toLowerCase() === HABIT_NAME.toLowerCase()) || null
}

/**
 * Create the habit if Totem does not have it. Idempotent and deliberately NOT
 * called from the request path — a food log must never create things in another
 * app as a side effect. Run it once, by hand, from the command line.
 */
async function ensureHabit(cfg) {
  const HABIT_ID = cfg?.habit
  const found = await findHabit(cfg)
  if (found) return { created: false, id: found.id, name: found.name }

  await call(cfg, 'POST', '/api/habits', {
    name: HABIT_NAME,
    description: 'What I ate, from the Krakatoa app. Calories are the metric; the streak is whether I tracked at all.',
    color: '#f59e0b',
    cadence: 'daily',
    target: 1,
    metric: {
      label: 'Calories', unit: 'kcal', min: 0, max: 5000, goal: 2400,
      decimals: 0, direction: 'higher', chart: 'bar', pinned: true,
      parts: [
        { key: 'protein', label: 'Protein', color: '#5b8cff' },
        { key: 'carbs', label: 'Carbs', color: '#2dd4bf' },
        { key: 'fat', label: 'Fat', color: '#f59e0b' },
      ],
    },
  })
  return { created: true, id: HABIT_ID, name: HABIT_NAME }
}

const status = () => ({ ...last })

module.exports = { syncDay, ensureHabit, findHabit, status, noteFor }

/* node server/totem.js --ensure   — create the habit in Totem, once. Reads the
   same settings the server does (KRAKATOA_DATA_DIR, env, data/settings.json). */
if (require.main === module && process.argv.includes('--ensure')) {
  const path = require('path')
  const { makeSettings, totemConfig } = require('./settings.js')
  const dataDir = process.env.KRAKATOA_DATA_DIR || path.join(__dirname, '..', 'data')
  const cfg = totemConfig(makeSettings({ dataDir }).effective())
  if (!cfg) { console.error('The Totem bridge is off or has no secret. Turn it on in Settings, or set KRAKATOA_TOTEM=1 and BRIDGE_SECRET.'); process.exit(1) }
  ensureHabit(cfg)
    .then(r => console.log(r.created ? `created habit "${r.name}" (${r.id})` : `habit already there: ${r.id}`))
    .catch(e => { console.error('could not reach Totem:', e.message); process.exitCode = 1 })
}
