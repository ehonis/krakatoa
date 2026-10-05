/*
 * Krakatoa — single-owner sign-in.
 *
 * One account, the owner, created in the browser on first run. Until it exists,
 * the server prints a one-time setup link with a random token, the way Jupyter
 * and Grafana do, and only that link opens /setup. Someone who can reach the port
 * but cannot read the server's log cannot claim the install.
 *
 *   - The password is hashed with scrypt (node:crypto) and kept in
 *     data/owner.json, mode 0600, with the key that signs sessions.
 *   - A session is a signed, httpOnly, SameSite=Lax cookie. It is Secure when the
 *     request arrived over https (directly, via X-Forwarded-Proto, or because
 *     the public URL is https).
 *   - Every session carries the owner's session version, checked on every
 *     request. Signing out bumps it, which ends every session; changing the
 *     password bumps it and rotates the signing key.
 *   - Machine callers (an MCP gateway, scripts) send `Authorization: Bearer <token>`
 *     with the API token from Settings or the Totem bridge secret.
 *   - KRAKATOA_AUTH=proxy turns all of this off for an install that already sits
 *     behind an authenticating proxy such as Cloudflare Access.
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const COOKIE = 'krakatoa_session'
const SESSION_DAYS = 30
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }

const b64u = (buf) => Buffer.from(buf).toString('base64url')

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p })
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64u(salt)}$${b64u(hash)}`
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, N, r, p, salt, hash] = parts
  const want = Buffer.from(hash, 'base64url')
  const got = crypto.scryptSync(String(password), Buffer.from(salt, 'base64url'), want.length, { N: Number(N), r: Number(r), p: Number(p) })
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

/* Raw cookie values, NOT decoded: a malformed %-sequence in someone else's
   cookie must not throw on every route. Only our own cookie is decoded, in
   readSession, inside a try. */
function parseCookies(header) {
  const out = {}
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

/** Did this request reach us over https, as far as we can honestly tell? */
function isHttps(req, publicUrl = '') {
  if (req.socket?.encrypted) return true
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  if (proto === 'https') return true
  return /^https:/i.test(publicUrl || '')
}

/*
 * A password the owner can live with: long enough to matter, and nothing more
 * clever than that.
 */
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Use at least 10 characters.'
  if (pw.length > 200) return 'That password is too long.'
  return null
}

