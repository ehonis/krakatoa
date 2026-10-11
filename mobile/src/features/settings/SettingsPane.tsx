/*
 * Krakatoa — Settings. Ported from app/src/settings.jsx.
 *
 * Everything a new install needs, set up from the app: the account, the AI,
 * the food-database keys, and the optional connection to a Totem bridge. Each
 * section saves on its own. A field set by the server's environment is shown
 * locked with the variable's name, because the environment always wins and an
 * editable box that changes nothing is a lie. Stored secrets never come back
 * from the server; a secret box shows the masked value as its placeholder, and
 * typing replaces it.
 *
 * Native differences: this is its own page sheet (route /settings, optional
 * `section` param to scroll to); confirms are system alerts; <details> is a
 * tap-to-open row; the token is copied with expo-clipboard; links open in the
 * in-app browser. Account also says which server this phone talks to, which the
 * web never needs to (it is served by it).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ScrollView, StyleSheet, Switch, View, type LayoutChangeEvent } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import * as WebBrowser from 'expo-web-browser'
import { Pane } from '../../ui/Pane'
import { T } from '../../ui/Text'
import { Btn, Chip, Chips, Input, Link, ListHead, Press, RowBtns, Spin } from '../../ui/kit'
import { confirm } from '../../ui/menu'
import { success } from '../../ui/haptics'
import { colors, radius } from '../../theme'
import {
  Check, ChevronDown, CircleAlert, Copy, KeyRound, LogOut, Plug, ShieldCheck, Sparkles, Wheat,
} from '../../lib/icons'
import { loadServerInfo } from '../../lib/server'
import { apiFetch, saveSession, useConnection } from '../../lib/connection'
import { signOutDevice } from '../../lib/signout'

async function api(path: string, { method = 'GET', body, headers }: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<any> {
  const res = await apiFetch(path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' }), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `The server answered ${res.status}.`)
  return data
}

type Res = { busy: string; ok?: undefined; detail?: undefined } | { ok: boolean; detail: string; busy?: undefined } | null

/* ------------------------------------------------------------------ pieces */

/** `<code>`: monospace on the panel-2 tint, inline in a line of text. */
function Code({ children, size = 12 }: { children: React.ReactNode; size?: number }) {
  return <T size={size} style={st.code}>{children}</T>
}

/** .set-hint */
function SetHint({ children, left }: { children: React.ReactNode; left?: boolean }) {
  return <T size={12} muted lineHeight={18} align={left ? 'left' : undefined}>{children}</T>
}

/** .set-section: a block with a rule under it (but the last). */
function Section({ children, last, onLayout }: { children: React.ReactNode; last?: boolean; onLayout?: (e: LayoutChangeEvent) => void }) {
  return <View onLayout={onLayout} style={[st.section, last && { borderBottomWidth: 0 }]}>{children}</View>
}

/** .set-section > .muted */
function Lead({ children }: { children: React.ReactNode }) {
  return <T size={14} muted lineHeight={21}>{children}</T>
}

function Label({ children }: { children: React.ReactNode }) {
  return <T size={13} caps muted>{children}</T>
}

