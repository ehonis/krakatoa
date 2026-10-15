/*
 * Krakatoa — settings: what the owner configures in the browser.
 *
 * One file, `data/settings.json`, written 0600 because it can hold keys. Three
 * layers, in order of precedence:
 *
 *   1. The environment. An env var always wins, so an install configured by
 *      systemd or docker keeps working exactly as configured, and Settings shows
 *      the field as "set by the environment" instead of letting it be edited.
 *   2. data/settings.json, written by the Settings screen.
 *   3. data/config.json, the older file that held the USDA and Nutritionix keys.
 *      It is still read, never written, so an install that predates Settings
 *      keeps its keys without a migration step.
 *
 * FRESH INSTALL vs EXISTING INSTALL. Everything that reaches another app (the
 * Totem bridge's habit push; WHOOP burn read from Bushido; the digest file
 * Bushido reads) is OFF for a fresh install. An install that already has a log
 * is an existing one, and the first time this code runs there it writes
 * settings.json with the bridge and the digest ON, because that is how it
 * already behaved. Bushido has no on switch of its own: it is on when it has a
 * URL and a token, and nothing is migrated for it. If it also has no owner
 * account it predates sign-in, so sign-in is left to the proxy it was behind.
 * An owner account means sign-in was already in use: never proxy then.
 * Nobody upgrading should find their setup quietly switched off.
 *
 * Stored secrets never go back to the browser. `publicView` masks them.
 */

const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

const run = (bin, args, opts) => new Promise((resolve, reject) => {
  execFile(bin, args, { ...opts, maxBuffer: 256 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))))
})

const FILE = 'settings.json'
const LEGACY_CONFIG = 'config.json'

const DEFAULTS = {
  labelModel: 'claude-sonnet-5',
  askEffort: 'medium',
  totemUrl: 'http://127.0.0.1:8787',
  totemHabit: 'krakatoa',
}

/* The AI backends the code actually drives. Only one: every AI feature runs the
   Claude Code CLI headlessly with its own flags (see label.js and ai.js). */
const AI_BACKENDS = [{ id: 'claude-cli', name: 'Claude Code CLI', keyEnv: 'ANTHROPIC_API_KEY' }]

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function writePrivate(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
  fs.chmodSync(file, 0o600)
}

const str = (v) => (typeof v === 'string' ? v.trim() : '')
const flag = (v) => {
  if (v === undefined || v === null || v === '') return undefined
  return /^(1|true|on|yes)$/i.test(String(v))
}

/** Find `claude` the way a shell would, falling back to the CLI's default install path. */
function findClaude(env) {
  const home = env.HOME || ''
  const dflt = path.join(home, '.local/bin/claude')
  if (fs.existsSync(dflt)) return dflt
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const p = path.join(dir, 'claude')
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch { /* keep looking */ }
  }
  return dflt
}