function makeAuth({ dataDir }) {
  const file = path.join(dataDir, 'owner.json')
  let setupToken = null

  const read = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
  }
  const write = (doc) => {
    fs.mkdirSync(dataDir, { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)
    fs.chmodSync(file, 0o600)
  }

  const hasOwner = () => !!read()?.passwordHash

  /** A new one-time setup token, or null when the owner already exists. */
  function issueSetupToken() {
    if (hasOwner()) { setupToken = null; return null }
    setupToken = crypto.randomBytes(24).toString('base64url')
    return setupToken
  }
  const checkSetupToken = (t) => !!setupToken && !!t && safeEqual(t, setupToken) && !hasOwner()

  function createOwner({ token, username, password }) {
    if (hasOwner()) throw new Error('This install already has an owner.')
    if (!checkSetupToken(token)) throw new Error('That setup link is not valid. Use the one printed in the server log.')
    const name = String(username || '').trim().slice(0, 60)
    if (!name) throw new Error('Choose a username.')
    const problem = passwordProblem(password)
    if (problem) throw new Error(problem)
    write({
      username: name,
      passwordHash: hashPassword(password),
      sessionKey: b64u(crypto.randomBytes(32)),
      sessionVersion: 1,
      createdAt: new Date().toISOString(),
    })
    setupToken = null
    return { username: name }
  }

  function login(username, password) {
    const o = read()
    if (!o?.passwordHash) return null
    // Always run scrypt, so a wrong username takes as long as a wrong password.
    const ok = verifyPassword(password, o.passwordHash)
    return ok && safeEqual(String(username || '').trim().toLowerCase(), o.username.toLowerCase()) ? { username: o.username } : null
  }

  function changePassword(current, next) {
    const o = read()
    if (!o?.passwordHash) throw new Error('There is no owner account yet.')
    if (!verifyPassword(current, o.passwordHash)) throw new Error('The current password is wrong.')
    const problem = passwordProblem(next)
    if (problem) throw new Error(problem)
    write({ ...o, passwordHash: hashPassword(next), sessionKey: b64u(crypto.randomBytes(32)), sessionVersion: (o.sessionVersion || 0) + 1, passwordChangedAt: new Date().toISOString() })
    return { username: o.username }
  }

  /** End every session (sign out). The next cookie issued carries the new version. */
  function revokeSessions() {
    const o = read()
    if (!o?.passwordHash) return
    write({ ...o, sessionVersion: (o.sessionVersion || 0) + 1 })
  }

  const sign = (payload, key) => crypto.createHmac('sha256', key).update(payload).digest('base64url')

  /** The cookie value for a fresh session. */
  function issueSession(username, now = Date.now()) {
    const o = read()
    if (!o?.sessionKey) throw new Error('no owner')
    const payload = b64u(JSON.stringify({ u: username, v: o.sessionVersion || 0, exp: now + SESSION_DAYS * 864e5 }))
    return `${payload}.${sign(payload, o.sessionKey)}`
  }

  /** The signed-in user from a request's cookies, or null. */
  function readSession(req, now = Date.now()) {
    const raw = parseCookies(req.headers?.cookie)[COOKIE]
    if (!raw) return null
    let value
    try { value = decodeURIComponent(raw) } catch { return null }
    const [payload, mac] = value.split('.')
    const o = read()
    if (!payload || !mac || !o?.sessionKey) return null
    if (!safeEqual(mac, sign(payload, o.sessionKey))) return null
    try {
      const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
      if (!body.exp || body.exp < now) return null
      if ((body.v || 0) !== (o.sessionVersion || 0)) return null
      return { username: body.u }
    } catch {
      return null
    }
  }

  function cookie(value, { secure, clear = false } = {}) {
    const attrs = [`${COOKIE}=${clear ? '' : encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax']
    attrs.push(clear ? 'Max-Age=0' : `Max-Age=${SESSION_DAYS * 86400}`)
    if (secure) attrs.push('Secure')
    return attrs.join('; ')
  }

  /** `Authorization: Bearer x` against the tokens currently accepted. */
  function bearerOk(req, tokens) {
    const m = String(req.headers?.authorization || '').match(/^Bearer\s+(.+)$/i)
    if (!m) return false
    return tokens.filter(Boolean).some(t => safeEqual(m[1].trim(), t))
  }

  const owner = () => { const o = read(); return o ? { username: o.username } : null }

  return { file, hasOwner, owner, issueSetupToken, checkSetupToken, createOwner, login, changePassword, revokeSessions, issueSession, readSession, cookie, bearerOk }
}

/*
 * Failed sign-ins. Per address: ten in fifteen minutes and that address waits.
 * Globally: a hundred in fifteen minutes from everyone together and sign-in
 * pauses for all, which is what stops a guesser who rotates addresses. In
 * memory on purpose (a restart forgives), and bounded: expired entries are
 * swept, and past `maxKeys` addresses the oldest are dropped.
 */
function makeLimiter({ max = 10, globalMax = 100, windowMs = 15 * 60 * 1000, maxKeys = 5000 } = {}) {
  const hits = new Map()
  let all = []
  const prune = (k, now) => {
    const list = (hits.get(k) || []).filter(t => now - t < windowMs)
    if (list.length) hits.set(k, list); else hits.delete(k)
    return list
  }
  const sweep = (now) => {
    all = all.filter(t => now - t < windowMs)
    for (const k of [...hits.keys()]) prune(k, now)
    while (hits.size > maxKeys) hits.delete(hits.keys().next().value)
  }
  return {
    blocked: (k, now = Date.now()) => {
      all = all.filter(t => now - t < windowMs)
      return all.length >= globalMax || prune(k, now).length >= max
    },
    fail: (k, now = Date.now()) => {
      const prev = hits.get(k) || []
      hits.delete(k) // re-insert, so Map order is least-recently-failed first
      hits.set(k, [...prev, now])
      all.push(now)
      if (hits.size > maxKeys || all.length % 50 === 0) sweep(now)
    },
    reset: (k) => hits.delete(k),
    size: () => hits.size,
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
/** Is the TCP peer this machine? (cloudflared and local reverse proxies are.) */
const isLoopback = (addr) => LOOPBACK.has(String(addr || '')) || /^127\./.test(String(addr || '')) || /^::ffff:127\./.test(String(addr || ''))

module.exports = { makeAuth, makeLimiter, hashPassword, verifyPassword, parseCookies, isHttps, isLoopback, passwordProblem, COOKIE }
