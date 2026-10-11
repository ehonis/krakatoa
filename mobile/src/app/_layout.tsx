import '../lib/boot'
import React, { useEffect, useState } from 'react'
import { View } from 'react-native'
import { Stack, ThemeProvider, DarkTheme } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { isConnected, loadConnection, useConnection } from '../lib/connection'
import { startSync } from '../lib/store'
import { useAccessReauth } from '../shell/accessReauth'
import ToastHost from '../ui/ToastHost'
import { ScreenError } from '../shell/ScreenError'
import { colors } from '../theme'

SplashScreen.preventAutoHideAsync()

// A screen that throws shows ScreenError instead of closing the app (release
// builds otherwise die on any render error). Applies to every nested screen.
export const unstable_settings = { screenErrorBoundary: ScreenError }
export { ScreenError as ErrorBoundary }

const theme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: colors.bg, card: colors.panel, text: colors.text, border: colors.line, primary: colors.accent },
}

// How every route over the day is presented. Declared here, on the navigator:
// set from inside the screen, the presentation arrives after the push has begun.
//
// The web has one screen and overlays; on a phone an overlay is a page sheet
// (`modal` is UIModalPresentationPageSheet on iOS), which swipes down to close
// and leaves the day peeking behind it. The add flow is a sheet with its own
// stack (src/app/add/), so its views push and swipe back like any iOS app.
const pageSheet = { presentation: 'modal' as const, contentStyle: { backgroundColor: colors.bg } }

/** One row per route under src/app, outside the day and Connect. */
const ROUTES: { name: string; options: object }[] = [
  { name: 'add', options: pageSheet },
  { name: 'food', options: pageSheet },
  { name: 'targets', options: pageSheet },
  { name: 'settings', options: pageSheet },
]

/** Mounted once signed in: the sync loop, and Cloudflare Access's re-sign-in. */
function SignedIn() {
  useAccessReauth()
  useEffect(() => startSync(), [])
  return null
}

export default function RootLayout() {
  const [ready, setReady] = useState(false)
  const conn = useConnection()
  const connected = Boolean(conn.baseUrl && (conn.session || conn.mode === 'proxy')) && isConnected()

  useEffect(() => { loadConnection().finally(() => setReady(true)) }, [])
  useEffect(() => { if (ready) SplashScreen.hideAsync() }, [ready])

  if (!ready) return <View style={{ flex: 1, backgroundColor: colors.bg }} />

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaProvider>
        {/* Keyboard-aware panes anywhere (a pane's foot rides the keyboard). */}
        <KeyboardProvider>
          <ThemeProvider value={theme}>
            <StatusBar style="light" />
            {connected ? <SignedIn /> : null}
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
              <Stack.Protected guard={connected}>
                <Stack.Screen name="index" />
                {ROUTES.map((r) => <Stack.Screen key={r.name} name={r.name} options={r.options} />)}
              </Stack.Protected>
              <Stack.Protected guard={!connected}>
                <Stack.Screen name="connect" options={{ animation: 'fade' }} />
              </Stack.Protected>
            </Stack>
            <ToastHost />
          </ThemeProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
