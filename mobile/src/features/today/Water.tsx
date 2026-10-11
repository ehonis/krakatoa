/*
 * Krakatoa — the day's water. Ported from app/src/water.jsx.
 *
 * A glass that fills. The buttons are the things he actually drinks out of
 * rather than a slider asking him to estimate in a unit nobody pours, and the
 * meter is the one place in this app where the point is to be nice to look at:
 * water is logged out of habit rather than interest, and a thing you enjoy
 * tapping gets tapped.
 *
 * THE WAVES ARE DRAWN, and that is the exception rather than the rule here — no
 * icon library has an animated liquid fill, because it is a shape driven by a
 * number rather than a glyph. Two sine paths at different speeds and opacities,
 * which is what stops it reading as one rigid shape sliding past. Same path as
 * the web's, moved by Reanimated instead of a CSS animation.
 */

import React, { useEffect, useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import Svg, { Path } from 'react-native-svg'
import { LinearGradient } from 'expo-linear-gradient'
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated'
import { Droplet, Minus, PencilLine, Plus, Undo2, X } from '../../lib/icons'
import { WATER_NUDGE, WATER_STEPS, customWaterOz, ozToL, waterLevel } from '../../lib/macros'
import { colors, radius, TAP } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, IconBtn, Link, ListHead, Panel, Press, Seg } from '../../ui/kit'
import { impact } from '../../ui/haptics'

/* One period of a sine, repeated four times so the path can slide a full period
   without its end coming into view. Drawn once, reused by both layers. */
const WAVE_D = `
  M 0 10
  c 12.5 0 12.5 -10 25 -10 s 12.5 10 25 10 s 12.5 -10 25 -10 s 12.5 10 25 10
  s 12.5 -10 25 -10 s 12.5 10 25 10 s 12.5 -10 25 -10 s 12.5 10 25 10
  L 200 40 L 0 40 Z
`

const GLASS_W = 104
const GLASS_H = 132

function Wave({ duration, reverse, opacity, color }: { duration: number; reverse?: boolean; opacity: number; color: string }) {
  const still = useReducedMotion()
  const x = useSharedValue(reverse ? -GLASS_W : 0)
  useEffect(() => {
    // An animated waterline is decoration; someone who asked for less motion
    // gets a still one, and the level still reads.
    if (still) return
    x.value = withRepeat(withTiming(reverse ? 0 : -GLASS_W, { duration, easing: Easing.linear }), -1, false)
    return () => cancelAnimation(x)
  }, [still, duration, reverse, x])
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }))
  return (
    <Animated.View pointerEvents="none" style={[st.wave, { opacity }, style]}>
      <Svg width={GLASS_W * 2} height={14} viewBox="0 0 200 40" preserveAspectRatio="none">
        <Path d={WAVE_D} fill={color} />
      </Svg>
    </Animated.View>
  )
}

/*
 * Any amount at all, for the glass that is none of the buttons. Opens in the
 * buttons' place rather than a dialog: it is one number and one tap, and the
 * glass it is filling stays in view while he types it.
 */
function Custom({ onAdd, onClose }: { onAdd: (oz: number) => void; onClose: () => void }) {
  const [text, setText] = useState('')
  const [unit, setUnit] = useState<'oz' | 'ml'>('oz')
  const oz = customWaterOz(text, unit)
  const add = () => { if (oz) { onAdd(oz); onClose() } }
  return (
    <View style={{ flex: 1, justifyContent: 'center', gap: 8 }}>
      <View style={st.customRow}>
        <TextInput
          value={text}
          onChangeText={(v) => setText(v.replace(/[^\d.,]/g, ''))}
          placeholder={unit === 'ml' ? '500' : '20'}
          placeholderTextColor={colors.muted}
          keyboardType="decimal-pad"
          keyboardAppearance="dark"
          selectionColor={colors.accent}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={add}
          accessibilityLabel={`Amount in ${unit === 'ml' ? 'millilitres' : 'ounces'}`}
          style={st.customInput}
        />
        <Seg
          options={[{ value: 'oz', label: 'oz' }, { value: 'ml', label: 'mL' }]}
          value={unit}
          onChange={setUnit}
          style={{ flex: 0, minWidth: 104 }}
        />
      </View>
      <View style={st.customRow}>
        <Btn kind="primary" title={oz ? `Add ${oz} oz` : 'Add'} disabled={!oz} onPress={add} style={{ flex: 1, paddingHorizontal: 10 }} />
        <IconBtn icon={X} size={18} label="Cancel" onPress={onClose} />
      </View>
    </View>
  )
}

