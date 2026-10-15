/*
 * Krakatoa <- WHOOP.
 *
 * What he BURNED, so the day can say whether he is under or over. WHOOP computes
 * a whole-day energy expenditure from heart rate plus basal rate and publishes it
 * per cycle; Bushido already hands it over as `recovery[].calories`.
 *
 * Three rules, inherited wholesale from Bushido and structural rather than a matter
 * of care (see `bushido/AGENTS.md` §6):
 *
 *   - ONE TOKEN HOLDER. WHOOP rotates its refresh token on every refresh and
 *     invalidates the old pair, so exactly one process may hold it — Bushido.
 *     This app asks Bushido for the owner's training data
 *     (`POST /api/whoop/owner`, method `training`) with BUSHIDO_API_TOKEN.
 *     Copying the credentials here would give one member two grants and
 *     silently kill one.
 *   - THE CACHE IS DISPOSABLE. `data/whoop.json` is a refetchable mirror.
 *     Delete it freely; never hand-edit it, because the next pull overwrites the
 *     edit and it is a lie with a short life.
 *   - NOTHING BLOCKS ON IT. A WHOOP outage, a revoked grant or a Bushido that is
 *     down must leave the cache as it was and must never fail a food log. A day
 *     with no burn figure simply has no balance line.
 *
 * And one rule of this app's own: WHOOP's daily figure is an ESTIMATE, and
 * today's is a PARTIAL one that keeps rising until midnight. Neither fact may be
 * hidden behind a confident-looking number. See `balanceFor`.
 */

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')

/* How long a cached pull stays fresh before a read kicks off a background one. */
const STALE_MS = Number(process.env.KRAKATOA_WHOOP_STALE_MS || 20 * 60 * 1000)
const DAYS = Number(process.env.KRAKATOA_WHOOP_DAYS || 30)

/* What a read answers when no source is configured: no burn, and says why. */
const NOT_CONFIGURED = Object.freeze({ fetchedAt: null, burn: {}, error: null, configured: false })

/**
 * Pull from Bushido and reshape to the only thing this app wants: burn per day.
 * The payload also carries workouts, zones and heart rates, none of which is
 * Krakatoa's business — Bushido owns training.
 *
 * Bushido answers `200 { result }`, where `result` is the training payload
 * (`{ ok, fetchedAt, days, maxHeartRate, body, workouts, recovery, sleep }`), or
 * a non-2xx `{ error, needsReauth?, rateLimited? }`: 409 when it has no WHOOP set
 * up, 403 for a wrong token, 429 rate limited, 502 for an error from WHOOP.
 */
async function pull({ url, token, days = DAYS } = {}) {
  if (!url || !token) throw new Error('Bushido is not configured — see Settings.')

  const res = await fetch(`${url}/api/whoop/owner`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'training', args: [{ days }] }),
    signal: AbortSignal.timeout(15000),
  })
  const text = await res.text()
  if (!res.ok) {
    // Bushido passes on WHOOP's message, and it is the FIX ("authorized without
    // read:workout", "reconnect WHOOP"), so it travels verbatim rather than
    // being flattened.
    let msg = text.slice(0, 200)
    try { msg = JSON.parse(text).error || msg } catch { /* not JSON, use the text */ }
    throw new Error(msg || `Bushido answered ${res.status}.`)
  }

  let body
  try { body = JSON.parse(text).result } catch { /* handled below */ }
  if (!body || typeof body !== 'object') throw new Error('Bushido answered without a WHOOP result.')
  if (body.ok === false) throw new Error(String(body.error || 'Bushido could not read WHOOP.').slice(0, 200))

  const burn = {}
  for (const row of body.recovery || []) {
    if (!row?.date) continue
    const kcal = Number(row.calories)
    if (!Number.isFinite(kcal) || kcal <= 0) continue
    burn[row.date] = { kcal: Math.round(kcal), strain: Number(row.strain) || null }
  }

  return {
    fetchedAt: new Date().toISOString(),
    days,
    // Kept because a deficit is only meaningful against a body, and it is one
    // number rather than a second store of physiology.
    weightLb: body.body?.weightLb ?? null,
    burn,
  }
}

