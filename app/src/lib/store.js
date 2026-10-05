/*
 * Krakatoa — the client store.
 *
 * The same arrangement Bushido uses, for the same reason: he logs food standing in
 * a kitchen or a supermarket aisle, where the network is whatever it is. So the
 * browser owns a full copy, every write lands locally FIRST and syncs after, and
 * the server merges per entry by `updatedAt`. Nothing blocks on a request.
 *
 * The one rule worth keeping: a component must never hold a COPY of an entry.
 * Derive it from `entries` every render — Bushido shipped that bug twice (the sheet
 * showing a stale name, the runner's double write) and it renders perfectly while
 * being wrong, so no test catches it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { foodKey, isoDate, totals } from './food.js'
import { comboAsFood, listCombos } from './combos.js'
import { handoffTarget } from './handoff.js'
import { makeLocalPersist, onSignedOutElsewhere } from './signout.js'

const LOCAL_KEY = 'krakatoa.state.v1'
// Back-compat for the Fuel -> Krakatoa rename (2026-10-02): a device that last
// ran as Fuel has its log under the old key. Moved over once on first read.
// Can go once every device has opened Krakatoa at least once.
const OLD_LOCAL_KEY = 'fuel.state.v1'

const emptyState = () => ({ version: 1, updatedAt: null, entries: {} })

function readLocal() {
  try {
    let raw = localStorage.getItem(LOCAL_KEY)
    if (!raw && (raw = localStorage.getItem(OLD_LOCAL_KEY))) {
      // Moving the key is best effort: a second copy can exceed the quota, and
      // the log in `raw` must still load either way.
      try {
        localStorage.setItem(LOCAL_KEY, raw)
        localStorage.removeItem(OLD_LOCAL_KEY)
      } catch { /* left under the old key; read again from there next time */ }
    }
    if (!raw) return emptyState()
    const doc = JSON.parse(raw)
    return { ...emptyState(), ...doc, entries: doc.entries || {} }
  } catch {
    return emptyState()
  }
}

/*
 * Signing out, in this tab or any other, takes the log off this device
 * (lib/signout.js); a sync landing afterwards must not write it back, so the
 * write refuses once the shared marker is set. A full quota is also a silent
 * refusal: the write is already in memory.
 */
let persist = null
function writeLocal(doc) {
  if (typeof window === 'undefined') return
  persist = persist || makeLocalPersist({ storage: window.localStorage, flagTarget: window, key: LOCAL_KEY })
  persist(doc)
}

/** Newest `updatedAt` wins, per entry. Identical to the server's rule. */
function mergeEntries(mine, theirs) {
  const out = { ...mine }
  for (const [id, entry] of Object.entries(theirs || {})) {
    if (!entry || typeof entry !== 'object') continue
    const have = out[id]
    if (!have || String(entry.updatedAt || '') >= String(have.updatedAt || '')) out[id] = entry
  }
  return out
}

let seq = 0
/** Ids carry their date so the log is greppable by eye, and a random tail so two
 *  devices logging in the same second cannot collide. */
export function newId(date) {
  seq += 1
  const rand = Math.random().toString(36).slice(2, 8)
  return `food-${date}-${Date.now().toString(36)}${seq.toString(36)}${rand}`
}