export default function Water({ oz, target, onAdd }: { oz: number; target: number | null; onAdd: (oz: number) => void }) {
  const level = waterLevel(oz, target)
  const [custom, setCustom] = useState(false)
  const fill = useSharedValue(level.pct)
  useEffect(() => {
    fill.value = withTiming(level.pct, { duration: 600, easing: Easing.bezier(0.22, 1, 0.36, 1) })
  }, [level.pct, fill])
  const fillStyle = useAnimatedStyle(() => ({ height: `${fill.value}%` }))
  const add = (n: number) => { impact(); onAdd(n) }
  const top = level.met ? colors.waterMet : colors.water
  const deep = level.met ? colors.waterMetDeep : colors.waterDeep

  return (
    <Panel style={{ gap: 12, paddingHorizontal: 16, marginBottom: 20 }}>
      <ListHead icon={Droplet} title="Water / liquids" />

      <View style={{ flexDirection: 'row', alignItems: 'stretch', gap: 16 }}>
        <View style={st.glass}>
          {/*
            The fill is a block whose HEIGHT is the level, with the waves riding
            on its top edge — so the surface is always exactly at the waterline
            and the animation never has to know what the level is.
          */}
          <Animated.View style={[st.fill, fillStyle]}>
            <LinearGradient colors={[top, deep]} style={StyleSheet.absoluteFill} />
            <Wave duration={5500} opacity={0.45} color={top} />
            <Wave duration={3200} reverse opacity={1} color={top} />
          </Animated.View>

          <View style={st.read} pointerEvents="none">
            <T size={26} weight={700} tabular lineHeight={29} style={st.shadow}>{level.oz.toLocaleString()}</T>
            <T size={11} style={[st.shadow, { opacity: 0.9 }]}>of {level.target} oz</T>
            <T size={10} style={[st.shadow, { opacity: 0.7, marginTop: 2 }]}>{ozToL(level.oz)} L</T>
          </View>
        </View>

        {custom ? (
          <Custom onAdd={add} onClose={() => setCustom(false)} />
        ) : (
          <View style={st.steps}>
            {WATER_STEPS.map(step => (
              <WaterBtn key={step.oz} onPress={() => add(step.oz)} label={`Add ${step.oz} ounces`}>
                {(on) => (
                  <>
                    <T size={15} weight={700} color={on ? '#051018' : colors.text}>+{step.oz}</T>
                    <T size={10} color={on ? '#051018' : colors.muted} style={{ opacity: on ? 0.8 : 1 }}>{step.hint}</T>
                  </>
                )}
              </WaterBtn>
            ))}
            <WaterBtn onPress={() => setCustom(true)} label="A custom amount">
              {(on) => (
                <>
                  <PencilLine size={15} color={on ? '#051018' : colors.text} />
                  <T size={10} color={on ? '#051018' : colors.muted}>custom</T>
                </>
              )}
            </WaterBtn>
          </View>
        )}
      </View>

      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 18 }}>
        {/* Undo rather than a delete: the commonest correction is one tap too
            many, and subtracting the same amounts he added is how that is said. */}
        <Link sm icon={Minus} title={`${WATER_NUDGE} oz`} onPress={() => add(-Math.min(WATER_NUDGE, level.oz))} disabled={!level.oz} />
        <Link sm icon={Undo2} title="Clear" onPress={() => add(-level.oz)} disabled={!level.oz} />
        <Link sm icon={Plus} title={`${WATER_NUDGE} oz`} onPress={() => add(WATER_NUDGE)} />
      </View>
    </Panel>
  )
}

/* .water-btn: fills with the water's blue while pressed. */
function WaterBtn({ onPress, label, children }: { onPress: () => void; label: string; children: (pressed: boolean) => React.ReactNode }) {
  return (
    <Press accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={{ width: '28%', flexGrow: 1 }}>
      {({ pressed }: { pressed: boolean }) => (
        <View style={[st.btn, pressed && { backgroundColor: colors.water, borderColor: colors.water }]}>{children(pressed)}</View>
      )}
    </Press>
  )
}

const st = StyleSheet.create({
  glass: {
    width: GLASS_W, height: GLASS_H, borderRadius: 14, overflow: 'hidden',
    backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line,
  },
  fill: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  // margin-bottom: -1px hides the seam between the wave and the body.
  wave: { position: 'absolute', bottom: '100%', left: 0, width: GLASS_W * 2, height: 14, marginBottom: -1 },
  read: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  shadow: { textShadowColor: 'rgba(0,0,0,0.55)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 },
  // Six: 4, 6, 12, 32, 64 and Custom. Three across keeps them in two rows the
  // glass's height.
  steps: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignContent: 'space-between' },
  btn: {
    minHeight: TAP + 18, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.line, borderRadius: radius.r, backgroundColor: colors.panel2,
  },
  customRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  customInput: {
    flex: 1, minWidth: 0, minHeight: TAP, paddingHorizontal: 10, fontSize: 20, fontWeight: '700', textAlign: 'center',
    color: colors.text, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: radius.r,
  },
})
