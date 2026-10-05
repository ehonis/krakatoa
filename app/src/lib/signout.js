/*
 * Krakatoa — signing out of this device.
 *
 * The log lives on the device as well as the server (offline first, lib/store.js),
 * so signing out has to take it off the device, or the next person to open the
 * browser reads it without a password. In order:
 *
 *   0. FREEZE. A `krakatoa.signingOut` marker (and a BroadcastChannel message)
 *      stops every tab writing the log to storage, so what is read next is
 *      everything this device holds. Lifted again if sign-out does not happen;
 *      a freeze older than two minutes (a tab that died mid-sign-out) is ignored.
 *   1. FLUSH what is in storage after the freeze. Push every local entry; the server merges newest-wins, so pushing
 *      all of them is safe. Then count what the server still does not have.
 *   2. ASK, only if something would be lost: say how many entries (or that the
 *      server could not be reached), and stop if the answer is no.
 *   3. SIGN OUT on the server, which also sends Clear-Site-Data: "cache" for the
 *      HTTP-cached photos. Only a 2xx (or a 401: already signed out) counts. If
 *      the server did not confirm, the session is still valid and clearing the
 *      device would gain nothing, so nothing is cleared and the caller offers a
 *      retry.
 *   4. MARK every tab signed out (a `krakatoa.signedOut` key, plus a
 *      BroadcastChannel message), so another tab's sync landing late cannot
 *      write the log back. The marker is removed on the next sign-in.
 *   5. CLEAR this app's localStorage/sessionStorage keys, any IndexedDB database,
 *      and any Cache Storage cache other than the app shell (which holds only
 *      index.html and the built assets, never /api).
 *
 * Proxy mode has no sign-out, so none of this runs there.
 *
 * Every browser API is passed in, so lib tests can run it under node.
 */

export const STORAGE_PREFIXES = ['krakatoa.', 'fuel.state']
export const SHELL_CACHE_PREFIX = 'krakatoa-shell'

/** Set while signing out, so a late store write cannot put the log back. */
export const SIGNED_OUT_FLAG = '__krakatoaSignedOut'
/** Shared by every tab through localStorage; survives the clear below. */
export const SIGNED_OUT_KEY = 'krakatoa.signedOut'
export const CHANNEL = 'krakatoa-auth'
/** Set by the tab that is signing out, from before its last read until it finishes. */
export const SIGNING_OUT_KEY = 'krakatoa.signingOut'
const FREEZE_MS = 2 * 60 * 1000

function frozen(storage, now = Date.now()) {
  try {
    const at = Date.parse(storage?.getItem(SIGNING_OUT_KEY) || '')
    return Number.isFinite(at) && now - at < FREEZE_MS
  } catch { return false }
}

/** Is this tab, or any tab sharing this storage, signed out or signing out? */
export function isSignedOut(storage, flagTarget) {
  if (flagTarget?.[SIGNED_OUT_FLAG]) return true
  try { if (storage?.getItem(SIGNED_OUT_KEY)) return true } catch { return false }
  return frozen(storage)
}

/**
 * The store's localStorage write, refusing once signed out. Every tab's store
 * writes through one of these, so a sync that lands after another tab signed
 * out is dropped instead of putting the log back.
 */
export function makeLocalPersist({ storage, flagTarget, key }) {
  return (doc) => {
    if (isSignedOut(storage, flagTarget)) return false
    try { storage.setItem(key, JSON.stringify(doc)); return true } catch { return false }
  }
}

/** A sign-in happened: this device may keep a log again. */
export function clearSignedOut(storage, flagTarget) {
  try { storage?.removeItem(SIGNED_OUT_KEY); storage?.removeItem(SIGNING_OUT_KEY) } catch { /* nothing to clear */ }
  if (flagTarget) delete flagTarget[SIGNED_OUT_FLAG]
}

/**
 * Call `fn` when another tab signs out: a BroadcastChannel message, or the
 * marker key appearing (the `storage` event, for browsers without channels).
 * Returns a function that stops listening.
 */
export function onSignedOutElsewhere({ win, fn }) {
  const offs = []
  if (win?.BroadcastChannel) {
    const ch = new win.BroadcastChannel(CHANNEL)
    ch.onmessage = (m) => { if (m?.data === 'signed-out') fn() }
    offs.push(() => ch.close())
  }
  if (win?.addEventListener) {
    const onStorage = (e) => { if (e.key === SIGNED_OUT_KEY && e.newValue) fn() }
    win.addEventListener('storage', onStorage)
    offs.push(() => win.removeEventListener('storage', onStorage))
  }
  return () => offs.forEach(off => off())
}