function Field({ label, f, value, onChange, placeholder, hint }: {
  label: string
  f: any
  value: string | null
  onChange: (v: string | null) => void
  placeholder?: string
  hint?: React.ReactNode
}) {
  if (!f) return null
  const locked = f.locked
  const shown = locked ? f.value : value
  return (
    <View style={{ gap: 8 }}>
      <Label>{label}</Label>
      <Input
        secureTextEntry={!!f.secret}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        editable={!locked}
        value={shown ?? ''}
        placeholder={value === null ? 'Removed when you save' : f.secret && f.set ? `Saved (${f.value}). Type to replace.` : placeholder}
        onChangeText={onChange}
        accessibilityLabel={label}
      />
      {f.secret && f.set && f.from === 'settings' && !locked && value !== null && (
        <Link sm title="Remove the saved key" onPress={() => onChange(null)} style={{ alignSelf: 'flex-start' }} />
      )}
      {locked
        ? <SetHint>{f.from === 'env'
          ? <>Set by <Code>{f.env}</Code> in the server's environment.</>
          : <>Read-only here, because the server runs or reads this path. Change it with <Code>{f.env}</Code> in the server's environment, or in <Code>data/settings.json</Code>.</>}</SetHint>
        : hint ? <SetHint>{hint}</SetHint> : null}
    </View>
  )
}

function Toggle({ label, on, locked, env, onChange, hint }: { label: string; on: boolean; locked?: boolean; env: string; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <View style={{ gap: 8 }}>
      <Press onPress={() => { if (!locked) onChange(!on) }} disabled={locked} accessibilityRole="switch" accessibilityState={{ checked: !!on, disabled: !!locked }} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <T size={15} weight={500} style={{ flex: 1 }}>{label}</T>
        <Switch
          value={!!on}
          disabled={locked}
          onValueChange={onChange}
          trackColor={{ true: colors.accent, false: colors.line }}
          ios_backgroundColor={colors.line}
        />
      </Press>
      {locked ? <SetHint>Set by <Code>{env}</Code> in the server's environment.</SetHint> : hint ? <SetHint>{hint}</SetHint> : null}
    </View>
  )
}

function Result({ r }: { r: Res }) {
  if (!r) return null
  if ('busy' in r && r.busy) return <View style={st.result}><Spin size={14} /><T size={13} muted style={{ flexShrink: 1 }}>{r.busy}</T></View>
  const color = r.ok ? colors.tone2 : colors.errorText
  return (
    <View style={st.result}>
      {r.ok ? <Check size={14} color={color} /> : <CircleAlert size={14} color={color} />}
      <T size={13} color={color} style={{ flexShrink: 1 }}>{r.detail}</T>
    </View>
  )
}

function Status({ ok, children }: { ok?: boolean | null; children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
      <View style={{ marginTop: 3, width: 14 }}>
        {ok === true ? <Check size={14} color={colors.tone2} /> : ok === false ? <CircleAlert size={14} color={colors.danger} /> : null}
      </View>
      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {typeof children === 'string' ? <T size={14} muted style={{ flexShrink: 1 }}>{children}</T> : children}
      </View>
    </View>
  )
}

/** .set-pill */
function Pill({ ok, children }: { ok?: boolean; children: React.ReactNode }) {
  return (
    <View style={[st.pill, ok && { borderColor: colors.tone2 }]}>
      <T size={12} color={ok ? colors.tone2 : colors.muted}>{children}</T>
    </View>
  )
}

/** <details>: a muted line that opens what is under it. */
function Details({ summary, children }: { summary: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <View style={{ gap: 12 }}>
      <Press onPress={() => setOpen(o => !o)} accessibilityRole="button" accessibilityState={{ expanded: open }} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32 }}>
        <T size={14} muted>{summary}</T>
        <ChevronDown size={14} color={colors.muted} style={open ? { transform: [{ rotate: '180deg' }] } : undefined} />
      </Press>
      {open && children}
    </View>
  )
}

/*
 * One section's edits: only fields the owner touched are sent, so saving the AI
 * section cannot blank a key in another, and an untouched secret is never sent
 * back as its own mask.
 */
type Draft = Record<string, Record<string, any>>
function useDraft() {
  const [draft, setDraft] = useState<Draft>({})
  const set = (section: string, key: string) => (v: any) => setDraft(d => ({ ...d, [section]: { ...(d[section] || {}), [key]: v } }))
  const get = (section: string, key: string, fallback: any = ''): any => draft[section]?.[key] ?? fallback
  const clear = (section: string) => setDraft(d => { const n = { ...d }; delete n[section]; return n })
  return { draft, set, get, clear }
}
type D = ReturnType<typeof useDraft>
type Save = (section: string) => Promise<void>
type Test = (what: string) => Promise<any>
type SaveNow = (patch: Record<string, any> | null) => Promise<void>

/* ----------------------------------------------------------------- account */

