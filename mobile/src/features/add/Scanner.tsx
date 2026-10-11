/*
 * Krakatoa — the camera. Ported from app/src/scanner.jsx.
 *
 * The web needs two decoders (the browser's BarcodeDetector where it exists, and
 * zxing-wasm for Safari, which has none) and a secure context to get a camera at
 * all. The phone has neither problem, which is a large part of why it exists:
 * expo-camera reads barcodes natively (AVFoundation on iOS), straight off the
 * preview, from any address, http or not.
 *
 * Shown as a full-screen modal over whatever opened it (the day, or the add
 * sheet), so closing it returns exactly there.
 */

import React, { useEffect, useRef, useState } from 'react'
import { Alert, Linking, Modal, StyleSheet, View, useWindowDimensions } from 'react-native'
import { CameraView, useCameraPermissions, type BarcodeScanningResult, type BarcodeType } from 'expo-camera'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated'
import { Keyboard, X, Zap, ZapOff } from '../../lib/icons'
import { colors, radius } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, IconBtn } from '../../ui/kit'
import { success } from '../../ui/haptics'

/* The formats on food. Asking for QR and the rest as well finds marketing URLs,
 * which are never the thing being scanned here. */
const FORMATS: BarcodeType[] = ['ean13', 'ean8', 'upc_a', 'upc_e', 'itf14']

function Sweep() {
  const still = useReducedMotion()
  const y = useSharedValue(-70)
  useEffect(() => {
    if (still) { y.value = 0; return }
    y.value = withRepeat(withTiming(70, { duration: 1000, easing: Easing.inOut(Easing.ease) }), -1, true)
  }, [still, y])
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }))
  return <Animated.View style={[st.line, style]} />
}

function Camera({ onCode, onClose, onManual }: { onCode: (code: string) => void; onClose: () => void; onManual: () => void }) {
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()
  const windowW = Math.min(width * 0.78, 340)
  const [permission, requestPermission] = useCameraPermissions()
  const [ready, setReady] = useState(false)
  const [torch, setTorch] = useState(false)
  const done = useRef(false)

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission()
  }, [permission, requestPermission])

  const hit = (r: BarcodeScanningResult) => {
    if (done.current || !r?.data) return
    done.current = true
    // The scan succeeding is the one moment in this app worth feeling rather
    // than reading.
    success()
    onCode(String(r.data).trim())
  }

  /* Typing the digits off the pack, for a barcode the camera will not read. The
     web's keyboard button goes to the by-hand form; this asks for the number
     first and keeps that as the other way out. */
  const typeIt = () => {
    Alert.prompt('Type the barcode', 'The digits under the bars.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Add it by hand', onPress: onManual },
      { text: 'Look it up', onPress: (v?: string) => { const code = String(v || '').replace(/\D/g, ''); if (code) { done.current = true; onCode(code) } } },
    ], 'plain-text', '', 'number-pad', { userInterfaceStyle: 'dark' } as any)
  }

  const refused = permission && !permission.granted && !permission.canAskAgain
  const error = refused ? 'Camera permission was refused. Allow it in Settings → Krakatoa and reopen.' : null

  return (
    <View style={st.scan}>
      {permission?.granted ? (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          enableTorch={torch}
          barcodeScannerSettings={{ barcodeTypes: FORMATS }}
          onBarcodeScanned={hit}
          onCameraReady={() => setReady(true)}
          onMountError={() => setReady(false)}
        />
      ) : null}

      {/* The window, and the dimmed frame around it (the web's 100vmax box-shadow). */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <View style={[st.dim, { flex: 1 }]} />
        <View style={{ flexDirection: 'row', height: 190 }}>
          <View style={[st.dim, { flex: 1 }]} />
          <View style={[st.window, { width: windowW }]}>
            <Sweep />
          </View>
          <View style={[st.dim, { flex: 1 }]} />
        </View>
        <View style={[st.dim, { flex: 1, alignItems: 'center', paddingTop: 16 }]}>
          <T weight={600} color={colors.white} style={st.hint}>
            {error ? '' : ready ? 'Point at the barcode' : 'Starting the camera…'}
          </T>
        </View>
      </View>

      {error ? (
        <View style={st.error}>
          <T align="center" style={{ marginBottom: 14 }}>{error}</T>
          <View style={{ gap: 10 }}>
            <Btn title="Open Settings" onPress={() => Linking.openSettings()} />
            <Btn title="Type the barcode instead" onPress={typeIt} />
          </View>
        </View>
      ) : null}

      <View style={[st.bar, { bottom: Math.max(insets.bottom, 16) + 16 }]}>
        <IconBtn icon={X} label="Close" color={colors.white} background="rgba(0,0,0,0.55)" style={st.barBtn} onPress={onClose} />
        {/* A supermarket aisle is bright; a kitchen cupboard at 10pm is not. */}
        {permission?.granted ? (
          <IconBtn icon={torch ? Zap : ZapOff} label="Torch" color={colors.white} background="rgba(0,0,0,0.55)" style={st.barBtn} onPress={() => setTorch(t => !t)} />
        ) : null}
        <IconBtn icon={Keyboard} label="Type it in" color={colors.white} background="rgba(0,0,0,0.55)" style={st.barBtn} onPress={typeIt} />
      </View>
    </View>
  )
}

export default function ScannerModal({ visible, onCode, onClose, onManual }: { visible: boolean; onCode: (code: string) => void; onClose: () => void; onManual: () => void }) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose} statusBarTranslucent>
      {visible ? <Camera onCode={onCode} onClose={onClose} onManual={onManual} /> : null}
    </Modal>
  )
}

const st = StyleSheet.create({
  scan: { flex: 1, backgroundColor: '#000' },
  dim: { backgroundColor: 'rgba(0,0,0,0.5)' },
  window: { height: 190, borderRadius: 16, borderWidth: 2, borderColor: 'rgba(255,255,255,0.85)', justifyContent: 'center' },
  line: {
    position: 'absolute', left: 8, right: 8, height: 2, backgroundColor: colors.accent,
    shadowColor: colors.accent, shadowOpacity: 1, shadowRadius: 6, shadowOffset: { width: 0, height: 0 },
  },
  hint: { textShadowColor: '#000', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 },
  error: {
    position: 'absolute', left: 20, right: 20, top: '38%',
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: radius.panel, padding: 20,
  },
  bar: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', paddingHorizontal: 24 },
  barBtn: { width: 56, height: 56, borderRadius: 28 },
})
