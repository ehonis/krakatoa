/*
 * Krakatoa — what the server says about itself: who is signed in, how sign-in
 * works on this install, and which features are configured. Fetched once and
 * shared, then fetched again when Settings saves, so a screen that offers AI
 * knows whether AI is set up before anyone taps it.
 *
 * Ported from app/src/lib/server.js. The 401 redirect is apiFetch's job here
 * (lib/connection.ts), and openSettings opens the Settings sheet.
 */

import { useEffect, useState } from 'react'
import { router } from 'expo-router'
import { apiFetch } from './connection'

export interface ServerInfo {
  user: string | null
  authMode: 'builtin' | 'proxy' | string
  features: { ai?: boolean; whoop?: boolean; totem?: boolean; usda?: boolean; nutritionix?: boolean }
}

let info: ServerInfo | null = null
let inFlight: Promise<ServerInfo | null> | null = null
const listeners = new Set<(i: ServerInfo) => void>()

export function loadServerInfo({ force = false } = {}): Promise<ServerInfo | null> {
  if (info && !force) return Promise.resolve(info)
  if (inFlight && !force) return inFlight
  inFlight = apiFetch('/api/me')
    .then(r => (r.ok ? r.json() : null))
    .then(d => {
      if (d) {
        info = d
        for (const fn of listeners) fn(d)
      }
      return info
    })
    // Offline: keep what we had. Nothing here is worth an error on screen.
    .catch(() => info)
    .finally(() => { inFlight = null })
  return inFlight
}

/** Forget it (signing out), so the next sign-in asks again. */
export function resetServerInfo() { info = null }

/** `{ user, authMode, features: { ai, whoop, totem, usda, nutritionix } }`, or null until known. */
export function useServerInfo() {
  const [state, setState] = useState(info)
  useEffect(() => {
    listeners.add(setState)
    loadServerInfo().then(d => { if (d) setState(d) })
    return () => { listeners.delete(setState) }
  }, [])
  return state
}

/** Open Settings, at a section. Any screen can call it. */
export function openSettings(section: string | null = null) {
  router.push({ pathname: '/settings', params: section ? { section } : {} })
}