function Account({ s }: { s: any }) {
  const { baseUrl } = useConnection()
  const [form, setForm] = useState({ current: '', next: '', again: '' })
  const [result, setResult] = useState<Res>(null)
  const [leaving, setLeaving] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const connected = baseUrl ? <T size={13} muted>Connected to <T size={13}>{baseUrl}</T></T> : null
  if (s.auth.mode === 'proxy') {
    return (
      <Section>
        <ListHead icon={ShieldCheck} title="Account" />
        {connected}
        <Lead>
          Sign-in is handled by the proxy in front of this server (<Code>KRAKATOA_AUTH=proxy</Code>). Krakatoa itself asks for no password.
        </Lead>
      </Section>
    )
  }
  const change = async () => {
    if (form.next !== form.again) return setResult({ ok: false, detail: 'The two new passwords do not match.' })
    setResult({ busy: 'Changing…' })
    try {
      // The server ends every session on a password change, this one too; as a
      // native client it hands back a fresh one, which keeps this phone signed in.
      const out = await api('/api/auth/password', { method: 'POST', body: { current: form.current, next: form.next }, headers: { 'x-krakatoa-client': 'native' } })
      if (out?.session) await saveSession(out.session)
      setForm({ current: '', next: '', again: '' })
      setResult({ ok: true, detail: 'Changed. Other devices are signed out.' })
    } catch (e: any) {
      setResult({ ok: false, detail: e.message })
    }
  }
  const signOut = async () => {
    setLeaving(true)
    const out = await signOutDevice({ confirmFn: (msg) => confirm('Sign out?', { message: msg, confirmLabel: 'Sign out' }) })
    // Signed out: the connection store changed, and the app goes back to Connect by itself.
    if (out.signedOut) return
    setLeaving(false)
    if (out.error) setSignOutError(out.error)
  }
  const pw = (key: 'current' | 'next' | 'again') => (v: string) => setForm(f => ({ ...f, [key]: v }))
  return (
    <Section>
      <ListHead icon={ShieldCheck} title="Account" />
      {connected}
      <Lead>Signed in as <T size={14} weight={700}>{s.owner?.username}</T>.</Lead>
      <Details summary="Change password">
        <View style={{ gap: 8 }}>
          <Label>Current password</Label>
          <Input secureTextEntry textContentType="password" autoComplete="current-password" autoCapitalize="none" value={form.current} onChangeText={pw('current')} accessibilityLabel="Current password" />
        </View>
        <View style={{ gap: 8 }}>
          <Label>New password (at least 10 characters)</Label>
          <Input secureTextEntry textContentType="newPassword" autoComplete="new-password" autoCapitalize="none" value={form.next} onChangeText={pw('next')} accessibilityLabel="New password" />
        </View>
        <View style={{ gap: 8 }}>
          <Label>New password again</Label>
          <Input secureTextEntry textContentType="newPassword" autoComplete="new-password" autoCapitalize="none" value={form.again} onChangeText={pw('again')} accessibilityLabel="New password again" />
        </View>
        <Btn icon={KeyRound} title="Change password" disabled={!form.current || form.next.length < 10} onPress={change} />
        <Result r={result} />
      </Details>
      <Btn kind="quiet" icon={LogOut} loading={leaving} title={signOutError ? 'Try signing out again' : 'Sign out'} onPress={signOut} />
      {signOutError && (
        <View style={st.result}><CircleAlert size={14} color={colors.errorText} /><T size={13} color={colors.errorText} style={{ flexShrink: 1 }}>{signOutError}</T></View>
      )}
      <SetHint>Signing out also removes the log from this device. Anything not yet synced is sent first.</SetHint>
    </Section>
  )
}

/* ---------------------------------------------------------------------- AI */

