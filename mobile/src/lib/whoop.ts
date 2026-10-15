/*
 * Krakatoa — what WHOOP says he burned, client side.
 *
 * Fetched once on open and then left alone: the number moves over hours, not
 * seconds, and a poll would be a request every few minutes for a figure that
 * changes a handful of times a day. The server refreshes its own cache in the
 * background, so a reload is as current as anything needs to be.
 *
 * `refresh` is the exception, and it is a BUTTON. It is the one synchronous path
 * to Bushido — everything else serves the cache and refetches behind itself —
 * because the case it exists for is standing there having just finished a
 * workout, wanting the number to catch up now rather than within twenty minutes.
 *
 * Ported from app/src/lib/whoop.js. One copy for the app, not one per screen: the
 * web fetches it once in App, and so does this, the first time anything asks.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { apiFetch } from './connection'

export interface Whoop {
  burn?: Record<string, { kcal: number; strain?: number }>
  fetchedAt?: string
  error?: string
  configured?: boolean
  [k: string]: any
}

let shared: Whoop | null = null
let asked = false
const subs = new Set<() => void>()
const setShared = (w: Whoop | null) => { shared = w; subs.forEach(fn => fn()) }
const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn) } }

/** Forget it (signing out), so the next owner's server is asked afresh. */
export function resetWhoop() { asked = false; setShared(null) }

export function useWhoop() {
  const whoop = useSyncExternalStore(subscribe, () => shared, () => shared)
  const setWhoop = (fn: Whoop | null | ((prev: Whoop | null) => Whoop)) => setShared(typeof fn === 'function' ? fn(shared) : fn)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    if (asked) return
    asked = true
    apiFetch('/api/whoop')
      .then(r => r.json())
      .then(d => setShared(d))
      // WHOOP being unreachable is not an error worth a screen. The balance line
      // simply is not there, which is the same as the day before this existed.
      .catch(() => { asked = false })
  }, [])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = await apiFetch('/api/whoop/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      // The server ALWAYS answers with a document, even on a failed pull — the
      // previous cache survives and carries an `error` alongside it. So this
      // takes whatever came back rather than treating a failure as nothing:
      // yesterday's burn is still yesterday's burn.
      setWhoop(await res.json())
    } catch (e: any) {
      setWhoop(prev => ({ ...(prev || { burn: {} }), error: String(e.message || e) }))
    } finally {
      setRefreshing(false)
    }
  }, [])

  return { whoop, refresh, refreshing }
}

/**
 * Eaten against burned, for one day. A DELIBERATE duplicate of `balanceFor` in
 * server/whoop.js — the server is CommonJS with no build step and this is an ES
 * module inside Vite, the same split `lib/food.js` documents. `whoop.test.js`
 * pins the two against the same cases.
 */
export interface Balance { date: string; burned: number; strain?: number; eaten: number; net: number; partial: boolean; untracked: boolean; typical: number | null }

export function balanceFor(whoop: Whoop | null | undefined, date: string, eaten: number, today: string): Balance | null {
  const row = whoop?.burn?.[date]
  if (!row) return null

  const complete = Object.entries(whoop!.burn || {})
    .filter(([d]) => d !== today)
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
    partial: date === today,
    untracked: ate === 0,
    typical,
  }
}
