// First run: where the Krakatoa server is, and only if it asks, the owner's
// username and password. The web needs neither (it is served by the server and
// signs in on its /login page); the app has no origin of its own, so it asks for
// the address, gets past Cloudflare Access if the server sits behind it
// (cfAccess.ts), and then asks the server how it signs in. A server with
// KRAKATOA_AUTH=proxy is done at that point; otherwise the password fields appear
// and the session they buy is kept in the keychain (server/auth.js).
import React, { useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View, type TextInput } from 'react-native'
import { Image } from 'expo-image'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors, radius } from '../theme'
import { T } from '../ui/Text'
import { Btn, Input } from '../ui/kit'
import { getConnection, normalizeBaseUrl, saveConnection } from '../lib/connection'
import { probeAccess, signInWithAccess } from '../lib/cfAccess'
import { success, warn } from '../ui/haptics'

type Outcome = { error: string } | { needsPassword: true } | { mode: 'proxy' } | { mode: 'session'; session: string; user: string }

async function signIn(baseUrl: string, username: string, password: string, accessToken?: string): Promise<Outcome> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 10000)
  const access: Record<string, string> = accessToken ? { 'cf-access-token': accessToken } : {}
  const opts = { credentials: 'omit' as const, signal: ctl.signal }
  try {
    // /api/me says how this install signs in: a proxy-mode server answers it
    // outright; otherwise it is a 401, and says so if nobody has set it up yet.
    const me = await fetch(`${baseUrl}/api/me`, { ...opts, headers: { accept: 'application/json', ...access } })
    const meBody = await me.json().catch(() => null)
    if (me.ok && meBody?.authMode === 'proxy') return { mode: 'proxy' }
    if (me.ok && meBody?.authMode) return { error: 'That server answered without asking who you are. Is this Krakatoa?' }
    if (me.status === 401 && meBody?.setup) return { error: 'This Krakatoa is not set up yet. Open the one-time setup link from its log in a browser and create the owner, then sign in here.' }
    if (me.status !== 401) return { error: `The server answered ${me.status}. Is this Krakatoa?` }
    if (!username.trim() || !password) return { needsPassword: true }

    const r = await fetch(`${baseUrl}/api/auth/login`, {
      ...opts,
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-krakatoa-client': 'native', ...access },
      body: JSON.stringify({ username: username.trim(), password }),
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) return { error: body.error || `The server answered ${r.status}.` }
    if (!body.session) return { error: 'The server signed you in but sent no session back. It needs a newer Krakatoa (one that knows the iPhone app).' }
    return { mode: 'session', session: body.session, user: body.user || username.trim() }
  } catch (e: any) {
    return {
      error: e?.name === 'AbortError'
        ? 'No answer after 10 seconds. On Tailscale? Use the address your phone can reach.'
        : `Could not reach ${baseUrl}: ${e?.message || e}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

export default function Connect() {
  const insets = useSafeAreaInsets()
  const [address, setAddress] = useState(() => getConnection().baseUrl.replace(/^http:\/\//, ''))
  const [username, setUsername] = useState(() => getConnection().user || '')
  const [password, setPassword] = useState('')
  const [askPassword, setAskPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [stage, setStage] = useState('')
  const userRef = useRef<TextInput>(null)
  const passRef = useRef<TextInput>(null)

  const submit = async () => {
    const baseUrl = normalizeBaseUrl(address)
    if (!baseUrl) return
    setBusy(true)
    setError('')
    let accessToken: string | undefined = getConnection().baseUrl === baseUrl ? getConnection().accessToken : undefined
    try {
      // Behind a Cloudflare tunnel with Access, sign in there first.
      const guard = await probeAccess(baseUrl)
      if (guard.protected && !accessToken) {
        setStage('Sign in to Cloudflare Access to reach this server…')
        accessToken = (await signInWithAccess(baseUrl, guard.aud)) || undefined
        setStage('')
        if (!accessToken) { setBusy(false); setError('Cloudflare sign-in was closed before it finished.'); return }
      }
      if (!guard.protected) accessToken = undefined
    } catch (e: any) {
      // Unreachable is reported by signIn() below with a clearer message.
      setStage('')
      if (!/Network request failed|fetch|network/i.test(e?.message || '')) { setBusy(false); setError(e?.message || String(e)); return }
    }
    const out = await signIn(baseUrl, username, password, accessToken)
    setBusy(false)
    if ('needsPassword' in out) {
      if (askPassword) { warn(); setError("Sign in with the owner's username and password.") }
      else { setAskPassword(true); setTimeout(() => userRef.current?.focus(), 50) }
      return
    }
    if ('error' in out) { warn(); setError(out.error); return }
    success()
    setPassword('')
    if (out.mode === 'proxy') await saveConnection({ baseUrl, mode: 'proxy', session: '', accessToken })
    else await saveConnection({ baseUrl, mode: 'session', session: out.session, user: out.user, accessToken })
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={[st.page, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 20 }]} keyboardShouldPersistTaps="handled">
        <View style={st.card}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <Image source={require('../../assets/images/krakatoa-logo.png')} style={{ width: 40, height: 40, borderRadius: 10 }} />
            <T size={20} weight={700}>Krakatoa</T>
          </View>
          <T size={22} weight={700} style={{ marginBottom: 6 }}>Connect to Krakatoa</T>
          <T muted size={15} style={{ marginBottom: 16 }}>
            {askPassword
              ? "This Krakatoa asks who you are: the owner's username and password."
              : 'The address of the machine running Krakatoa: its domain, or a Tailscale IP.'}
          </T>
          <Input
            value={address}
            onChangeText={(v) => { setAddress(v); setAskPassword(false); setError('') }}
            placeholder="100.x.y.z or food.example.com"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            textContentType="URL"
            returnKeyType={askPassword ? 'next' : 'go'}
            onSubmitEditing={() => (askPassword ? userRef.current?.focus() : submit())}
            accessibilityLabel="Server address"
            boxStyle={{ marginBottom: 12, backgroundColor: colors.bg }}
          />
          {askPassword ? (
            <>
              <Input
                ref={userRef}
                value={username}
                onChangeText={setUsername}
                placeholder="Username"
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="username"
                autoComplete="username"
                returnKeyType="next"
                onSubmitEditing={() => passRef.current?.focus()}
                accessibilityLabel="Username"
                boxStyle={{ marginBottom: 12, backgroundColor: colors.bg }}
              />
              <Input
                ref={passRef}
                value={password}
                onChangeText={setPassword}
                placeholder="Password"
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="password"
                autoComplete="current-password"
                returnKeyType="go"
                onSubmitEditing={submit}
                accessibilityLabel="Password"
                boxStyle={{ marginBottom: 12, backgroundColor: colors.bg }}
              />
            </>
          ) : null}
          {stage ? <T muted style={{ marginBottom: 12 }}>{stage}</T> : null}
          {error ? <T color={colors.danger} style={{ marginBottom: 12 }}>{error}</T> : null}
          <Btn kind="primary" title="Connect" loading={busy} disabled={!address.trim()} onPress={submit} />
          <T muted size={12.5} lineHeight={18} style={{ marginTop: 14 }}>
            A domain uses https, and Cloudflare Access sign-in is handled; an IP or Tailscale name uses port 8101. A
            server that leaves sign-in to a proxy needs no password. The session is kept in the iOS keychain.
          </T>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const st = StyleSheet.create({
  page: { flexGrow: 1, justifyContent: 'center', padding: 20 },
  card: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: radius.panel, padding: 24 },
})
