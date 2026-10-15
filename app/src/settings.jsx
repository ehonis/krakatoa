/*
 * Krakatoa — Settings.
 *
 * Everything a new install needs, set up in the browser: the account, the AI,
 * the food-database keys, and the optional connections to Bushido (WHOOP) and a
 * Totem bridge (the habit push). Each
 * section saves on its own. A field set by the server's environment is shown
 * locked with the variable's name, because the environment always wins and an
 * editable box that changes nothing is a lie. Stored secrets never come back
 * from the server; a secret box shows the masked value as its placeholder, and
 * typing replaces it.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  X, Check, CircleAlert, Loader2, KeyRound, LogOut, Copy, Sparkles, Plug, ShieldCheck, Wheat,
} from 'lucide-react'
import { loadServerInfo } from './lib/server.js'
import { CHANNEL, signOutDevice } from './lib/signout.js'

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `The server answered ${res.status}.`)
  return data
}

/* ------------------------------------------------------------------ pieces */

function Field({ id, label, f, value, onChange, placeholder, hint, type = 'text' }) {
  if (!f) return null
  const locked = f.locked
  const shown = locked ? f.value : value
  return (
    <section className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="text-input"
        type={f.secret ? 'password' : type}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        disabled={locked}
        value={shown ?? ''}
        placeholder={value === null ? 'Removed when you save' : f.secret && f.set ? `Saved (${f.value}). Type to replace.` : placeholder}
        onChange={e => onChange(e.target.value)}
      />
      {f.secret && f.set && f.from === 'settings' && !locked && value !== null && (
        <button type="button" className="link sm set-remove" onClick={() => onChange(null)}>Remove the saved key</button>
      )}
      {locked
        ? <p className="set-hint">{f.from === 'env'
          ? <>Set by <code>{f.env}</code> in the server's environment.</>
          : <>Read-only here, because the server runs or reads this path. Change it with <code>{f.env}</code> in the server's environment, or in <code>data/settings.json</code>.</>}</p>
        : hint && <p className="set-hint">{hint}</p>}
    </section>
  )
}

function Toggle({ label, on, locked, env, onChange, hint }) {
  return (
    <section className="field">
      <label className="set-toggle">
        <input type="checkbox" checked={!!on} disabled={locked} onChange={e => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
      {locked ? <p className="set-hint">Set by <code>{env}</code> in the server's environment.</p> : hint && <p className="set-hint">{hint}</p>}
    </section>
  )
}

function Result({ r }) {
  if (!r) return null
  if (r.busy) return <p className="set-result muted"><Loader2 className="spin" size={14} /> {r.busy}</p>
  return (
    <p className={`set-result ${r.ok ? 'ok' : 'bad'}`}>
      {r.ok ? <Check size={14} /> : <CircleAlert size={14} />} {r.detail}
    </p>
  )
}

function Status({ ok, children }) {
  return (
    <li className={`set-status ${ok === true ? 'ok' : ok === false ? 'bad' : ''}`}>
      {ok === true ? <Check size={14} /> : ok === false ? <CircleAlert size={14} /> : <span className="dot" />}
      <span>{children}</span>
    </li>
  )
}

/*
 * One section's edits: only fields the owner touched are sent, so saving the AI
 * section cannot blank a key in another, and an untouched secret is never sent
 * back as its own mask.
 */
function useDraft() {
  const [draft, setDraft] = useState({})
  const set = (section, key) => (v) => setDraft(d => ({ ...d, [section]: { ...(d[section] || {}), [key]: v } }))
  const get = (section, key, fallback = '') => draft[section]?.[key] ?? fallback
  const clear = (section) => setDraft(d => { const n = { ...d }; delete n[section]; return n })
  return { draft, set, get, clear }
}

/* ----------------------------------------------------------------- account */

function Account({ s }) {
  const [form, setForm] = useState({ current: '', next: '', again: '' })
  const [result, setResult] = useState(null)
  const [leaving, setLeaving] = useState(false)
  const [signOutError, setSignOutError] = useState(null)
  if (s.auth.mode === 'proxy') {
    return (
      <section className="set-section">
        <h3 className="list-head"><ShieldCheck size={16} /> Account</h3>
        <p className="muted">
          Sign-in is handled by the proxy in front of this server (<code>KRAKATOA_AUTH=proxy</code>). Krakatoa itself asks for no password.
        </p>
      </section>
    )
  }
  const change = async () => {
    if (form.next !== form.again) return setResult({ ok: false, detail: 'The two new passwords do not match.' })
    setResult({ busy: 'Changing…' })
    try {
      await api('/api/auth/password', { method: 'POST', body: { current: form.current, next: form.next } })
      setForm({ current: '', next: '', again: '' })
      setResult({ ok: true, detail: 'Changed. Other devices are signed out.' })
    } catch (e) {
      setResult({ ok: false, detail: e.message })
    }
  }
  const signOut = async () => {
    setLeaving(true)
    const out = await signOutDevice({
      fetchFn: window.__krakatoaRawFetch || window.fetch.bind(window),
      storage: window.localStorage,
      session: window.sessionStorage,
      cachesApi: window.caches,
      idb: window.indexedDB,
      confirmFn: (msg) => window.confirm(msg),
      flagTarget: window,
      channel: window.BroadcastChannel ? new window.BroadcastChannel(CHANNEL) : null,
    })
    if (out.signedOut) return window.location.assign('/login')
    setLeaving(false)
    if (out.error) setSignOutError(out.error)
  }
  return (
    <section className="set-section">
      <h3 className="list-head"><ShieldCheck size={16} /> Account</h3>
      <p className="muted">Signed in as <b>{s.owner?.username}</b>.</p>
      <details className="set-details">
        <summary>Change password</summary>
        <section className="field">
          <label htmlFor="pw-cur">Current password</label>
          <input id="pw-cur" className="text-input" type="password" autoComplete="current-password" value={form.current} onChange={e => setForm(f => ({ ...f, current: e.target.value }))} />
        </section>
        <section className="field">
          <label htmlFor="pw-new">New password (at least 10 characters)</label>
          <input id="pw-new" className="text-input" type="password" autoComplete="new-password" value={form.next} onChange={e => setForm(f => ({ ...f, next: e.target.value }))} />
        </section>
        <section className="field">
          <label htmlFor="pw-again">New password again</label>
          <input id="pw-again" className="text-input" type="password" autoComplete="new-password" value={form.again} onChange={e => setForm(f => ({ ...f, again: e.target.value }))} />
        </section>
        <button className="btn" disabled={!form.current || form.next.length < 10} onClick={change}><KeyRound size={16} /> Change password</button>
        <Result r={result} />
      </details>
      <button className="btn btn-quiet" disabled={leaving} onClick={signOut}>
        {leaving ? <Loader2 className="spin" size={16} /> : <LogOut size={16} />} {signOutError ? 'Try signing out again' : 'Sign out'}
      </button>
      {signOutError && <p className="set-result bad"><CircleAlert size={14} /> {signOutError}</p>}
      <p className="set-hint">Signing out also removes the log from this device. Anything not yet synced is sent first.</p>
    </section>
  )
}

/* ---------------------------------------------------------------------- AI */

function AISection({ s, d, save, test }) {
  const [status, setStatus] = useState(null)
  const [result, setResult] = useState(null)
  const checkStatus = useCallback(() => {
    setStatus(null)
    api('/api/settings/ai/status').then(setStatus).catch(e => setStatus({ error: e.message }))
  }, [])
  useEffect(() => { checkStatus() }, [checkStatus])
  const ai = s.ai
  const effort = d.get('ai', 'askEffort', ai.askEffort.value)

  const onSave = async () => {
    setResult({ busy: 'Saving…' })
    try { await save('ai'); setResult({ ok: true, detail: 'Saved.' }); checkStatus() } catch (e) { setResult({ ok: false, detail: e.message }) }
  }
  const onTest = async () => {
    setResult({ busy: 'Asking the model for a one-word reply…' })
    setResult(await test('ai'))
  }

  return (
    <section className="set-section" id="set-ai">
      <h3 className="list-head"><Sparkles size={16} /> AI</h3>
      <p className="muted">
        Reading a nutrition label from a photo and Ask AI both run the AI on this server. Everything else works without it.
      </p>
      <section className="field">
        <label htmlFor="ai-backend">Backend</label>
        <select id="ai-backend" className="text-input" value={ai.backend} disabled>
          {ai.backends.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <p className="set-hint">The only backend Krakatoa drives today. It runs <code>claude</code> headlessly, with its tools restricted by flag.</p>
      </section>

      <ul className="set-statuses">
        {!status ? <Status><Loader2 className="spin" size={14} /> Checking the CLI…</Status> : status.error ? <Status ok={false}>{status.error}</Status> : (
          <>
            <Status ok={status.installed}>{status.installed ? <>Installed at <code>{status.bin}</code>{status.version ? ` (${status.version})` : ''}</> : <>Not found at <code>{status.bin}</code></>}</Status>
            {status.installed && (
              <Status ok={status.signedIn}>
                {status.signedIn === true ? `Signed in${status.method ? ` (${status.method})` : ''}` : status.signedIn === false ? 'Not signed in' : 'Sign-in unknown. Use Test to check.'}
              </Status>
            )}
          </>
        )}
      </ul>
      {status && !status.installed && (
        <p className="set-hint left">
          Install it on the server with <code>npm install -g @anthropic-ai/claude-code</code>, then either run <code>claude</code> once
          as the user this server runs as and sign in, or paste an Anthropic API key below. If it lives somewhere else, set <code>CLAUDE_BIN</code> for the server.
        </p>
      )}
      {status?.installed && status.signedIn === false && (
        <p className="set-hint left">Run <code>claude</code> once on the server as the user Krakatoa runs as and sign in, or paste an Anthropic API key below.</p>
      )}

      <Field id="ai-bin" label="Path to claude" f={ai.bin} value={ai.bin.value} onChange={() => {}} />
      <Field id="ai-key" label="Anthropic API key (optional)" f={ai.apiKey} value={d.get('ai', 'apiKey')} onChange={d.set('ai', 'apiKey')}
        placeholder="sk-ant-…" hint="Passed to the CLI as ANTHROPIC_API_KEY. Not needed if the CLI is signed in." />
      <Field id="ai-label" label="Model for reading labels" f={ai.labelModel} value={d.get('ai', 'labelModel', ai.labelModel.from === 'settings' ? ai.labelModel.value : '')}
        onChange={d.set('ai', 'labelModel')} placeholder={ai.labelModel.value} />
      <Field id="ai-ask" label="Model for Ask AI" f={ai.askModel} value={d.get('ai', 'askModel', ai.askModel.from === 'settings' ? ai.askModel.value : '')}
        onChange={d.set('ai', 'askModel')} placeholder={ai.askModel.value} hint="Blank uses the label model." />
      <section className="field">
        <label>Ask AI effort</label>
        <div className="chips" role="radiogroup" aria-label="Effort">
          {['low', 'medium', 'high'].map(x => (
            <button key={x} role="radio" aria-checked={effort === x} disabled={ai.askEffort.locked}
              className={`chip ${effort === x ? 'on' : ''}`} onClick={() => d.set('ai', 'askEffort')(x)}>{x}</button>
          ))}
        </div>
        {ai.askEffort.locked && <p className="set-hint">Set by <code>{ai.askEffort.env}</code> in the server's environment.</p>}
      </section>
      <div className="row-btns">
        <button className="btn" onClick={onTest}>Test</button>
        <button className="btn btn-primary" disabled={!d.draft.ai} onClick={onSave}>Save</button>
      </div>
      <Result r={result} />
    </section>
  )
}

/* ---------------------------------------------------------------- databases */

function Databases({ s, d, save, test }) {
  const [usda, setUsda] = useState(null)
  const [nix, setNix] = useState(null)
  const run = (section, setR) => async (doTest) => {
    setR({ busy: doTest ? 'Testing…' : 'Saving…' })
    try {
      if (d.draft[section]) await save(section)
      setR(doTest ? await test(section) : { ok: true, detail: 'Saved.' })
    } catch (e) { setR({ ok: false, detail: e.message }) }
  }
  return (
    <section className="set-section">
      <h3 className="list-head"><Wheat size={16} /> Food databases</h3>
      <p className="muted">Open Food Facts needs no key. USDA works without one too, on a shared key limited to about 30 requests an hour.</p>
      <Field id="usda-key" label="USDA FoodData Central API key" f={s.usda.key} value={d.get('usda', 'key')} onChange={d.set('usda', 'key')}
        placeholder="Free from fdc.nal.usda.gov" hint={<>Free at <a href="https://fdc.nal.usda.gov/api-key-signup.html" target="_blank" rel="noreferrer">fdc.nal.usda.gov</a>. Lifts the limit to 1,000 an hour.</>} />
      <div className="row-btns">
        <button className="btn" onClick={() => run('usda', setUsda)(true)}>{d.draft.usda ? 'Save and test' : 'Test'}</button>
      </div>
      <Result r={usda} />

      <Field id="nix-id" label="Nutritionix app ID (optional)" f={s.nutritionix.id} value={d.get('nutritionix', 'id', s.nutritionix.id.from === 'settings' ? s.nutritionix.id.value : '')}
        onChange={d.set('nutritionix', 'id')} placeholder="Not connected" />
      <Field id="nix-key" label="Nutritionix app key" f={s.nutritionix.key} value={d.get('nutritionix', 'key')} onChange={d.set('nutritionix', 'key')}
        placeholder="Not connected" hint="Business accounts only. The built-in chain menus do not need it." />
      <div className="row-btns">
        <button className="btn" onClick={() => run('nutritionix', setNix)(true)}>{d.draft.nutritionix ? 'Save and test' : 'Test'}</button>
      </div>
      <Result r={nix} />
    </section>
  )
}

/* ------------------------------------------------------------- connections */

/* WHOOP's burn, read from Bushido, which holds the WHOOP grant. On when it has
   a URL and a token; there is no switch, because there is no default URL. */
function BushidoLink({ s, d, save, test }) {
  const [result, setResult] = useState(null)
  const b = s.bushido
  if (!b) return null
  const onSave = async (doTest) => {
    setResult({ busy: doTest ? 'Connecting…' : 'Saving…' })
    try {
      if (d.draft.bushido) await save('bushido')
      setResult(doTest ? await test('bushido') : { ok: true, detail: 'Saved.' })
    } catch (e) { setResult({ ok: false, detail: e.message }) }
  }
  return (
    <section className="set-section">
      <h3 className="list-head"><Plug size={16} /> WHOOP, through Bushido (optional)</h3>
      <p className="muted">
        For people who also run Bushido, the training app that holds the WHOOP connection. With a Bushido URL and token, the day
        shows WHOOP's calorie burn beside what you ate. Without them, Krakatoa never contacts it and the energy panel is hidden.
      </p>
      <p className="set-pill-row">
        <span className={`set-pill ${b.connected ? 'ok' : ''}`}>{b.connected ? 'Connected' : 'Not connected'}</span>
      </p>
      <Field id="bushido-url" label="Bushido URL" f={b.url} value={d.get('bushido', 'url', b.url.from === 'settings' ? b.url.value : '')}
        onChange={d.set('bushido', 'url')} placeholder={b.url.value || 'http://127.0.0.1:8099'}
        hint={d.draft.bushido?.url !== undefined ? 'A new URL needs its own token: enter it below. The old one is not sent to a new address.' : null} />
      <Field id="bushido-token" label="Bushido API token" f={b.token} value={d.get('bushido', 'token')} onChange={d.set('bushido', 'token')}
        placeholder="Bushido's API token" />
      <div className="row-btns">
        <button className="btn" disabled={!b.connected && !d.draft.bushido} onClick={() => onSave(true)}>{d.draft.bushido ? 'Save and connect' : 'Test'}</button>
        <button className="btn btn-primary" disabled={!d.draft.bushido} onClick={() => onSave(false)}>Save</button>
      </div>
      <Result r={result} />
    </section>
  )
}

function Connections({ s, d, save, test, saveNow }) {
  const [result, setResult] = useState(null)
  const t = s.totem
  const enabled = d.get('totem', 'enabled', t.enabled.value)
  const onSave = async (doTest) => {
    setResult({ busy: doTest ? 'Connecting…' : 'Saving…' })
    try {
      if (d.draft.totem) await save('totem')
      setResult(doTest ? await test('totem') : { ok: true, detail: 'Saved.' })
    } catch (e) { setResult({ ok: false, detail: e.message }) }
  }
  return (
    <section className="set-section">
      <h3 className="list-head"><Plug size={16} /> Totem bridge (optional)</h3>
      <p className="muted">
        For people who also run Totem, a personal assistant. With the bridge on, each logged day is written to a Totem habit.
        Off, Krakatoa never contacts it.
      </p>
      <p className="set-pill-row">
        <span className={`set-pill ${t.connected ? 'ok' : ''}`}>{t.connected ? 'Connected' : 'Not connected'}</span>
      </p>
      <Toggle label="Use the Totem bridge" on={enabled} locked={t.enabled.locked} env="KRAKATOA_TOTEM" onChange={d.set('totem', 'enabled')} />
      {enabled && (
        <>
          <Field id="totem-url" label="Bridge URL" f={t.url} value={d.get('totem', 'url', t.url.from === 'settings' ? t.url.value : '')}
            onChange={d.set('totem', 'url')} placeholder={t.url.value}
            hint={d.draft.totem?.url !== undefined ? 'A new URL needs its own secret: enter it below. The old one is not sent to a new address.' : null} />
          <Field id="totem-secret" label="Bridge secret" f={t.secret} value={d.get('totem', 'secret')} onChange={d.set('totem', 'secret')}
            placeholder="Totem's BRIDGE_SECRET" hint={t.secret.from === 'totem .env' ? "Read from Totem's .env. Type one here to override it." : null} />
          {t.envFile.set && <Field id="totem-env" label="Totem .env file (the secret is read from it)" f={t.envFile} value={t.envFile.value} onChange={() => {}} />}
          <Field id="totem-habit" label="Habit id" f={t.habit} value={d.get('totem', 'habit', t.habit.from === 'settings' ? t.habit.value : '')}
            onChange={d.set('totem', 'habit')} placeholder={t.habit.value} hint="Create it once with node server/totem.js --ensure." />
        </>
      )}
      <div className="row-btns">
        <button className="btn" disabled={!enabled} onClick={() => onSave(true)}>{d.draft.totem ? 'Save and connect' : 'Test'}</button>
        <button className="btn btn-primary" disabled={!d.draft.totem} onClick={() => onSave(false)}>Save</button>
      </div>
      <Result r={result} />

      <Toggle
        label="Write data/digest.json after every change"
        on={s.digestFile.value}
        locked={s.digestFile.locked}
        env="KRAKATOA_DIGEST_FILE"
        onChange={(v) => saveNow({ digestFile: v })}
        hint="A small read-only summary of the last two weeks, for other tools on this server to read instead of the whole log."
      />
    </section>
  )
}

/* ---------------------------------------------------------------- machines */

function Access({ s, d, save, saveNow }) {
  const [token, setToken] = useState(null)
  const [result, setResult] = useState(null)
  const generate = async () => {
    if (s.apiToken.set && !window.confirm('Replace the API token? Anything using the old one stops working.')) return
    try {
      const out = await api('/api/settings/token', { method: 'POST', body: {} })
      setToken(out.token)
      saveNow(null)
    } catch (e) { setResult({ ok: false, detail: e.message }) }
  }
  const onSave = async () => {
    setResult({ busy: 'Saving…' })
    try { await save('publicUrl'); setResult({ ok: true, detail: 'Saved.' }) } catch (e) { setResult({ ok: false, detail: e.message }) }
  }
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return (
    <section className="set-section">
      <h3 className="list-head"><KeyRound size={16} /> Access for other programs</h3>
      <p className="muted">
        An MCP client or a script can use Krakatoa with <code>Authorization: Bearer &lt;token&gt;</code>. The MCP endpoint is <code>{origin}/mcp</code>.
      </p>
      {s.apiToken.locked
        ? <p className="set-hint left">The token is set by <code>KRAKATOA_API_TOKEN</code> in the server's environment.</p>
        : (
          <>
            <p className="set-pill-row"><span className={`set-pill ${s.apiToken.set ? 'ok' : ''}`}>{s.apiToken.set ? `Token set (${s.apiToken.value})` : 'No token'}</span></p>
            <button className="btn" onClick={generate}>{s.apiToken.set ? 'Replace the token' : 'Create a token'}</button>
          </>
        )}
      {token && (
        <div className="set-token">
          <p className="set-hint left">Copy it now. It is not shown again.</p>
          <code>{token}</code>
          <button className="btn btn-quiet" onClick={() => navigator.clipboard?.writeText(token)}><Copy size={14} /> Copy</button>
        </div>
      )}
      <Field id="public-url" label="Public URL (optional)" f={s.publicUrl} value={d.get('publicUrl', 'v', s.publicUrl.from === 'settings' ? s.publicUrl.value : '')}
        onChange={d.set('publicUrl', 'v')} placeholder={origin}
        hint="The address people use to reach this server. Used for the setup link in the log, and marks cookies Secure when it is https." />
      <div className="row-btns">
        <button className="btn btn-primary" disabled={!d.draft.publicUrl} onClick={onSave}>Save</button>
      </div>
      <Result r={result} />
    </section>
  )
}

/* ------------------------------------------------------------------ screen */

export default function SettingsPane({ section = null, onClose }) {
  const [s, setS] = useState(null)
  const [error, setError] = useState(null)
  const d = useDraft()

  const reload = useCallback(() => api('/api/settings').then(setS).catch(e => setError(e.message)), [])
  useEffect(() => { reload() }, [reload])
  useEffect(() => {
    if (s && section) document.getElementById(`set-${section}`)?.scrollIntoView({ block: 'start' })
  }, [s, section])

  /* Save one section's draft. `publicUrl` is a single value kept under `v`. */
  const save = async (section) => {
    const patch = section === 'publicUrl' ? { publicUrl: d.draft.publicUrl?.v ?? null } : { [section]: d.draft[section] }
    const next = await api('/api/settings', { method: 'PUT', body: patch })
    setS(next)
    d.clear(section)
    loadServerInfo({ force: true })
  }
  const saveNow = async (patch) => {
    if (patch) setS(await api('/api/settings', { method: 'PUT', body: patch }))
    else await reload()
    loadServerInfo({ force: true })
  }
  const test = (what) => api('/api/settings/test', { method: 'POST', body: { what } }).catch(e => ({ ok: false, detail: e.message }))

  return (
    <div className="pane">
      <header className="pane-head">
        <h2>Settings</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={24} /></button>
      </header>
      <div className="pane-body settings">
        {error && <p className="lbl-error"><CircleAlert size={14} /> {error}</p>}
        {!s && !error && <div className="pane-center"><Loader2 className="spin" size={28} /></div>}
        {s && (
          <>
            <Account s={s} />
            <AISection s={s} d={d} save={save} test={test} />
            <Databases s={s} d={d} save={save} test={test} />
            <BushidoLink s={s} d={d} save={save} test={test} />
            <Connections s={s} d={d} save={save} test={test} saveNow={saveNow} />
            <Access s={s} d={d} save={save} saveNow={saveNow} />
          </>
        )}
      </div>
    </div>
  )
}