function localEntries(storage) {
  for (const key of ['krakatoa.state.v1', 'fuel.state.v1']) {
    try {
      const raw = storage?.getItem(key)
      if (raw) return JSON.parse(raw)?.entries || {}
    } catch { /* unreadable: treat as empty */ }
  }
  return {}
}

/** Local entries the server does not have, or has an older copy of. */
export function unsyncedCount(local, server) {
  let n = 0
  for (const [id, e] of Object.entries(local || {})) {
    if (!e || typeof e !== 'object') continue
    const s = server?.[id]
    if (!s || String(e.updatedAt || '') > String(s.updatedAt || '')) n++
  }
  return n
}

export function lossMessage(count) {
  if (count === null) {
    return 'Krakatoa cannot reach the server, so anything logged on this device since it last synced will be deleted from this device. Sign out anyway?'
  }
  return `${count} ${count === 1 ? 'entry has' : 'entries have'} not reached the server yet and will be deleted from this device. Sign out anyway?`
}

async function serverEntries(fetchFn, entries) {
  const json = { 'content-type': 'application/json', accept: 'application/json' }
  try {
    const res = await fetchFn('/api/state', { method: 'PUT', headers: json, body: JSON.stringify({ state: { entries } }) })
    if (res.ok) return (await res.json())?.state?.entries || {}
  } catch { /* offline: try a read */ }
  try {
    const res = await fetchFn('/api/state', { headers: { accept: 'application/json' } })
    if (res.ok) return (await res.json())?.state?.entries || {}
  } catch { /* offline */ }
  return null
}

/** Remove everything this app keeps on the device except the static shell. */
export async function clearDeviceData({ storage, session, cachesApi, idb } = {}) {
  for (const s of [storage, session]) {
    if (!s) continue
    const keys = []
    for (let i = 0; i < s.length; i++) keys.push(s.key(i))
    for (const k of keys) if (k && k !== SIGNED_OUT_KEY && STORAGE_PREFIXES.some(p => k.startsWith(p))) s.removeItem(k)
  }
  if (cachesApi) {
    for (const name of await cachesApi.keys().catch(() => [])) {
      if (!name.startsWith(SHELL_CACHE_PREFIX)) await cachesApi.delete(name).catch(() => {})
    }
  }
  if (idb?.databases) {
    for (const db of await idb.databases().catch(() => [])) {
      if (db?.name) idb.deleteDatabase(db.name)
    }
  }
}

/**
 * The whole sign-out. Resolves `{ signedOut: true, unsynced }`;
 * `{ signedOut: false, unsynced }` when the user chose to keep their entries;
 * or `{ signedOut: false, error }` when the server did not confirm (retryable,
 * nothing cleared).
 */
export async function signOutDevice({ fetchFn, storage, session, cachesApi, idb, confirmFn, flagTarget, channel }) {
  // Freeze every tab's writes BEFORE reading, so an entry another tab logs
  // during the flush or the logout cannot slip in after the count.
  try { storage?.setItem(SIGNING_OUT_KEY, new Date().toISOString()) } catch { /* best effort */ }
  try { channel?.postMessage('signing-out') } catch { /* the key is enough */ }
  const thaw = () => {
    try { storage?.removeItem(SIGNING_OUT_KEY) } catch { /* gone */ }
    try { channel?.postMessage('resumed') } catch { /* the key is enough */ }
  }

  const local = localEntries(storage)
  const server = Object.keys(local).length ? await serverEntries(fetchFn, local) : {}
  const unsynced = server === null ? null : unsyncedCount(local, server)
  if (unsynced !== 0 && !confirmFn(lossMessage(unsynced))) { thaw(); return { signedOut: false, unsynced } }

  let res
  try {
    res = await fetchFn('/api/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: '{}',
    })
  } catch {
    thaw()
    return { signedOut: false, unsynced, error: 'Sign-out did not reach the server, so you are still signed in and nothing was removed from this device. Try again.' }
  }
  if (!res.ok && res.status !== 401) {
    thaw()
    return { signedOut: false, unsynced, error: `Sign-out did not reach the server (it answered ${res.status}), so you are still signed in and nothing was removed from this device. Try again.` }
  }

  if (flagTarget) flagTarget[SIGNED_OUT_FLAG] = true
  try { storage?.setItem(SIGNED_OUT_KEY, new Date().toISOString()) } catch { /* the flag still covers this tab */ }
  try { channel?.postMessage('signed-out') } catch { /* other tabs still see the key */ }
  await clearDeviceData({ storage, session, cachesApi, idb })
  return { signedOut: true, unsynced }
}
