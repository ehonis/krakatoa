/*
 * Krakatoa — signing out of this device. Ported from app/src/lib/signout.js.
 *
 * The log lives on the phone as well as the server (offline first, lib/store.ts),
 * so signing out has to take it off the phone, or the next person to open the
 * app reads it without a password. In order, as on the web:
 *
 *   0. FREEZE the store's writes, so what is read next is everything this device
 *      holds. Lifted again if sign-out does not happen; after it does, kept until
 *      the next sign-in (startSync), so a late sync cannot write the log back.
 *   1. FLUSH: push every local entry (the server merges newest-wins, so pushing
 *      all of them is safe), then count what the server still does not have.
 *   2. ASK, only if something would be lost: say how many entries (or that the
 *      server could not be reached), and stop if the answer is no.
 *   3. SIGN OUT on the server, which ends the session for every copy of it. Only a
 *      2xx (or a 401: already signed out) counts. If the server did not confirm,
 *      the session is still valid and clearing the phone would gain nothing, so
 *      nothing is cleared and the caller offers a retry.
 *   4. CLEAR this app's `krakatoa.*` localStorage keys and forget the session in
 *      the keychain (the address stays, so signing back in is one field).
 *
 * The web's other half (a marker every TAB reads, a BroadcastChannel) has no
 * counterpart: the phone has one copy of the app. Proxy mode has no sign-out.
 */

import { apiFetch, forgetSession } from './connection'
import { LOCAL_KEY, flushAll, freezeWrites, resetStore } from './store'
import { resetServerInfo } from './server'
import { resetWhoop } from './whoop'
import type { Entry } from './types'

export const STORAGE_PREFIX = 'krakatoa.'
/** Kept through a sign-out: where the server is, and how it signs in. */
const KEEP = new Set(['krakatoa.server.base', 'krakatoa.server.mode', 'krakatoa.server.mode.user'])

/** Local entries the server does not have, or has an older copy of. */
export function unsyncedCount(local: Record<string, Entry>, server: Record<string, Entry> | null) {
  let n = 0
  for (const [id, e] of Object.entries(local || {})) {
    if (!e || typeof e !== 'object') continue
    const s = server?.[id]
    if (!s || String(e.updatedAt || '') > String(s.updatedAt || '')) n++
  }
  return n
}

export function lossMessage(count: number | null) {
  if (count === null) {
    return 'Krakatoa cannot reach the server, so anything logged on this phone since it last synced will be deleted from this phone. Sign out anyway?'
  }
  return `${count} ${count === 1 ? 'entry has' : 'entries have'} not reached the server yet and will be deleted from this phone. Sign out anyway?`
}

function localEntries(): Record<string, Entry> {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null')?.entries || {} } catch { return {} }
}

/** Remove everything this app keeps on the phone but the address. */
export function clearDeviceData() {
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i) || '')
  for (const k of keys) if (k.startsWith(STORAGE_PREFIX) && !KEEP.has(k)) localStorage.removeItem(k)
}

/**
 * The whole sign-out. Resolves `{ signedOut: true, unsynced }`;
 * `{ signedOut: false, unsynced }` when he chose to keep his entries;
 * or `{ signedOut: false, error }` when the server did not confirm (retryable,
 * nothing cleared).
 */
export async function signOutDevice({ confirmFn }: { confirmFn: (message: string) => Promise<boolean> }): Promise<{ signedOut: boolean; unsynced?: number | null; error?: string }> {
  freezeWrites(true)
  const local = localEntries()
  const server = Object.keys(local).length ? await flushAll() : {}
  const unsynced = server === null ? null : unsyncedCount(local, server)
  if (unsynced !== 0 && !(await confirmFn(lossMessage(unsynced)))) { freezeWrites(false); return { signedOut: false, unsynced } }

  let res: Response
  try {
    res = await apiFetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: '{}',
    })
  } catch {
    freezeWrites(false)
    return { signedOut: false, unsynced, error: 'Sign-out did not reach the server, so you are still signed in and nothing was removed from this phone. Try again.' }
  }
  if (!res.ok && res.status !== 401) {
    freezeWrites(false)
    return { signedOut: false, unsynced, error: `Sign-out did not reach the server (it answered ${res.status}), so you are still signed in and nothing was removed from this phone. Try again.` }
  }

  // Still frozen: a sync answered before the logout must not write the log back.
  // startSync lifts it on the next sign-in.
  clearDeviceData()
  resetStore()
  resetServerInfo()
  resetWhoop()
  await forgetSession()
  return { signedOut: true, unsynced }
}
