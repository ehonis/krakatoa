// Where the Krakatoa server is, and how to prove we're the owner.
//
// The web app is served by the server, so every call there is a relative path
// on the same origin with the session in a cookie. The app has no origin of its
// own: it keeps the server's base URL here, and every request goes through
// apiFetch, which prefixes it. The session comes from signing in with the
// owner's username and password (connect.tsx) and is sent back as
// `X-Krakatoa-Session` (server/auth.js). It lives in the keychain
// (expo-secure-store), never in localStorage, and is cached in memory so
// apiHeaders() stays synchronous for the code ported from the web.
//
// An install with `KRAKATOA_AUTH=proxy` asks for no sign-in: the proxy in front
// is the whole boundary, and the app connects with no session at all.
//
// A server behind Cloudflare Access also needs an Access token (cfAccess.ts). It
// is kept beside the session and sent as `cf-access-token` on every request; when
// Access stops accepting it, `accessNeeded` asks the UI to sign in again.
import * as SecureStore from 'expo-secure-store'
import { useSyncExternalStore } from 'react'
import { Platform } from 'react-native'
import { isAccessResponse } from './cfAccess'
import { pushToast } from './toast'

const BASE_KEY = 'krakatoa.server.base'
const MODE_KEY = 'krakatoa.server.mode'
const SESSION_KEY = 'krakatoa.server.session'
const ACCESS_KEY = 'krakatoa.server.cfAccess'

// expo-secure-store has no web implementation. The web build only exists for
// previewing layouts in a desktop browser, so it keeps the session in localStorage.
const secure = Platform.OS === 'web'
  ? {
      getItemAsync: async (k: string) => localStorage.getItem(k),
      setItemAsync: async (k: string, v: string) => localStorage.setItem(k, v),
      deleteItemAsync: async (k: string) => localStorage.removeItem(k),
    }
  : SecureStore

/** `session`: signed in with the owner's password. `proxy`: the server asks for no sign-in. */
export type AuthMode = 'session' | 'proxy'

export interface Connection {
  baseUrl: string
  mode: AuthMode
  session: string
  /** The owner's username, for Settings. */
  user?: string
  /** Cloudflare Access app token, when the server sits behind Access. */
  accessToken?: string
  /** Access answered a request instead of the server: the token is missing or expired. */
  accessNeeded?: boolean
}

let current: Connection = { baseUrl: '', mode: 'session', session: '' }
let loaded = false
const subs = new Set<() => void>()
const emit = () => subs.forEach((fn) => fn())

/**
 * What was typed, to a base URL with no trailing slash. A full URL is kept. An
 * IP, `localhost`, a bare machine name or a Tailscale/LAN name (`*.ts.net`,
 * `*.local`) is the server itself: http on its port (8101 unless given). Any other
 * domain is a published one (a Cloudflare tunnel, a proxy): https on 443.
 */
export function normalizeBaseUrl(input: string, defaultPort = '8101'): string {
  const raw = String(input || '').trim().replace(/\/+$/g, '')
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw)) return raw
  const host = raw.replace(/:\d+$/, '')
  const hasPort = /:\d+$/.test(raw)
  const direct = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === 'localhost' || !host.includes('.') || /\.(ts\.net|local)$/i.test(host) || hasPort
  if (!direct) return `https://${raw}`
  return `http://${raw}${hasPort ? '' : `:${defaultPort}`}`
}

export async function loadConnection(): Promise<Connection> {
  if (loaded) return current
  const baseUrl = localStorage.getItem(BASE_KEY) || ''
  const mode = (localStorage.getItem(MODE_KEY) as AuthMode) || 'session'
  const user = localStorage.getItem(`${MODE_KEY}.user`) || undefined
  const session = (await secure.getItemAsync(SESSION_KEY).catch(() => null)) || ''
  const accessToken = (await secure.getItemAsync(ACCESS_KEY).catch(() => null)) || ''
  current = { baseUrl, mode, session, user, ...(accessToken ? { accessToken } : {}) }
  loaded = true
  emit()
  return current
}

