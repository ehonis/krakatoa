/*
 * Krakatoa — the client store. Ported from app/src/lib/store.js; the writers,
 * readers and merge rule are the web's, line for line, so keep the two in step.
 *
 * The same arrangement Bushido uses, for the same reason: he logs food standing in
 * a kitchen or a supermarket aisle, where the network is whatever it is. So the
 * phone owns a full copy, every write lands locally FIRST and syncs after, and
 * the server merges per entry by `updatedAt`. Nothing blocks on a request.
 *
 * The one rule worth keeping: a component must never hold a COPY of an entry.
 * Derive it from `entries` every render — Bushido shipped that bug twice (the sheet
 * showing a stale name, the runner's double write) and it renders perfectly while
 * being wrong, so no test catches it.
 *
 * What differs from the web, and why:
 *   - ONE store for the app, not a hook's state. The web calls useStore() once in
 *     App and passes it down; here the day, the add sheet and the food sheet are
 *     separate screens, so they share this module and subscribe to it.
 *   - The sync loop is started by the signed-in layout (startSync) and stopped on
 *     sign-out. `visibilitychange` is AppState; there is no `online` event, so the
 *     minute tick also retries a push that is still pending.
 *   - No Fuel-era key and no hostname hand-off: the app never ran under either.
 */

import { useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import { foodKey, isoDate, totals } from './food'
import { comboAsFood, listCombos } from './combos'
import { apiFetch } from './connection'
import type { Combo, Component, Entry, Food, Item, Portion } from './types'

export const LOCAL_KEY = 'krakatoa.state.v1'

export interface Doc { version: number; updatedAt: string | null; entries: Record<string, Entry> }
export interface Sync { state: 'idle' | 'syncing' | 'ok' | 'offline'; at: string | null; error: string | null }

const emptyState = (): Doc => ({ version: 1, updatedAt: null, entries: {} })

function readLocal(): Doc {
  try {
    const raw = localStorage.getItem(LOCAL_KEY)
    if (!raw) return emptyState()
    const doc = JSON.parse(raw)
    return { ...emptyState(), ...doc, entries: doc.entries || {} }
  } catch {
    return emptyState()
  }
}

/*
 * Signing out takes the log off this device (lib/signout.ts); a sync landing
 * afterwards must not write it back, so the write refuses while that is under
 * way. A full disk is also a silent refusal: the write is already in memory.
 */
let frozen = false
export function freezeWrites(on: boolean) { frozen = on }

function writeLocal(next: Doc) {
  if (frozen) return
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(next)) } catch { /* in memory still */ }
}

/** Newest `updatedAt` wins, per entry. Identical to the server's rule. */
export function mergeEntries(mine: Record<string, Entry>, theirs: Record<string, Entry> | null | undefined) {
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
export function newId(date: string) {
  seq += 1
  const rand = Math.random().toString(36).slice(2, 8)
  return `food-${date}-${Date.now().toString(36)}${seq.toString(36)}${rand}`
}

/* ------------------------------------------------------------------ state */

let doc: Doc = readLocal()
let sync: Sync = { state: 'idle', at: null, error: null }
let pending = false
// Bumped by every local write. A push only clears `pending` when nothing was
// written while it was in flight; otherwise that later edit would be marked
// synced without ever having been sent.
let writes = 0
let pushTimer: ReturnType<typeof setTimeout> | null = null
const subs = new Set<() => void>()

function emit() {
  snapshot = build()
  subs.forEach(fn => fn())
}

function setDoc(fn: (prev: Doc) => Doc) {
  const next = fn(doc)
  if (next === doc) return
  doc = next
  emit()
}

function setSync(next: Sync | ((s: Sync) => Sync)) {
  sync = typeof next === 'function' ? next(sync) : next
  emit()
}

// Debounced push. A qty stepper pressed six times is one request.
function markDirty() {
  writes += 1
  pending = true
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => { if (pending) void push(doc.entries) }, 700)
}

// Everything on disk is written through here, so local and remote can never
// drift apart without the merge having been applied to both.
function apply(entries: Record<string, Entry>) {
  setDoc(prev => {
    const next = { ...prev, updatedAt: new Date().toISOString(), entries: mergeEntries(prev.entries, entries) }
    writeLocal(next)
    return next
  })
  markDirty()
}