/* --------------------------------------------------------------- the cache */

/*
 * `config()` is asked on every call and returns Bushido's `{ url, token }`,
 * or null when no source is configured. Null means OFF: no request is made, no
 * error is logged, and reads answer NOT_CONFIGURED so the screen shows no panel.
 */
function makeStore(file, { config = () => null } = {}) {
  let refreshing = null

  const readFile = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return { fetchedAt: null, burn: {}, error: null }
    }
  }
  const read = () => (config() ? { ...readFile(), configured: true } : NOT_CONFIGURED)

  const write = async (doc) => {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, JSON.stringify(doc, null, 2))
  }

  /** Refetch now. The only synchronous path, and it is the button. */
  const refresh = async () => {
    const cfg = config()
    if (!cfg) return NOT_CONFIGURED
    if (refreshing) return refreshing
    refreshing = (async () => {
      try {
        const doc = await pull(cfg)
        await write(doc)
        return { ...doc, configured: true }
      } catch (e) {
        // The previous cache SURVIVES a failed pull. Yesterday's burn is still
        // yesterday's burn, and blanking it because Bushido is down would
        // lose a real number to a transient one.
        const prev = readFile()
        const doc = { ...prev, error: String(e.message || e), erroredAt: new Date().toISOString() }
        await write(doc).catch(() => {})
        return { ...doc, configured: true }
      } finally {
        refreshing = null
      }
    })()
    return refreshing
  }

  /** Serve what is on disk, and kick off a refresh we do not wait for. */
  const get = () => {
    if (!config()) return NOT_CONFIGURED
    const doc = read()
    const age = doc.fetchedAt ? Date.now() - Date.parse(doc.fetchedAt) : Infinity
    if (age > STALE_MS) refresh().catch(() => {})
    return doc
  }

  return { get, refresh, read }
}

/* ----------------------------------------------------------- the arithmetic */

/**
 * Eaten against burned, for one day — and the honesty is the whole function.
 *
 * `partial` is true for TODAY, because WHOOP's figure is what he has burned so
 * far and climbs until midnight. At 14:23 a naive subtraction read "37 kcal
 * under" off 1,853 eaten and 1,890 burned, which is not a deficit, it is a
 * clock. The screen says "so far" and the number is never dressed up as a
 * verdict.
 *
 * `typical` is the mean burn of COMPLETE days in the window, which is what gives
 * a partial number something to be read against. It is measured, not projected —
 * this app does not invent numbers, and "you usually end up around 2,500" is a
 * fact about his last fortnight rather than a guess about tonight.
 */
function balanceFor(whoop, date, eaten, { today } = {}) {
  const row = whoop?.burn?.[date]
  if (!row) return null

  const isToday = date === (today || new Date().toISOString().slice(0, 10))
  const complete = Object.entries(whoop.burn || {})
    .filter(([d]) => d !== (today || ''))
    .map(([, v]) => v.kcal)
    .filter(n => Number.isFinite(n))

  const typical = complete.length >= 3
    ? Math.round(complete.reduce((a, b) => a + b, 0) / complete.length)
    : null

  const ate = Math.round(eaten || 0)
  return {
    date,
    burned: row.kcal,
    strain: row.strain,
    eaten: ate,
    net: Math.round(ate - row.kcal),
    partial: isToday,
    /*
     * Nothing logged is not a 2,800 calorie deficit — it is a day he did not
     * open the app. Without this the log's own gaps read as the most dramatic
     * results in it, and an agent reading the digest would draw exactly the
     * wrong conclusion. Same rule as `average` in digest.js counting only the
     * days he actually logged.
     */
    untracked: ate === 0,
    typical,
  }
}

module.exports = { pull, makeStore, balanceFor, NOT_CONFIGURED }
