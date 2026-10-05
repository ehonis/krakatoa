/*
 * Krakatoa — what the server says about itself: who is signed in, how sign-in
 * works on this install, and which features are configured. Fetched once and
 * shared, then fetched again when Settings saves, so a screen that offers AI
 * knows whether AI is set up before anyone taps it.
 */

import { useEffect, useState } from 'react'
import { clearSignedOut } from './signout.js'

let info = null
let inFlight = null
const listeners = new Set()

export function loadServerInfo({ force = false } = {}) {
  if (info && !force) return Promise.resolve(info)
  if (inFlight && !force) return inFlight
  inFlight = fetch('/api/me')
    .then(r => (r.ok ? r.json() : null))
    .then(d => {
      if (d) {
        // Signed in again (or never signing in, behind a proxy): this device
        // may keep a log again. See lib/signout.js.
        if (d.user || d.authMode === 'proxy') clearSignedOut(window.localStorage, window)
        info = d
        for (const fn of listeners) fn(info)
      }
      return info
    })
    // Offline: keep what we had. Nothing here is worth an error on screen.
    .catch(() => info)
    .finally(() => { inFlight = null })
  return inFlight
}

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

/** Ask the shell to open Settings, at a section. Any screen can call it. */
export function openSettings(section = null) {
  window.dispatchEvent(new CustomEvent('krakatoa:settings', { detail: { section } }))
}

/*
 * A signed-out request answers 401. The session ran out or the password was
 * changed on another device, so go to the sign-in page and come back here.
 * Only for this origin's /api, and never for the sign-in routes themselves.
 */
export function installAuthRedirect() {
  if (typeof window === 'undefined' || window.__krakatoaAuth) return
  window.__krakatoaAuth = true
  const original = window.fetch.bind(window)
  // Sign-out must finish clearing even when the session has already expired,
  // so it uses the fetch that does not redirect on 401.
  window.__krakatoaRawFetch = original
  window.fetch = async (input, init) => {
    const res = await original(input, init)
    if (res.status === 401) {
      const url = new URL(typeof input === 'string' ? input : input.url, window.location.href)
      if (url.origin === window.location.origin && url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/auth/')) {
        const next = window.location.pathname + window.location.search
        window.location.assign(`/login?next=${encodeURIComponent(next)}`)
      }
    }
    return res
  }
}
