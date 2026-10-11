/*
 * Krakatoa — talking to the Ask AI threads on the server. See server/aithreads.js.
 *
 * Every run is a thread the server works through by itself, so nothing here
 * waits on a model: starting one returns the thread at once, and the screens
 * read it back — polling while it is working, and on focus otherwise.
 *
 * Ported from app/src/lib/askapi.js. `visibilitychange` is AppState here.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { apiFetch } from './connection'

/* A thread as server/aithreads.js keeps it, and the summary the list shows. */
export type Thread = Record<string, any> & { id: string; status: 'working' | 'ready' | 'error'; turns: any[]; title?: string | null; draft?: any; seenAt?: string; loggedAt?: string; error?: string | null }
export type ThreadSummary = Record<string, any> & { id: string; status: string; title: string; kcal: number; items?: number; photo?: string | null; updatedAt: string; seenAt?: string; loggedAt?: string }

async function json(res: Response): Promise<any> {
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Krakatoa answered ${res.status}.`)
  return body
}

const JSON_HEADERS = { 'content-type': 'application/json' }

export const startThread = ({ text, image }: { text: string; image: string | null }) =>
  apiFetch('/api/ask', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ text, image }) }).then(json)

export const continueThread = (threadId: string, { message, previous }: { message: string; previous: any }) =>
  apiFetch('/api/ask', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ threadId, message, previous }) }).then(json)

export const getThread = (id: string) => apiFetch(`/api/ask/threads/${id}`).then(json)
export const listThreads = () => apiFetch('/api/ask/threads').then(json)
export const updateThread = (id: string, patch: Record<string, any>) =>
  apiFetch(`/api/ask/threads/${id}`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(patch) }).then(json)
export const deleteThread = (id: string) => apiFetch(`/api/ask/threads/${id}`, { method: 'DELETE' }).then(json)
export const photoUrl = (name?: string | null) => (name ? `/api/ask/photo/${name}` : null)

/** The newest AI answer in a thread, or null while there is none. */
export const lastAnswer = (t: Thread | null | undefined): any => [...(t?.turns || [])].reverse().find(x => x.role === 'ai' && x.answer)?.answer || null

/*
 * The thread list, kept fresh: every 3 s while anything is working, every 30 s
 * otherwise, and at once when the app comes back to the foreground — which is
 * the moment he returns from wherever he went while it worked.
 */
export function useThreads({ enabled = true }: { enabled?: boolean } = {}) {
  const [state, setState] = useState<{ threads: ThreadSummary[]; busy: number; loaded: boolean }>({ threads: [], busy: 0, loaded: false })
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
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
      const working = d?.threads?.some((t: ThreadSummary) => t.status === 'working')
      timer.current = setTimeout(loop, working ? 3000 : 30000)
    }
    loop()
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') { clearTimeout(timer.current); loop() } })
    return () => { alive = false; clearTimeout(timer.current); sub.remove() }
  }, [enabled, refresh])

  return { ...state, refresh }
}