function makeSettings({ dataDir, env = process.env, log = console.log }) {
  const file = path.join(dataDir, FILE)

  /*
   * First run of this code against a data dir. A log already there means an
   * existing install: keep what it did. Nothing there means a fresh one: off.
   */
  function migrate() {
    if (fs.existsSync(file)) return { created: false }
    const existing = fs.existsSync(path.join(dataDir, 'state.json'))
    const hasOwner = fs.existsSync(path.join(dataDir, 'owner.json'))
    let doc = { version: 1, createdAt: new Date().toISOString() }
    if (existing) {
      doc = { version: 1, totem: { enabled: true }, digestFile: true, migratedAt: new Date().toISOString() }
      if (!hasOwner) doc.auth = { mode: 'proxy' }
      // Where an install from before Settings read its bridge secret. Recorded
      // only when that file is really there; there is no default any more.
      const legacyEnv = path.join(env.HOME || '', 'projects', 'personal-assistant', '.env')
      if (!str(env.KRAKATOA_TOTEM_ENV) && env.HOME && fs.existsSync(legacyEnv)) doc.totem.envFile = legacyEnv
    }
    writePrivate(file, doc)
    if (existing) log(`[krakatoa] existing install: ${hasOwner ? 'built-in sign-in kept' : 'sign-in left to the proxy'}; Totem bridge and digest file kept on (data/settings.json)`)
    return { created: true, existing, auth: doc.auth?.mode || 'builtin' }
  }

  const stored = () => readJson(file) || { version: 1 }
  const legacy = () => readJson(path.join(dataDir, LEGACY_CONFIG)) || {}

  /** Merge a patch into the stored file. `null` or '' clears a field. */
  function save(patch) {
    const doc = stored()
    for (const [section, value] of Object.entries(patch || {})) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const cur = { ...(doc[section] || {}) }
        for (const [k, v] of Object.entries(value)) {
          if (v === null || v === '') delete cur[k]
          else cur[k] = v
        }
        doc[section] = cur
      } else if (value === null || value === '') {
        delete doc[section]
      } else {
        doc[section] = value
      }
    }
    doc.version = 1
    doc.updatedAt = new Date().toISOString()
    writePrivate(file, doc)
    return doc
  }

  /*
   * What the server actually uses, and where each value came from. Read fresh
   * on every call so a change in Settings takes effect without a restart.
   */
  function effective() {
    const s = stored()
    const old = legacy()
    const src = (envName, storedVal, legacyVal) => {
      if (str(env[envName])) return { value: str(env[envName]), from: 'env', env: envName }
      if (str(storedVal)) return { value: str(storedVal), from: 'settings', env: envName }
      if (str(legacyVal)) return { value: str(legacyVal), from: 'config.json', env: envName }
      return { value: '', from: null, env: envName }
    }

    const authEnv = str(env.KRAKATOA_AUTH).toLowerCase()
    const auth = authEnv
      ? { mode: authEnv === 'proxy' ? 'proxy' : 'builtin', from: 'env' }
      : { mode: s.auth?.mode === 'proxy' ? 'proxy' : 'builtin', from: s.auth?.mode ? 'settings' : null }

    const bin = src('CLAUDE_BIN', s.ai?.bin)
    if (!bin.value) { bin.value = findClaude(env); bin.from = 'default' }
    const labelModel = src('KRAKATOA_LABEL_MODEL', s.ai?.labelModel)
    if (!labelModel.value) { labelModel.value = DEFAULTS.labelModel; labelModel.from = 'default' }
    const askModel = src('KRAKATOA_ASK_MODEL', s.ai?.askModel)
    if (!askModel.value) { askModel.value = labelModel.value; askModel.from = 'default' }
    const askEffort = src('KRAKATOA_ASK_EFFORT', s.ai?.askEffort)
    if (!askEffort.value) { askEffort.value = DEFAULTS.askEffort; askEffort.from = 'default' }
    // An API key in the server's own environment reaches the CLI anyway; one
    // stored in Settings is passed through to the CLI's environment.
    const apiKey = src('ANTHROPIC_API_KEY', s.ai?.apiKey)

    const usda = src('KRAKATOA_USDA_KEY', s.usda?.key, old.usdaKey)
    const nixId = src('KRAKATOA_NUTRITIONIX_ID', s.nutritionix?.id, old.nutritionixId)
    const nixKey = src('KRAKATOA_NUTRITIONIX_KEY', s.nutritionix?.key, old.nutritionixKey)

    /*
     * The Totem bridge. On when KRAKATOA_TOTEM says so, or when a bridge URL is
     * in the environment, or when Settings has it on. Its secret is BRIDGE_SECRET,
     * or the one stored here, or the BRIDGE_SECRET= line of Totem's own .env.
     */
    const totemFlag = flag(env.KRAKATOA_TOTEM)
    const totemEnabled = totemFlag !== undefined
      ? { value: totemFlag, from: 'env' }
      : str(env.KRAKATOA_TOTEM_URL)
        ? { value: true, from: 'env' }
        : { value: !!s.totem?.enabled, from: s.totem?.enabled !== undefined ? 'settings' : 'default' }
    const totemUrl = src('KRAKATOA_TOTEM_URL', s.totem?.url)
    if (!totemUrl.value) { totemUrl.value = DEFAULTS.totemUrl; totemUrl.from = 'default' }
    const totemEnvFile = src('KRAKATOA_TOTEM_ENV', s.totem?.envFile)
    /*
     * The secret. A secret from the environment or Totem's .env belongs to the
     * bridge URL it was set up with. When the URL is changed in Settings to
     * something else, `ownSecretOnly` is set and only a secret entered for the
     * new URL is sent, so a URL change cannot carry the old secret to a new host.
     */
    const ownSecretOnly = s.totem?.ownSecretOnly === true
    const totemSecret = ownSecretOnly
      ? (str(s.totem?.secret) ? { value: str(s.totem.secret), from: 'settings', env: 'BRIDGE_SECRET' } : { value: '', from: null, env: 'BRIDGE_SECRET' })
      : src('BRIDGE_SECRET', s.totem?.secret)
    if (!totemSecret.value && totemEnabled.value && !ownSecretOnly && totemEnvFile.value) {
      const fromFile = secretFromEnvFile(totemEnvFile.value)
      if (fromFile) { totemSecret.value = fromFile; totemSecret.from = 'totem .env' }
    }
    const totemHabit = src('KRAKATOA_TOTEM_HABIT', s.totem?.habit)
    if (!totemHabit.value) { totemHabit.value = DEFAULTS.totemHabit; totemHabit.from = 'default' }

    /*
     * Bushido, the one holder of the owner's WHOOP grant. On when it has a URL
     * and a token, from the environment or Settings; there is no default URL,
     * so an install that never names one never contacts it. As with the bridge,
     * a token from the environment belongs to the URL it was set up with:
     * changing the URL in Settings sets `ownTokenOnly`.
     */
    const bushidoUrl = src('BUSHIDO_API_URL', s.bushido?.url)
    const bushidoOwnTokenOnly = s.bushido?.ownTokenOnly === true
    const bushidoToken = bushidoOwnTokenOnly
      ? (str(s.bushido?.token) ? { value: str(s.bushido.token), from: 'settings', env: 'BUSHIDO_API_TOKEN' } : { value: '', from: null, env: 'BUSHIDO_API_TOKEN' })
      : src('BUSHIDO_API_TOKEN', s.bushido?.token)

    const digestFlag = flag(env.KRAKATOA_DIGEST_FILE)
    const digestFile = digestFlag !== undefined
      ? { value: digestFlag, from: 'env' }
      : { value: !!s.digestFile, from: s.digestFile !== undefined ? 'settings' : 'default' }

    const publicUrl = src('KRAKATOA_PUBLIC_URL', s.publicUrl)
    const apiToken = src('KRAKATOA_API_TOKEN', s.apiToken)

    return {
      auth,
      ai: { backend: 'claude-cli', bin, labelModel, askModel, askEffort, apiKey },
      usda,
      nutritionix: { id: nixId, key: nixKey },
      totem: { enabled: totemEnabled, url: totemUrl, envFile: totemEnvFile, secret: totemSecret, habit: totemHabit, ownSecretOnly },
      bushido: { url: bushidoUrl, token: bushidoToken, ownTokenOnly: bushidoOwnTokenOnly },
      digestFile,
      publicUrl,
      apiToken,
    }
  }

  return { file, migrate, stored, save, effective }
}