function AISection({ s, d, save, test, onLayout }: { s: any; d: D; save: Save; test: Test; onLayout: (e: LayoutChangeEvent) => void }) {
  const [status, setStatus] = useState<any>(null)
  const [result, setResult] = useState<Res>(null)
  const checkStatus = useCallback(() => {
    setStatus(null)
    api('/api/settings/ai/status').then(setStatus).catch(e => setStatus({ error: e.message }))
  }, [])
  useEffect(() => { checkStatus() }, [checkStatus])
  const ai = s.ai
  const effort = d.get('ai', 'askEffort', ai.askEffort.value)
  const backendName = (ai.backends || []).find((b: any) => b.id === ai.backend)?.name || ai.backend

  const onSave = async () => {
    setResult({ busy: 'Saving…' })
    try { await save('ai'); setResult({ ok: true, detail: 'Saved.' }); checkStatus() } catch (e: any) { setResult({ ok: false, detail: e.message }) }
  }
  const onTest = async () => {
    setResult({ busy: 'Asking the model for a one-word reply…' })
    setResult(await test('ai'))
  }

  return (
    <Section onLayout={onLayout}>
      <ListHead icon={Sparkles} title="AI" />
      <Lead>
        Reading a nutrition label from a photo and Ask AI both run the AI on this server. Everything else works without it.
      </Lead>
      <View style={{ gap: 8 }}>
        <Label>Backend</Label>
        {/* A <select> with one option, disabled: shown as the locked box it is. */}
        <View style={[st.lockedBox]} accessibilityLabel={`Backend: ${backendName}`}>
          <T>{backendName}</T>
        </View>
        <SetHint>The only backend Krakatoa drives today. It runs <Code>claude</Code> headlessly, with its tools restricted by flag.</SetHint>
      </View>

      <View style={{ gap: 6 }}>
        {!status ? (
          <Status><Spin size={14} /><T size={14} muted>Checking the CLI…</T></Status>
        ) : status.error ? <Status ok={false}>{status.error}</Status> : (
          <>
            <Status ok={status.installed}>
              <T size={14} muted style={{ flexShrink: 1 }}>
                {status.installed ? <>Installed at <Code>{status.bin}</Code>{status.version ? ` (${status.version})` : ''}</> : <>Not found at <Code>{status.bin}</Code></>}
              </T>
            </Status>
            {status.installed && (
              <Status ok={status.signedIn}>
                {status.signedIn === true ? `Signed in${status.method ? ` (${status.method})` : ''}` : status.signedIn === false ? 'Not signed in' : 'Sign-in unknown. Use Test to check.'}
              </Status>
            )}
          </>
        )}
      </View>
      {status && !status.installed && (
        <SetHint left>
          Install it on the server with <Code>npm install -g @anthropic-ai/claude-code</Code>, then either run <Code>claude</Code> once
          as the user this server runs as and sign in, or paste an Anthropic API key below. If it lives somewhere else, set <Code>CLAUDE_BIN</Code> for the server.
        </SetHint>
      )}
      {status?.installed && status.signedIn === false && (
        <SetHint left>Run <Code>claude</Code> once on the server as the user Krakatoa runs as and sign in, or paste an Anthropic API key below.</SetHint>
      )}

      <Field label="Path to claude" f={ai.bin} value={ai.bin.value} onChange={() => {}} />
      <Field label="Anthropic API key (optional)" f={ai.apiKey} value={d.get('ai', 'apiKey')} onChange={d.set('ai', 'apiKey')}
        placeholder="sk-ant-…" hint="Passed to the CLI as ANTHROPIC_API_KEY. Not needed if the CLI is signed in." />
      <Field label="Model for reading labels" f={ai.labelModel} value={d.get('ai', 'labelModel', ai.labelModel.from === 'settings' ? ai.labelModel.value : '')}
        onChange={d.set('ai', 'labelModel')} placeholder={ai.labelModel.value} />
      <Field label="Model for Ask AI" f={ai.askModel} value={d.get('ai', 'askModel', ai.askModel.from === 'settings' ? ai.askModel.value : '')}
        onChange={d.set('ai', 'askModel')} placeholder={ai.askModel.value} hint="Blank uses the label model." />
      <View style={{ gap: 8 }}>
        <Label>Ask AI effort</Label>
        <Chips>
          {['low', 'medium', 'high'].map(x => (
            <Chip key={x} label={x} on={effort === x} disabled={ai.askEffort.locked} onPress={() => d.set('ai', 'askEffort')(x)} />
          ))}
        </Chips>
        {ai.askEffort.locked && <SetHint>Set by <Code>{ai.askEffort.env}</Code> in the server's environment.</SetHint>}
      </View>
      <RowBtns>
        <Btn flex title="Test" onPress={onTest} />
        <Btn flex kind="primary" title="Save" disabled={!d.draft.ai} onPress={onSave} />
      </RowBtns>
      <Result r={result} />
    </Section>
  )
}

/* ---------------------------------------------------------------- databases */

function Databases({ s, d, save, test }: { s: any; d: D; save: Save; test: Test }) {
  const [usda, setUsda] = useState<Res>(null)
  const [nix, setNix] = useState<Res>(null)
  const run = (section: string, setR: (r: Res) => void) => async (doTest: boolean) => {
    setR({ busy: doTest ? 'Testing…' : 'Saving…' })
    try {
      if (d.draft[section]) await save(section)
      setR(doTest ? await test(section) : { ok: true, detail: 'Saved.' })
    } catch (e: any) { setR({ ok: false, detail: e.message }) }
  }
  const signup = () => { void WebBrowser.openBrowserAsync('https://fdc.nal.usda.gov/api-key-signup.html') }
  return (
    <Section>
      <ListHead icon={Wheat} title="Food databases" />
      <Lead>Open Food Facts needs no key. USDA works without one too, on a shared key limited to about 30 requests an hour.</Lead>
      <Field label="USDA FoodData Central API key" f={s.usda.key} value={d.get('usda', 'key')} onChange={d.set('usda', 'key')}
        placeholder="Free from fdc.nal.usda.gov"
        hint={<>Free at <T size={12} color={colors.accent} onPress={signup} accessibilityRole="link">fdc.nal.usda.gov</T>. Lifts the limit to 1,000 an hour.</>} />
      <RowBtns>
        <Btn flex title={d.draft.usda ? 'Save and test' : 'Test'} onPress={() => run('usda', setUsda)(true)} />
      </RowBtns>
      <Result r={usda} />

      <Field label="Nutritionix app ID (optional)" f={s.nutritionix.id} value={d.get('nutritionix', 'id', s.nutritionix.id.from === 'settings' ? s.nutritionix.id.value : '')}
        onChange={d.set('nutritionix', 'id')} placeholder="Not connected" />
      <Field label="Nutritionix app key" f={s.nutritionix.key} value={d.get('nutritionix', 'key')} onChange={d.set('nutritionix', 'key')}
        placeholder="Not connected" hint="Business accounts only. The built-in chain menus do not need it." />
      <RowBtns>
        <Btn flex title={d.draft.nutritionix ? 'Save and test' : 'Test'} onPress={() => run('nutritionix', setNix)(true)} />
      </RowBtns>
      <Result r={nix} />
    </Section>
  )
}

/* ------------------------------------------------------------- connections */

function Connections({ s, d, save, test, saveNow }: { s: any; d: D; save: Save; test: Test; saveNow: SaveNow }) {
  const [result, setResult] = useState<Res>(null)
  const t = s.totem
  const enabled = d.get('totem', 'enabled', t.enabled.value)
  const onSave = async (doTest: boolean) => {
    setResult({ busy: doTest ? 'Connecting…' : 'Saving…' })
    try {
      if (d.draft.totem) await save('totem')
      setResult(doTest ? await test('totem') : { ok: true, detail: 'Saved.' })
    } catch (e: any) { setResult({ ok: false, detail: e.message }) }
  }
  return (
    <Section>
      <ListHead icon={Plug} title="Totem bridge (optional)" />
      <Lead>
        For people who also run Totem, a personal assistant that holds the WHOOP connection. With the bridge on, the day shows
        WHOOP's calorie burn beside what you ate, and each logged day is written to a Totem habit. Off, Krakatoa never contacts it
        and the energy panel is hidden.
      </Lead>
      <View style={{ flexDirection: 'row' }}>
        <Pill ok={t.connected}>{t.connected ? 'Connected' : 'Not connected'}</Pill>
      </View>
      <Toggle label="Use the Totem bridge" on={enabled} locked={t.enabled.locked} env="KRAKATOA_TOTEM" onChange={d.set('totem', 'enabled')} />
      {enabled && (
        <>
          <Field label="Bridge URL" f={t.url} value={d.get('totem', 'url', t.url.from === 'settings' ? t.url.value : '')}
            onChange={d.set('totem', 'url')} placeholder={t.url.value}
            hint={d.draft.totem?.url !== undefined ? 'A new URL needs its own secret: enter it below. The old one is not sent to a new address.' : null} />
          <Field label="Bridge secret" f={t.secret} value={d.get('totem', 'secret')} onChange={d.set('totem', 'secret')}
            placeholder="Totem's BRIDGE_SECRET" hint={t.secret.from === 'totem .env' ? "Read from Totem's .env. Type one here to override it." : null} />
          {t.envFile.set && <Field label="Totem .env file (the secret is read from it)" f={t.envFile} value={t.envFile.value} onChange={() => {}} />}
          <Field label="Habit id" f={t.habit} value={d.get('totem', 'habit', t.habit.from === 'settings' ? t.habit.value : '')}
            onChange={d.set('totem', 'habit')} placeholder={t.habit.value} hint="Create it once with node server/totem.js --ensure." />
        </>
      )}
      <RowBtns>
        <Btn flex title={d.draft.totem ? 'Save and connect' : 'Test'} disabled={!enabled} onPress={() => onSave(true)} />
        <Btn flex kind="primary" title="Save" disabled={!d.draft.totem} onPress={() => onSave(false)} />
      </RowBtns>
      <Result r={result} />

      <Toggle
        label="Write data/digest.json after every change"
        on={s.digestFile.value}
        locked={s.digestFile.locked}
        env="KRAKATOA_DIGEST_FILE"
        onChange={(v) => { void saveNow({ digestFile: v }) }}
        hint="A small read-only summary of the last two weeks, for other tools on this server to read instead of the whole log."
      />
    </Section>
  )
}

/* ---------------------------------------------------------------- machines */

function Access({ s, d, save, saveNow }: { s: any; d: D; save: Save; saveNow: SaveNow }) {
  const [token, setToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [result, setResult] = useState<Res>(null)
  // The web reads window.location.origin; the phone's origin is the server it is connected to.
  const { baseUrl: origin } = useConnection()
  const generate = async () => {
    if (s.apiToken.set && !(await confirm('Replace the API token?', { message: 'Anything using the old one stops working.', confirmLabel: 'Replace' }))) return
    try {
      const out = await api('/api/settings/token', { method: 'POST', body: {} })
      setToken(out.token)
      setCopied(false)
      void saveNow(null)
    } catch (e: any) { setResult({ ok: false, detail: e.message }) }
  }
  const copy = async () => {
    if (!token) return
    await Clipboard.setStringAsync(token)
    success()
    setCopied(true)
  }
  const onSave = async () => {
    setResult({ busy: 'Saving…' })
    try { await save('publicUrl'); setResult({ ok: true, detail: 'Saved.' }) } catch (e: any) { setResult({ ok: false, detail: e.message }) }
  }
  return (
    <Section last>
      <ListHead icon={KeyRound} title="Access for other programs" />
      <Lead>
        An MCP client or a script can use Krakatoa with <Code>Authorization: Bearer &lt;token&gt;</Code>. The MCP endpoint is <Code>{origin}/mcp</Code>.
      </Lead>
      {s.apiToken.locked
        ? <SetHint left>The token is set by <Code>KRAKATOA_API_TOKEN</Code> in the server's environment.</SetHint>
        : (
          <>
            <View style={{ flexDirection: 'row' }}>
              <Pill ok={s.apiToken.set}>{s.apiToken.set ? `Token set (${s.apiToken.value})` : 'No token'}</Pill>
            </View>
            <Btn title={s.apiToken.set ? 'Replace the token' : 'Create a token'} onPress={generate} />
          </>
        )}
      {token && (
        <View style={st.token}>
          <SetHint left>Copy it now. It is not shown again.</SetHint>
          <T size={13} selectable style={{ fontFamily: 'Menlo' }}>{token}</T>
          <Btn kind="quiet" icon={copied ? Check : Copy} title={copied ? 'Copied' : 'Copy'} onPress={copy} />
        </View>
      )}
      <Field label="Public URL (optional)" f={s.publicUrl} value={d.get('publicUrl', 'v', s.publicUrl.from === 'settings' ? s.publicUrl.value : '')}
        onChange={d.set('publicUrl', 'v')} placeholder={origin}
        hint="The address people use to reach this server. Used for the setup link in the log, and marks cookies Secure when it is https." />
      <RowBtns>
        <Btn flex kind="primary" title="Save" disabled={!d.draft.publicUrl} onPress={onSave} />
      </RowBtns>
      <Result r={result} />
    </Section>
  )
}

/* ------------------------------------------------------------------ screen */

export default function SettingsPane() {
  const { section } = useLocalSearchParams<{ section?: string }>()
  const [s, setS] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const d = useDraft()
  const scrollRef = useRef<ScrollView>(null)
  // Where each section landed, for openSettings('ai'): the web's scrollIntoView.
  const [aiY, setAiY] = useState<number | null>(null)
  const scrolled = useRef(false)

  const reload = useCallback(() => api('/api/settings').then(setS).catch(e => setError(e.message)), [])
  useEffect(() => { reload() }, [reload])
  useEffect(() => {
    if (!s || !section || scrolled.current) return
    const y = section === 'ai' ? aiY : null
    if (y === null) return
    scrolled.current = true
    scrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: true })
  }, [s, section, aiY])

  /* Save one section's draft. `publicUrl` is a single value kept under `v`. */
  const save: Save = async (section) => {
    const patch = section === 'publicUrl' ? { publicUrl: d.draft.publicUrl?.v ?? null } : { [section]: d.draft[section] }
    const next = await api('/api/settings', { method: 'PUT', body: patch })
    setS(next)
    d.clear(section)
    loadServerInfo({ force: true })
  }
  const saveNow: SaveNow = async (patch) => {
    if (patch) setS(await api('/api/settings', { method: 'PUT', body: patch }))
    else await reload()
    loadServerInfo({ force: true })
  }
  const test: Test = (what) => api('/api/settings/test', { method: 'POST', body: { what } }).catch(e => ({ ok: false, detail: e.message }))

  return (
    <Pane title="Settings" onClose={() => router.back()} scrollRef={scrollRef} center={!s && !error} bodyStyle={s ? { gap: 28 } : undefined}>
      {error && (
        <View style={st.result}><CircleAlert size={14} color={colors.errorText} /><T size={13} color={colors.errorText} style={{ flexShrink: 1 }}>{error}</T></View>
      )}
      {!s && !error && <Spin size={28} />}
      {s && (
        <>
          <Account s={s} />
          <AISection s={s} d={d} save={save} test={test} onLayout={(e) => setAiY(e.nativeEvent.layout.y)} />
          <Databases s={s} d={d} save={save} test={test} />
          <Connections s={s} d={d} save={save} test={test} saveNow={saveNow} />
          <Access s={s} d={d} save={save} saveNow={saveNow} />
        </>
      )}
    </Pane>
  )
}

const st = StyleSheet.create({
  section: { gap: 14, paddingBottom: 24, borderBottomWidth: 1, borderBottomColor: colors.line },
  code: { fontFamily: 'Menlo', backgroundColor: colors.panel2, color: colors.text },
  result: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pill: { paddingVertical: 3, paddingHorizontal: 10, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line },
  lockedBox: {
    minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, opacity: 0.55,
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: radius.r,
  },
  token: { gap: 8, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: radius.r, padding: 12 },
})