async function push(entries: Record<string, Entry>) {
  const sent = writes
  setSync(s => ({ ...s, state: 'syncing' }))
  try {
    const res = await apiFetch('/api/state', {
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
    if (writes === sent) pending = false
    setSync({ state: 'ok', at: new Date().toISOString(), error: null })
  } catch (e: any) {
    // Offline is the normal case, not an error worth shouting about. The write
    // is already local and the next successful sync carries it.
    setSync({ state: 'offline', at: new Date().toISOString(), error: String(e?.message || e) })
  }
}

async function pull() {
  try {
    const res = await apiFetch('/api/state')
    if (!res.ok) throw new Error(String(res.status))
    const body = await res.json()
    setDoc(prev => {
      const next = { ...prev, entries: mergeEntries(prev.entries, body?.state?.entries) }
      writeLocal(next)
      return next
    })
    setSync({ state: 'ok', at: new Date().toISOString(), error: null })
  } catch (e: any) {
    setSync(s => ({ ...s, state: 'offline', error: String(e?.message || e) }))
  }
}

/*
 * Pull on open — and whenever the app comes back to the foreground, and once a
 * minute while it is showing. Since 2026-09-25 the phone is not the only
 * writer: Totem logs through Krakatoa's MCP, so pulling only on open showed a day
 * without the breakfast he had just logged by talking to Totem. A push still
 * pending (it failed offline) is retried on the same beats.
 */
export function startSync(): () => void {
  // Signed in again: the device may hold the log once more (see signout.ts).
  freezeWrites(false)
  doc = readLocal()
  // `pending` lives in memory, so an entry logged offline before iOS ended the
  // app would otherwise wait for the next write. The server merges newest-wins,
  // so sending the whole log is safe, as sign-out does.
  if (Object.keys(doc.entries).length) pending = true
  emit()
  const beat = () => { void pull(); if (pending) void push(doc.entries) }
  beat()
  const sub = AppState.addEventListener('change', (s) => { if (s === 'active') beat() })
  const tick = setInterval(() => { if (AppState.currentState === 'active') beat() }, 60000)
  return () => { sub.remove(); clearInterval(tick) }
}

/** Pull now (and send anything pending): the day's pull-to-refresh. */
export async function syncNow() {
  await pull()
  if (pending) await push(doc.entries)
}

/** Push every local entry now and answer with the server's copy (signing out). */
export async function flushAll(): Promise<Record<string, Entry> | null> {
  return pushAndRead(readLocal().entries)
}

async function pushAndRead(entries: Record<string, Entry>) {
  const json = { 'content-type': 'application/json', accept: 'application/json' }
  try {
    const res = await apiFetch('/api/state', { method: 'PUT', headers: json, body: JSON.stringify({ state: { entries } }) })
    if (res.ok) return (await res.json())?.state?.entries || {}
  } catch { /* offline: try a read */ }
  try {
    const res = await apiFetch('/api/state', { headers: { accept: 'application/json' } })
    if (res.ok) return (await res.json())?.state?.entries || {}
  } catch { /* offline */ }
  return null
}

/** The log is gone from this device (signed out): start the next one empty. */
export function resetStore() {
  if (pushTimer) clearTimeout(pushTimer)
  pending = false
  writes = 0
  doc = emptyState()
  sync = { state: 'idle', at: null, error: null }
  emit()
}

/* --------------------------------------------------------------- writers */

function putEntry(entry: Entry) {
  apply({ [entry.id]: { ...entry, updatedAt: new Date().toISOString() } })
}

/* Bumped whenever a meal is logged, so the list sorts by what he actually uses
   rather than by when he happened to create it. */
function touchCombo(id: string) {
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
}

export interface LogArgs { food: Food; portion: Portion; qty: number; meal?: string | null; date?: string | null; note?: string | null }

function logFood({ food, portion, qty, meal, date, note }: LogArgs) {
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
      // went into it — see lib/combos.ts. Everything downstream reads the
      // totals and never has to know.
      comboId: food.comboId || null,
      components: food.source === 'combo' ? (food.components || null) : null,
      ...amount,
    },
  })
  // Using a meal is what sorts the meal list, so it is recorded on the combo.
  if (food.comboId) touchCombo(food.comboId)
  return id
}

function editFood(id: string, patch: Record<string, any>) {
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
}

/**
 * Move a logged entry to another DAY. `date` lives on the entry rather than in
 * `data`, so this is the one edit that cannot go through editFood — and it is
 * the fix for the commonest mistake there is: logging today what you ate
 * yesterday.
 */
function moveEntry(id: string, date: string) {
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
}

/* A tombstone, not a delete: the other device has to hear about it too. */
function tombstone(id: string) {
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
}

const removeFood = (id: string) => tombstone(id)

/* ---------------------------------------------------------------- water */

/*
 * ONE entry per day holding a running total, not one per glass. A glass of
 * water is not a thing with a history worth keeping — nobody asks what time
 * they drank it — and a day's total is what every reader wants. It also means
 * the quick buttons are an increment rather than a write per tap, so a fast
 * six taps is one entry and one sync.
 */
function addWater(date: string | null, oz: number) {
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
}