function secretFromEnvFile(file) {
  try {
    const line = fs.readFileSync(file, 'utf8').split('\n').find(l => l.startsWith('BRIDGE_SECRET='))
    return line ? line.slice('BRIDGE_SECRET='.length).trim().replace(/^["']|["']$/g, '') : ''
  } catch {
    return ''
  }
}

/* -------------------------------------------------------- what code reads */

/** The env the CLI is started with: the server's own, plus a stored API key. */
function aiEnv(eff) {
  const key = eff.ai.apiKey
  return key.value && key.from === 'settings' ? { ...process.env, ANTHROPIC_API_KEY: key.value } : undefined
}

/** The bridge config, or null when the bridge is off or has no secret. */
function totemConfig(eff) {
  const t = eff.totem
  if (!t.enabled.value || !t.secret.value) return null
  return { url: t.url.value.replace(/\/+$/, ''), secret: t.secret.value, habit: t.habit.value }
}

/** Where WHOOP is read from: Bushido's `{ url, token }`, or null when it has no URL or no token. */
function bushidoConfig(eff) {
  const b = eff.bushido
  if (!b?.url.value || !b.token.value) return null
  return { url: b.url.value.replace(/\/+$/, ''), token: b.token.value }
}

/* -------------------------------------------------------- for the browser */

/* The last four characters, enough to tell two keys apart and no more. */
function mask(v) {
  if (!v) return ''
  return v.length <= 8 ? '••••' : `••••${v.slice(-4)}`
}

/** A field as the browser may see it: secrets masked, plus where it came from. */
function field(f, secret = false, readOnly = false) {
  return { value: secret ? mask(f.value) : f.value, set: !!f.value, from: f.from, env: f.env || null, locked: readOnly || f.from === 'env', readOnly, secret }
}

function publicView(eff) {
  return {
    auth: { mode: eff.auth.mode, locked: eff.auth.from === 'env' },
    ai: {
      backend: eff.ai.backend,
      backends: AI_BACKENDS,
      bin: field(eff.ai.bin, false, true),
      labelModel: field(eff.ai.labelModel),
      askModel: field(eff.ai.askModel),
      askEffort: field(eff.ai.askEffort),
      apiKey: field(eff.ai.apiKey, true),
    },
    usda: { key: field(eff.usda, true) },
    nutritionix: { id: field(eff.nutritionix.id), key: field(eff.nutritionix.key, true) },
    totem: {
      enabled: { value: eff.totem.enabled.value, from: eff.totem.enabled.from, locked: eff.totem.enabled.from === 'env' },
      url: field(eff.totem.url),
      envFile: field(eff.totem.envFile, false, true),
      secret: field(eff.totem.secret, true),
      habit: field(eff.totem.habit),
      connected: !!totemConfig(eff),
    },
    bushido: {
      url: field(eff.bushido.url),
      token: field(eff.bushido.token, true),
      connected: !!bushidoConfig(eff),
    },
    digestFile: { value: eff.digestFile.value, from: eff.digestFile.from, locked: eff.digestFile.from === 'env' },
    publicUrl: field(eff.publicUrl),
    apiToken: field(eff.apiToken, true),
  }
}

/*
 * What the browser is allowed to change, and how. Anything not listed here is
 * ignored, so a crafted PUT cannot write auth mode or arbitrary keys. A masked
 * value coming back unchanged is not a new secret and is dropped.
 *
 * Paths the server will EXECUTE or READ (the CLI binary, Totem's .env) are not
 * in this list at all: they come from env or a hand-edited settings file only,
 * so a browser session cannot point the server at a program or a file.
 */
const EDITABLE = {
  ai: { labelModel: 'text', askModel: 'text', askEffort: ['low', 'medium', 'high'], apiKey: 'secret' },
  usda: { key: 'secret' },
  nutritionix: { id: 'text', key: 'secret' },
  totem: { enabled: 'bool', url: 'url', secret: 'secret', habit: 'text' },
  bushido: { url: 'url', token: 'secret' },
  digestFile: 'bool',
  publicUrl: 'url',
}

function cleanPatch(body) {
  const out = {}
  const one = (kind, v) => {
    if (v === null || v === '') return { ok: true, v: null }
    if (kind === 'bool') return typeof v === 'boolean' ? { ok: true, v } : { ok: false }
    if (typeof v !== 'string') return { ok: false }
    const s = v.trim().slice(0, 500)
    if (kind === 'secret' && s.includes('•')) return { ok: false } // the mask came back
    if (kind === 'url' && !/^https?:\/\/[^\s]+$/i.test(s)) return { ok: false, error: `not a URL: ${s}` }
    if (Array.isArray(kind) && !kind.includes(s)) return { ok: false }
    return { ok: true, v: s }
  }
  for (const [section, spec] of Object.entries(EDITABLE)) {
    if (!(section in (body || {}))) continue
    if (typeof spec === 'string') {
      const r = one(spec, body[section])
      if (r.error) throw new Error(r.error)
      if (r.ok) out[section] = r.v
      continue
    }
    const val = body[section] || {}
    const sec = {}
    for (const [k, kind] of Object.entries(spec)) {
      if (!(k in val)) continue
      const r = one(kind, val[k])
      if (r.error) throw new Error(r.error)
      if (r.ok) sec[k] = r.v
    }
    if (Object.keys(sec).length) out[section] = sec
  }
  return out
}

/*
 * A changed (or cleared) URL drops any secret it did not come with: for the
 * bridge the stored one, BRIDGE_SECRET and Totem's .env; for Bushido the stored
 * token and BUSHIDO_API_TOKEN. All of them belong to the old URL. Only a secret
 * in the same patch goes with the new URL. Returns the patch to save.
 */
function guardUrl(patch, current, section, secretKey, onlyKey) {
  if (!patch?.[section] || !('url' in patch[section])) return patch
  const url = patch[section].url
  // Clearing a stored URL sends the requests somewhere else too (the env value
  // or the default), so it is a change of destination like any other. Clearing
  // when nothing was stored changes nothing.
  if (url === null) {
    if (current.from !== 'settings') return patch
  } else if (url.replace(/\/+$/, '') === current.value.replace(/\/+$/, '')) {
    return patch
  }
  const next = { ...patch[section], [onlyKey]: true }
  if (!(secretKey in patch[section])) next[secretKey] = null
  return { ...patch, [section]: next }
}

const guardTotemUrl = (patch, eff) => guardUrl(patch, eff.totem.url, 'totem', 'secret', 'ownSecretOnly')
const guardBushidoUrl = (patch, eff) => guardUrl(patch, eff.bushido.url, 'bushido', 'token', 'ownTokenOnly')

/** Every URL guard, for the Settings PUT. */
const guardUrls = (patch, eff) => guardBushidoUrl(guardTotemUrl(patch, eff), eff)

/* ------------------------------------------------------------- AI status */

/**
 * Is the CLI there, and is it signed in? `claude auth status` answers in JSON.
 * Only `loggedIn` and the method travel to the browser, not the account details.
 */
async function aiStatus(eff) {
  const bin = eff.ai.bin.value
  const out = { backend: 'claude-cli', bin, installed: false, version: null, signedIn: null, method: null, apiKey: !!eff.ai.apiKey.value }
  try {
    fs.accessSync(bin, fs.constants.X_OK)
    out.installed = true
  } catch {
    return out
  }
  const env = aiEnv(eff) || process.env
  try {
    out.version = (await run(bin, ['--version'], { timeout: 10000, env })).trim().slice(0, 80)
  } catch { /* an old CLI or a wrapper; the test run is the real check */ }
  try {
    const raw = await run(bin, ['auth', 'status'], { timeout: 15000, env })
    const j = JSON.parse(raw)
    out.signedIn = !!j.loggedIn
    out.method = j.authMethod || null
  } catch {
    // Not every version has `auth status`; an API key counts as signed in.
    out.signedIn = out.apiKey ? true : null
  }
  if (out.apiKey) { out.signedIn = true; out.method = out.method || 'api key' }
  return out
}

/** Whether the AI features should offer themselves at all. Cheap: no process spawned. */
function aiReady(eff) {
  try { fs.accessSync(eff.ai.bin.value, fs.constants.X_OK); return true } catch { return false }
}

module.exports = { makeSettings, publicView, cleanPatch, guardTotemUrl, guardBushidoUrl, guardUrls, aiEnv, aiStatus, aiReady, totemConfig, bushidoConfig, mask, secretFromEnvFile, AI_BACKENDS }