export async function saveConnection(next: Connection) {
  localStorage.setItem(BASE_KEY, next.baseUrl)
  localStorage.setItem(MODE_KEY, next.mode)
  if (next.user) localStorage.setItem(`${MODE_KEY}.user`, next.user)
  else localStorage.removeItem(`${MODE_KEY}.user`)
  if (next.session) await secure.setItemAsync(SESSION_KEY, next.session)
  else await secure.deleteItemAsync(SESSION_KEY).catch(() => {})
  if (next.accessToken) await secure.setItemAsync(ACCESS_KEY, next.accessToken)
  else await secure.deleteItemAsync(ACCESS_KEY).catch(() => {})
  current = { ...next, accessNeeded: false }
  emit()
}

/** A fresh session after a password change on this device; the old one is dead. */
export async function saveSession(session: string) {
  await secure.setItemAsync(SESSION_KEY, session)
  current = { ...current, session }
  emit()
}

/**
 * Signed out, by the owner or by the server (a 401: the session ran out, or the
 * password changed on another device). Forget the session, keep the address so
 * signing back in is one field.
 */
export async function forgetSession() {
  await secure.deleteItemAsync(SESSION_KEY).catch(() => {})
  current = { ...current, session: '', mode: 'session' }
  localStorage.setItem(MODE_KEY, 'session')
  emit()
}

/** A fresh Access token after signing in again; requests pick it up at once. */
export async function saveAccessToken(token: string) {
  await secure.setItemAsync(ACCESS_KEY, token)
  current = { ...current, accessToken: token, accessNeeded: false }
  emit()
}

/** The headers that prove who we are: the session, and Access's token when there is one. */
export function apiHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return {
    ...(current.session ? { 'x-krakatoa-session': current.session } : {}),
    ...(current.accessToken ? { 'cf-access-token': current.accessToken } : {}),
    ...headers,
  }
}

function markAccessNeeded() {
  if (current.accessNeeded) return
  current = { ...current, accessNeeded: true }
  emit()
}

export const getConnection = () => current
export const getBaseUrl = () => current.baseUrl
export const isConnected = () => Boolean(current.baseUrl && (current.session || current.mode === 'proxy'))

/** An absolute URL for a server path. Absolute URLs pass through untouched. */
export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  return `${current.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`
}

/**
 * fetch() against the server, where the web calls fetch('/api/…'). Adds the
 * session and the Access token, and never uses the cookie jar: the session is
 * the keychain's, and a cookie left behind would outlive signing out.
 *
 * A 401 from /api is the web's installAuthRedirect: the session ended, so back
 * to Connect. Never for the sign-in routes themselves.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const given = init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : { ...(init.headers as Record<string, string> | undefined) }
  const sent = current.session
  const r = await fetch(apiUrl(path), { ...init, credentials: 'omit', headers: apiHeaders(given) })
  if (isAccessResponse(r)) markAccessNeeded()
  // Only the session that was refused is forgotten: a sync that left with the
  // old one while a password change on this phone was swapping it is no reason
  // to sign out.
  else if (r.status === 401 && path.startsWith('/api/') && !path.startsWith('/api/auth/') && current.mode === 'session' && sent && current.session === sent) {
    pushToast('Signed out on the server (the session ended, or the password changed). Sign in again.', 'info')
    void forgetSession()
  }
  return r
}

/** What expo-image needs to load a server image: the URL and the same proof as any request. */
export function imageSource(path: string | null) {
  return path ? { uri: apiUrl(path), headers: apiHeaders() } : null
}

function subscribe(fn: () => void) { subs.add(fn); return () => { subs.delete(fn) } }
export function useConnection(): Connection {
  return useSyncExternalStore(subscribe, getConnection, getConnection)
}
