/*
 * Krakatoa — talking to the Ask AI threads on the server. See server/aithreads.js.
 *
 * Every run is a thread the server works through by itself, so nothing here
 * waits on a model: starting one returns the thread at once, and the screens
 * read it back — polling while it is working, and on focus otherwise.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

async function json(res) {
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Krakatoa answered ${res.status}.`)
  return body
}

export const startThread = ({ text, image }) =>
  fetch('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, image }) }).then(json)

export const continueThread = (threadId, { message, previous }) =>
  fetch('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId, message, previous }) }).then(json)

export const getThread = (id) => fetch(`/api/ask/threads/${id}`).then(json)
export const listThreads = () => fetch('/api/ask/threads').then(json)
export const updateThread = (id, patch) =>
  fetch(`/api/ask/threads/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }).then(json)
export const deleteThread = (id) => fetch(`/api/ask/threads/${id}`, { method: 'DELETE' }).then(json)
export const photoUrl = (name) => (name ? `/api/ask/photo/${name}` : null)

/** The newest AI answer in a thread, or null while there is none. */
export const lastAnswer = (t) => [...(t?.turns || [])].reverse().find(x => x.role === 'ai' && x.answer)?.answer || null

/*
 * The thread list, kept fresh: every 3 s while anything is working, every 30 s
 * otherwise, and at once when the app comes back to the foreground — which is
 * the moment he returns from wherever he went while it worked.
 */
export function useThreads({ enabled = true } = {}) {
  const [state, setState] = useState({ threads: [], busy: 0, loaded: false })
  const timer = useRef(null)
  const refresh = useCallback(async () => {
    try {
      const d = await listThreads()
      setState({ threads: d.threads || [], busy: d.busy || 0, loaded: true })
      return d
    } catch {
      setState(s => ({ ...s, loaded: true }))
      return null
    }
  }, [])

  useEffect(() => {
    if (!enabled) return undefined
    let alive = true
    const loop = async () => {
      const d = await refresh()
      if (!alive) return
      const working = d?.threads?.some(t => t.status === 'working')
      timer.current = setTimeout(loop, working ? 3000 : 30000)
    }
    loop()
    const wake = () => { if (document.visibilityState === 'visible') { clearTimeout(timer.current); loop() } }
    document.addEventListener('visibilitychange', wake)
    return () => { alive = false; clearTimeout(timer.current); document.removeEventListener('visibilitychange', wake) }
  }, [enabled, refresh])

  return { ...state, refresh }
}