export interface Targets { kcal: number | null; protein: number | null; carbs: number | null; fat: number | null; water: number | null }

function setTargets(targets: Targets) {
  putEntry({ id: 'targets', kind: 'settings', date: null, data: targets })
}

/* -------------------------------------------------------------- starred */

/*
 * A food he keeps because he USES it, not because he has eaten it yet.
 * Recents answer "what did I have lately"; this answers "the protein powder I
 * buy" — a thing he wants findable in one tap forever, including the first
 * time, and including after a month of not touching it when recents have long
 * since scrolled past. Stored as an entry so it syncs like everything else.
 */
function starFood(food: Food) {
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
}

function unstarFood(food: Food) {
  tombstone(`star-${foodKey(food)}`)
}

/* ---------------------------------------------------------------- meals */

function saveCombo({ id, name, components, meal }: { id?: string; name: string; components: Component[]; meal?: string | null }) {
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
}

const removeCombo = (id: string) => tombstone(id)

function logCombo({ combo, qty, meal, date }: { combo: Combo; qty?: number; meal?: string; date?: string }) {
  const food = comboAsFood(combo)
  return logFood({
    food: { ...food, components: combo.components },
    portion: food.portions[0],
    qty: qty ?? 1,
    meal: meal || combo.meal,
    date,
  })
}

/* --------------------------------------------------------------- readers */

export interface Recent { key: string; food: Food; portion: Portion; qty: number; meal?: string; lastAt?: string; times: number }

function build() {
  const entries = doc.entries

  const t = entries.targets?.data || {}
  const n = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null)
  const targets: Targets = { kcal: n(t.kcal), protein: n(t.protein), carbs: n(t.carbs), fat: n(t.fat), water: n(t.water) }

  const dayItems = (date: string): Item[] => (
    Object.values(entries)
      .filter(e => e && !e.deleted && e.kind === 'food' && e.date === date)
      .sort((a, b) => String(a.data?.at || '').localeCompare(String(b.data?.at || '')))
      .map(e => ({ id: e.id, ...e.data }))
  )

  const waterOn = (date: string) => {
    const e = entries[`water-${date}`]
    return e && !e.deleted ? Math.max(0, Number(e.data?.oz) || 0) : 0
  }

  const combos = listCombos(entries)

  const starred: Food[] = Object.values(entries)
    .filter(e => e && !e.deleted && e.kind === 'star')
    .map(e => e.data)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))

  const starredKeys = new Set(starred.map(s => s.key))
  const isStarred = (food: Partial<Food>) => starredKeys.has(foodKey(food))

  /**
   * Every time he has eaten one particular food, newest first. This is what the
   * product screen is: "when have I had this", answered from the log rather than
   * from a separate index, so it can never disagree with the day it came from.
   */
  const historyFor = (key: string): Item[] => (
    Object.values(entries)
      .filter(e => e && !e.deleted && e.kind === 'food' && foodKey(e.data) === key)
      .map(e => ({ id: e.id, date: e.date as string, ...e.data }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date))
        || String(b.at || '').localeCompare(String(a.at || '')))
  )

  /** One logged entry by id, derived every render. Never held as a copy. */
  const entryById = (id: string): Item | null => {
    const e = entries[id]
    if (!e || e.deleted || e.kind !== 'food') return null
    return { id: e.id, date: e.date as string, ...e.data }
  }

  const recent = (() => {
    const seen = new Map<string, Recent>()
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
      if (seen.has(key)) { seen.get(key)!.times++; continue }
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
  })()

  return {
    doc, entries, sync, targets,
    dayItems, recent, combos, starred, isStarred, historyFor, entryById, waterOn,
    logFood, logCombo, editFood, moveEntry, removeFood, addWater,
    saveCombo, removeCombo, starFood, unstarFood, setTargets, putEntry,
  }
}

let snapshot = build()

export type Store = ReturnType<typeof build>

function subscribe(fn: () => void) { subs.add(fn); return () => { subs.delete(fn) } }

/** The whole store, re-rendering whenever the log or the sync state moves. */
export function useStore(): Store {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
}

/** The store outside React (a writer called from a callback). */
export const getStore = () => snapshot

/* Local copy so store.ts does not import the whole of food.ts for one function. */
function amountOf(portion: Partial<Portion> | null | undefined, qty: number) {
  const q = Number.isFinite(qty) && qty > 0 ? qty : 1
  const s = (v: unknown) => (Number.isFinite(v) ? Math.round((v as number) * q * 10) / 10 : 0)
  return {
    kcal: Number.isFinite(portion?.kcal) ? Math.round((portion!.kcal as number) * q) : 0,
    protein: s(portion?.protein),
    carbs: s(portion?.carbs),
    fat: s(portion?.fat),
  }
}

export { totals }