export function useStore() {
  const [doc, setDoc] = useState(readLocal)
  const [sync, setSync] = useState({ state: 'idle', at: null, error: null })
  const pending = useRef(false)
  // Bumped by every local write. A push only clears `pending` when nothing was
  // written while it was in flight; otherwise that later edit would be marked
  // synced without ever having been sent.
  const writes = useRef(0)
  const markDirty = useCallback(() => { writes.current += 1; pending.current = true }, [])

  // Everything on disk is written through here, so local and remote can never
  // drift apart without the merge having been applied to both.
  const apply = useCallback((entries) => {
    setDoc(prev => {
      const next = { ...prev, updatedAt: new Date().toISOString(), entries: mergeEntries(prev.entries, entries) }
      writeLocal(next)
      return next
    })
    markDirty()
  }, [markDirty])

  const push = useCallback(async (entries) => {
    const sent = writes.current
    setSync(s => ({ ...s, state: 'syncing' }))
    try {
      const res = await fetch('/api/state', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: { entries } }),
      })
      if (!res.ok) throw new Error(`${res.status}`)
      const body = await res.json()
      setDoc(prev => {
        const next = { ...prev, entries: mergeEntries(prev.entries, body?.state?.entries) }
        writeLocal(next)
        return next
      })
      if (writes.current === sent) pending.current = false
      setSync({ state: 'ok', at: new Date().toISOString(), error: null })
      // On the old hostname, a push that landed with nothing newer behind it is
      // the signal to move (handoff.js). An edit made mid-flight is still
      // pending, so its own debounced push goes first and moves the page then.
      const to = handoffTarget(window.location)
      if (to && !pending.current) window.location.replace(to)
    } catch (e) {
      // Offline is the normal case, not an error worth shouting about. The write
      // is already local and the next successful sync carries it.
      setSync({ state: 'offline', at: new Date().toISOString(), error: String(e.message || e) })
    }
  }, [])

  /*
   * Pull on open — and whenever the app comes back to the foreground, and once a
   * minute while it is showing. Since 2026-09-25 the phone is not the only
   * writer: Totem logs through Krakatoa's MCP, and an installed PWA resumed from
   * the app switcher does not reload, so pulling only on open showed a day
   * without the breakfast he had just logged by talking to Totem.
   */
  /* Another tab signed out: this one's log is gone from the device too. */
  useEffect(() => onSignedOutElsewhere({ win: window, fn: () => window.location.assign('/login') }), [])

  useEffect(() => {
    let alive = true
    const pull = async () => {
      try {
        const res = await fetch('/api/state')
        if (!res.ok) throw new Error(String(res.status))
        const body = await res.json()
        if (!alive) return
        setDoc(prev => {
          const next = { ...prev, entries: mergeEntries(prev.entries, body?.state?.entries) }
          writeLocal(next)
          return next
        })
        setSync({ state: 'ok', at: new Date().toISOString(), error: null })
      } catch (e) {
        if (alive) setSync(s => ({ ...s, state: 'offline', error: String(e.message || e) }))
      }
    }
    pull()
    const wake = () => { if (document.visibilityState === 'visible') pull() }
    document.addEventListener('visibilitychange', wake)
    const tick = setInterval(() => { if (document.visibilityState === 'visible') pull() }, 60000)
    return () => { alive = false; document.removeEventListener('visibilitychange', wake); clearInterval(tick) }
  }, [])

  // Debounced push. A qty stepper pressed six times is one request.
  useEffect(() => {
    if (!pending.current) return
    const t = setTimeout(() => { if (pending.current) push(doc.entries) }, 700)
    return () => clearTimeout(t)
  }, [doc, push])

  // On the old hostname, push EVERYTHING local once, not just this session's
  // writes, because the entries worth rescuing are from sessions that ended
  // offline. A successful push then moves the page (see push above).
  useEffect(() => {
    if (handoffTarget(window.location)) push(readLocal().entries)
  }, [push])

  // And a retry whenever the device says it is back, because the debounce above
  // has already fired and given up by then.
  useEffect(() => {
    const retry = () => { if (pending.current || handoffTarget(window.location)) push(doc.entries) }
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [doc, push])

  /* --------------------------------------------------------------- writers */

  const putEntry = useCallback((entry) => {
    apply({ [entry.id]: { ...entry, updatedAt: new Date().toISOString() } })
  }, [apply])

  /* Bumped whenever a meal is logged, so the list sorts by what he actually uses
     rather than by when he happened to create it. */
  const touchCombo = useCallback((id) => {
    setDoc(prev => {
      const have = prev.entries[id]
      if (!have) return prev
      const next = {
        ...prev,
        entries: {
          ...prev.entries,
          [id]: {
            ...have,
            updatedAt: new Date().toISOString(),
            data: { ...have.data, lastUsedAt: new Date().toISOString() },
          },
        },
      }
      writeLocal(next)
      return next
    })
    markDirty()
  }, [])

  const logFood = useCallback(({ food, portion, qty, meal, date, note }) => {
    const day = date || isoDate()
    const id = newId(day)
    const at = new Date().toISOString()
    const amount = amountOf(portion, qty)
    putEntry({
      id,
      kind: 'food',
      date: day,
      data: {
        at,
        name: food.name,
        brand: food.brand || null,
        gtin: food.gtin || null,
        source: food.source || 'manual',
        // Kept ON THE ENTRY, not looked up from the food cache at render time.
        // Same argument as the stored macros: what he ate is a fact about that
        // day, and a product later edited or withdrawn upstream must not blank
        // a row in his log.
        image: food.image || null,
        // A photo borrowed from a component needs its owner's barcode to load.
        imageGtin: food.imageGtin || null,
        meal: meal || 'snack',
        qty,
        portion,
        note: note || null,
        // A combo lands as ONE ordinary food entry that happens to remember what
        // went into it — see lib/combos.js. Everything downstream reads the
        // totals and never has to know.
        comboId: food.comboId || null,
        components: food.source === 'combo' ? (food.components || null) : null,
        ...amount,
      },
    })
    // Using a meal is what sorts the meal list, so it is recorded on the combo.
    if (food.comboId) touchCombo(food.comboId)
    return id
  }, [putEntry, touchCombo])

  const editFood = useCallback((id, patch) => {
    setDoc(prev => {
      const have = prev.entries[id]
      if (!have) return prev
      const data = { ...have.data, ...patch }
      // Recompute the stored macros whenever the quantity or the portion moves.
      // They are stored rather than derived so a food deleted from a database
      // upstream cannot retroactively change what a day totalled.
      if (patch.qty !== undefined || patch.portion !== undefined) {
        Object.assign(data, amountOf(data.portion, data.qty))
      }
      const next = {
        ...prev,
        updatedAt: new Date().toISOString(),
        entries: { ...prev.entries, [id]: { ...have, updatedAt: new Date().toISOString(), data } },
      }
      writeLocal(next)
      return next
    })
    markDirty()
  }, [])

  /**
   * Move a logged entry to another DAY. `date` lives on the entry rather than in
   * `data`, so this is the one edit that cannot go through editFood — and it is
   * the fix for the commonest mistake there is: logging today what you ate
   * yesterday.
   */
  const moveEntry = useCallback((id, date) => {
    setDoc(prev => {
      const have = prev.entries[id]
      if (!have || !date) return prev
      const next = {
        ...prev,
        updatedAt: new Date().toISOString(),
        entries: { ...prev.entries, [id]: { ...have, date, updatedAt: new Date().toISOString() } },
      }
      writeLocal(next)
      return next
    })
    markDirty()
  }, [])

  const removeFood = useCallback((id) => {
    setDoc(prev => {
      const have = prev.entries[id]
      if (!have) return prev
      // A tombstone, not a delete: the other device has to hear about it too.
      const next = {
        ...prev,
        updatedAt: new Date().toISOString(),
        entries: { ...prev.entries, [id]: { ...have, deleted: true, updatedAt: new Date().toISOString() } },
      }
      writeLocal(next)
      return next
    })
    markDirty()
  }, [])

  /* ---------------------------------------------------------------- water */

  /*
   * ONE entry per day holding a running total, not one per glass. A glass of
   * water is not a thing with a history worth keeping — nobody asks what time
   * they drank it — and a day's total is what every reader wants. It also means
   * the quick buttons are an increment rather than a write per tap, so a fast
   * six taps is one entry and one sync.
   */
  const addWater = useCallback((date, oz) => {
    const day = date || isoDate()
    const id = `water-${day}`
    setDoc(prev => {
      const have = prev.entries[id]
      const next0 = Math.max(0, Math.round((Number(have?.data?.oz) || 0) + Number(oz)))
      const next = {
        ...prev,
        updatedAt: new Date().toISOString(),
        entries: {
          ...prev.entries,
          [id]: {
            id,
            kind: 'water',
            date: day,
            updatedAt: new Date().toISOString(),
            data: { oz: next0, at: new Date().toISOString() },
          },
        },
      }
      writeLocal(next)
      return next
    })
    markDirty()
  }, [])

  const setTargets = useCallback((targets) => {
    putEntry({ id: 'targets', kind: 'settings', date: null, data: targets })
  }, [putEntry])

  /* -------------------------------------------------------------- starred */

  /*
   * A food he keeps because he USES it, not because he has eaten it yet.
   * Recents answer "what did I have lately"; this answers "the protein powder I
   * buy" — a thing he wants findable in one tap forever, including the first
   * time, and including after a month of not touching it when recents have long
   * since scrolled past. Stored as an entry so it syncs like everything else.
   */
  const starFood = useCallback((food) => {
    const key = foodKey(food)
    if (!key) return null
    const id = `star-${key}`
    putEntry({
      id,
      kind: 'star',
      date: null,
      data: {
        key,
        name: food.name,
        brand: food.brand || null,
        gtin: food.gtin || null,
        image: food.image || null,
        source: food.source || 'manual',
        usdaName: food.usdaName || null,
        // The whole portion list, so a starred food logs with its real servings
        // rather than whatever single portion happened to be logged once.
        portions: food.portions || [],
        starredAt: new Date().toISOString(),
      },
    })
    return id
  }, [putEntry])

  const unstarFood = useCallback((food) => {
    const key = foodKey(food)
    const id = `star-${key}`
    setDoc(prev => {
      const have = prev.entries[id]
      if (!have) return prev
      const next = {
        ...prev,
        updatedAt: new Date().toISOString(),
        entries: { ...prev.entries, [id]: { ...have, deleted: true, updatedAt: new Date().toISOString() } },
      }
      writeLocal(next)
      return next
    })
    markDirty()
  }, [])

  /* ---------------------------------------------------------------- meals */

  const saveCombo = useCallback(({ id, name, components, meal }) => {
    const comboId = id || `combo-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
    putEntry({
      id: comboId,
      kind: 'combo',
      // No date: a saved meal is not a thing that happened on a day.
      date: null,
      data: {
        name: String(name || '').trim() || 'Combo',
        components,
        meal: meal || null,
        createdAt: new Date().toISOString(),
      },
    })
    return comboId
  }, [putEntry])

  const removeCombo = useCallback((id) => {
    setDoc(prev => {
      const have = prev.entries[id]
      if (!have) return prev
      const next = {
        ...prev,
        updatedAt: new Date().toISOString(),
        entries: { ...prev.entries, [id]: { ...have, deleted: true, updatedAt: new Date().toISOString() } },
      }
      writeLocal(next)
      return next
    })
    markDirty()
  }, [])

  const logCombo = useCallback(({ combo, qty, meal, date }) => {
    const food = comboAsFood(combo)
    return logFood({
      food: { ...food, components: combo.components },
      portion: food.portions[0],
      qty: qty ?? 1,
      meal: meal || combo.meal,
      date,
    })
  }, [logFood])

  /* --------------------------------------------------------------- readers */

  const entries = doc.entries

  const targets = useMemo(() => {
    const t = entries.targets?.data || {}
    const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null)
    return { kcal: n(t.kcal), protein: n(t.protein), carbs: n(t.carbs), fat: n(t.fat), water: n(t.water) }
  }, [entries])

  const dayItems = useCallback((date) => (
    Object.values(entries)
      .filter(e => e && !e.deleted && e.kind === 'food' && e.date === date)
      .sort((a, b) => String(a.data?.at || '').localeCompare(String(b.data?.at || '')))
      .map(e => ({ id: e.id, ...e.data }))
  ), [entries])

  const waterOn = useCallback((date) => {
    const e = entries[`water-${date}`]
    return e && !e.deleted ? Math.max(0, Number(e.data?.oz) || 0) : 0
  }, [entries])

  const combos = useMemo(() => listCombos(entries), [entries])

  const starred = useMemo(() => (
    Object.values(entries)
      .filter(e => e && !e.deleted && e.kind === 'star')
      .map(e => e.data)
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
  ), [entries])

  const starredKeys = useMemo(() => new Set(starred.map(s => s.key)), [starred])
  const isStarred = useCallback((food) => starredKeys.has(foodKey(food)), [starredKeys])

  /**
   * Every time he has eaten one particular food, newest first. This is what the
   * product screen is: "when have I had this", answered from the log rather than
   * from a separate index, so it can never disagree with the day it came from.
   */
  const historyFor = useCallback((key) => (
    Object.values(entries)
      .filter(e => e && !e.deleted && e.kind === 'food' && foodKey(e.data) === key)
      .map(e => ({ id: e.id, date: e.date, ...e.data }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date))
        || String(b.at || '').localeCompare(String(a.at || '')))
  ), [entries])

  /** One logged entry by id, derived every render. Never held as a copy. */
  const entryById = useCallback((id) => {
    const e = entries[id]
    if (!e || e.deleted || e.kind !== 'food') return null
    return { id: e.id, date: e.date, ...e.data }
  }, [entries])

  const recent = useMemo(() => {
    const seen = new Map()
    // A saved meal already has its own section above recents, so listing it in
    // both is the same tap offered twice. Only meals that STILL EXIST are
    // filtered out — a combo he deleted leaves its logged instances behind, and
    // those are still worth being able to log again.
    const liveCombos = new Set(
      Object.values(entries).filter(e => e?.kind === 'combo' && !e.deleted).map(e => e.id),
    )
    const rows = Object.values(entries)
      .filter(e => e && !e.deleted && e.kind === 'food')
      .filter(e => !(e.data?.comboId && liveCombos.has(e.data.comboId)))
      .sort((a, b) => String(b.data?.at || '').localeCompare(String(a.data?.at || '')))
    for (const e of rows) {
      const d = e.data || {}
      const key = d.gtin || (d.name ? `${d.name}|${d.brand || ''}`.toLowerCase() : '')
      if (!key) continue
      if (seen.has(key)) { seen.get(key).times++; continue }
      if (seen.size >= 60) continue
      seen.set(key, {
        key,
        food: {
          name: d.name, brand: d.brand, gtin: d.gtin, source: d.source,
          image: d.image || null,
          portions: d.portion ? [d.portion] : [],
        },
        portion: d.portion,
        qty: d.qty ?? 1,
        meal: d.meal,
        lastAt: d.at,
        times: 1,
      })
    }
    return [...seen.values()]
  }, [entries])

  return {
    doc, entries, sync, targets,
    dayItems, recent, combos, starred, isStarred, historyFor, entryById, waterOn,
    logFood, logCombo, editFood, moveEntry, removeFood, addWater,
    saveCombo, removeCombo, starFood, unstarFood, setTargets, putEntry,
  }
}

/* Local copy so store.js does not import the whole of food.js for one function. */
function amountOf(portion, qty) {
  const q = Number.isFinite(qty) && qty > 0 ? qty : 1
  const s = (v) => (Number.isFinite(v) ? Math.round(v * q * 10) / 10 : 0)
  return {
    kcal: Number.isFinite(portion?.kcal) ? Math.round(portion.kcal * q) : 0,
    protein: s(portion?.protein),
    carbs: s(portion?.carbs),
    fat: s(portion?.fat),
  }
}

export { mergeEntries, totals }
