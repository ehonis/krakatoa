// The web app's building blocks (styles.css: .btn, .icon-btn, .link, .chip, .seg,
// .text-input, .field, .panel, .big-action, .search-box, .stepper, …) as native
// components. Screens compose these rather than restyling Pressables by hand, so
// a tap target feels the same everywhere and the values stay in one place.
import React, { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator, Pressable, StyleSheet, TextInput, View,
  type PressableProps, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle,
} from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated'
import { colors, radius, alpha, TAP } from '../theme'
import { Loader2, Minus, Plus, Search, X, type IconType } from '../lib/icons'
import { round } from '../lib/food'
import { T } from './Text'
import { tap } from './haptics'

/** A Pressable that dims when held, the native stand-in for :active. */
export function Press({ style, haptic, onPress, ...rest }: PressableProps & { style?: StyleProp<ViewStyle>; haptic?: boolean }) {
  return (
    <Pressable
      {...rest}
      onPress={(e) => { if (haptic) tap(); onPress?.(e) }}
      style={({ pressed }) => [style, pressed && !rest.disabled ? { opacity: 0.6 } : null]}
    />
  )
}

/** `.spin`: the Loader2 glyph, turning. */
export function Spin({ size = 16, color = colors.muted }: { size?: number; color?: string }) {
  const turn = useSharedValue(0)
  useEffect(() => {
    turn.value = withRepeat(withTiming(360, { duration: 1000, easing: Easing.linear }), -1, false)
    return () => cancelAnimation(turn)
  }, [turn])
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value}deg` }] }))
  return (
    <Animated.View style={[{ width: size, height: size }, style]}>
      <Loader2 size={size} color={color} />
    </Animated.View>
  )
}

type BtnKind = 'default' | 'primary' | 'danger' | 'quiet'

/** .btn, .btn-primary (full width, amber), .btn-danger, .btn-quiet (full width, muted). */
export function Btn({ title, icon: Icon, kind = 'default', onPress, disabled, loading, style, flex, children }: {
  title?: string
  icon?: IconType
  kind?: BtnKind
  onPress?: () => void
  disabled?: boolean
  loading?: boolean
  style?: StyleProp<ViewStyle>
  /** Share a row with others (.row-btns .btn). */
  flex?: boolean
  children?: React.ReactNode
}) {
  const fg = kind === 'primary' ? colors.onAccent : kind === 'danger' ? colors.onDanger : kind === 'quiet' ? colors.muted : colors.text
  const off = disabled || loading
  return (
    <Press
      haptic
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off }}
      style={[st.btn, kindStyle[kind], flex && { flex: 1 }, off && { opacity: 0.4 }, style]}
    >
      {loading ? <Spin size={16} color={fg} /> : Icon ? <Icon size={kind === 'primary' ? 18 : 16} color={fg} /> : null}
      {title ? <T size={16} weight={600} color={fg} numberOfLines={1}>{title}</T> : null}
      {children}
    </Press>
  )
}

const kindStyle: Record<BtnKind, ViewStyle> = {
  default: {},
  primary: { backgroundColor: colors.accent, borderColor: colors.accent, alignSelf: 'stretch' },
  danger: { backgroundColor: colors.danger, borderColor: colors.danger },
  quiet: { alignSelf: 'stretch' },
}

/** .icon-btn: a round 44 (or 36, `sm`) glyph button. `ghost` is muted. */
export function IconBtn({ icon: Icon, onPress, size = 24, sm, ghost, color, label, disabled, style, fill, background }: {
  icon: IconType
  onPress?: () => void
  size?: number
  sm?: boolean
  ghost?: boolean
  color?: string
  label: string
  disabled?: boolean
  style?: StyleProp<ViewStyle>
  /** For a filled glyph (the starred star). */
  fill?: string
  background?: string
}) {
  const box = sm ? 36 : TAP
  return (
    <Press
      haptic
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={sm ? 4 : 0}
      style={[{ width: box, height: box, borderRadius: box / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: background }, disabled && { opacity: 0.25 }, style]}
    >
      <Icon size={size} color={color || (ghost ? colors.muted : colors.text)} fill={fill || 'none'} />
    </Press>
  )
}

/** .link: amber, bold, no box. `sm` is the quiet 12px one (.link.sm). */
export function Link({ title, icon: Icon, onPress, sm, disabled, color, style }: {
  title: string
  icon?: IconType
  onPress?: () => void
  sm?: boolean
  disabled?: boolean
  color?: string
  style?: StyleProp<ViewStyle>
}) {
  const fg = color || (sm ? colors.muted : colors.accent)
  return (
    <Press
      haptic
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      hitSlop={6}
      style={[{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8 }, disabled && { opacity: 0.35 }, style]}
    >
      {Icon ? <Icon size={sm ? 13 : 14} color={fg} /> : null}
      <T size={sm ? 12 : 15} weight={sm ? 500 : 600} color={fg}>{title}</T>
    </Press>
  )
}

/** .chip: a label with an optional line under it (.chip-sub); `on` fills it amber. */
export function Chip({ label, sub, icon: Icon, on, onPress, disabled, style }: {
  label: string
  sub?: string
  icon?: IconType
  on?: boolean
  onPress?: () => void
  disabled?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const fg = on ? colors.onAccent : colors.text
  return (
    <Press
      haptic
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: !!on }}
      style={[st.chip, on && st.chipOn, disabled && { opacity: 0.5 }, style]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {Icon ? <Icon size={15} color={fg} /> : null}
        <T size={15} color={fg}>{label}</T>
      </View>
      {sub ? <T size={11} color={fg} style={{ opacity: 0.7 }} lineHeight={14}>{sub}</T> : null}
    </Press>
  )
}

/** .chips: a wrapping row of them. */
export function Chips({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, style]}>{children}</View>
}

/** .seg: one choice of a few, the chosen one amber. */
export function Seg<V extends string>({ options, value, onChange, style }: {
  options: { value: V; label: string }[]
  value: V
  onChange: (v: V) => void
  style?: StyleProp<ViewStyle>
}) {
  return (
    <View style={[st.seg, style]} accessibilityRole="tablist">
      {options.map((o) => {
        const on = o.value === value
        return (
          <Press
            key={o.value}
            haptic
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.value)}
            style={[st.segBtn, on && { backgroundColor: colors.accent }]}
          >
            <T size={15} weight={600} color={on ? colors.onAccent : colors.muted}>{o.label}</T>
          </Press>
        )
      })}
    </View>
  )
}

/** .text-input. 16px, as the web insists; the amber ring while focused. */
export const Input = React.forwardRef<TextInput, TextInputProps & { boxStyle?: StyleProp<ViewStyle>; textStyle?: StyleProp<TextStyle> }>(function Input({ boxStyle, textStyle, onFocus, onBlur, editable, multiline, ...rest }, ref) {
  const [focused, setFocused] = useState(false)
  return (
    <View style={[st.input, multiline && { minHeight: 84, paddingVertical: 10, alignItems: 'flex-start' }, focused && { borderColor: colors.accent, borderWidth: 2, paddingHorizontal: 13 }, editable === false && { opacity: 0.55 }, boxStyle]}>
      <TextInput
        ref={ref}
        placeholderTextColor={colors.muted}
        selectionColor={colors.accent}
        keyboardAppearance="dark"
        editable={editable}
        multiline={multiline}
        onFocus={(e) => { setFocused(true); onFocus?.(e) }}
        onBlur={(e) => { setFocused(false); onBlur?.(e) }}
        {...rest}
        style={[{ flex: 1, color: colors.text, fontSize: 16, paddingVertical: 0, alignSelf: 'stretch' }, multiline && { textAlignVertical: 'top' }, textStyle]}
      />
    </View>
  )
})

/** .field: an uppercase label over its control, with an optional right-hand action. */
export function Field({ label, right, children, style }: { label?: React.ReactNode; right?: React.ReactNode; children?: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ gap: 8 }, style]}>
      {label || right ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          {typeof label === 'string' ? <T size={13} caps muted>{label}</T> : label}
          {right}
        </View>
      ) : null}
      {children}
    </View>
  )
}

/** .field-hint: a centred muted line under a control. */
export function Hint({ children, left, style }: { children: React.ReactNode; left?: boolean; style?: StyleProp<TextStyle> }) {
  return <T size={13} muted align={left ? 'left' : 'center'} lineHeight={19} style={style}>{children}</T>
}

/** .panel (and .summary, .balance, .water, which are the same card). */
export function Panel({ children, style, danger }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; danger?: boolean }) {
  return <View style={[st.panel, danger && { borderColor: colors.danger }, style]}>{children}</View>
}

/** .list-head / .panel-head: a glyph and a small uppercase heading, with room on the right. */
export function ListHead({ icon: Icon, title, right, children, style }: { icon?: IconType; title: React.ReactNode; right?: React.ReactNode; children?: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 22 }, style]}>
      {Icon ? <Icon size={16} color={colors.muted} /> : null}
      <T size={13} caps muted style={{ flexShrink: 1 }}>{title}</T>
      {children}
      {right ? <View style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 2 }}>{right}</View> : null}
    </View>
  )
}

/** .row-note: a muted line with a glyph, for searching / nothing found / an error. */
export function RowNote({ icon, spin, children, color, style }: { icon?: IconType; spin?: boolean; children: React.ReactNode; color?: string; style?: StyleProp<ViewStyle> }) {
  const Icon = icon
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginVertical: 8 }, style]}>
      {spin ? <Spin size={16} color={color || colors.muted} /> : Icon ? <Icon size={16} color={color || colors.muted} /> : null}
      {typeof children === 'string' ? <T size={15} color={color || colors.muted} style={{ flexShrink: 1 }}>{children}</T> : children}
    </View>
  )
}

/** .big-action: a big door with a glyph, a title and a line. `subtle` is the plain card, `ai` the violet one. */
export function BigAction({ icon: Icon, title, sub, onPress, kind = 'accent', disabled, iconNode, compact, style }: {
  icon?: IconType
  title: string
  sub?: string
  onPress?: () => void
  kind?: 'accent' | 'subtle' | 'ai'
  disabled?: boolean
  /** In place of the glyph (a spinner while reading). */
  iconNode?: React.ReactNode
  /** .big-pair .big-action: two side by side. */
  compact?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const fill = kind === 'subtle' ? null : kind === 'ai' ? [alpha(colors.aiLine, 0.16), alpha(colors.aiLine, 0.04)] as const : [alpha(colors.accent, 0.16), alpha(colors.accent, 0.06)] as const
  return (
    <Press
      haptic
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={[st.big, compact && { paddingHorizontal: 12, gap: 10 }, { borderColor: kind === 'subtle' ? colors.line : kind === 'ai' ? alpha(colors.aiLine, 0.55) : colors.accent }, kind === 'subtle' && { backgroundColor: colors.panel }, disabled && { opacity: 0.6 }, style]}
    >
      {fill ? <LinearGradient colors={fill} start={{ x: 0, y: 0 }} end={kind === 'ai' ? { x: 1, y: 1 } : { x: 0, y: 1 }} style={[StyleSheet.absoluteFill, { borderRadius: radius.panel }]} /> : null}
      {iconNode ?? (Icon ? <Icon size={compact ? 26 : 24} color={kind === 'ai' ? colors.ai : colors.text} /> : null)}
      <View style={{ flex: 1, minWidth: 0 }}>
        <T size={compact ? 16 : 17} weight={700}>{title}</T>
        {sub ? <T size={compact ? 12 : 14} muted lineHeight={compact ? 16 : 19}>{sub}</T> : null}
      </View>
    </Press>
  )
}

/** .search-box: a magnifier, the box, and a clear button once there is text. */
export function SearchBox({ value, onChangeText, placeholder, label, autoFocus, style }: {
  value: string
  onChangeText: (v: string) => void
  placeholder?: string
  label: string
  autoFocus?: boolean
  style?: StyleProp<ViewStyle>
}) {
  return (
    <View style={[st.search, style]}>
      <Search size={18} color={colors.muted} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        selectionColor={colors.accent}
        keyboardAppearance="dark"
        autoFocus={autoFocus}
        autoCorrect={false}
        returnKeyType="search"
        clearButtonMode="never"
        accessibilityLabel={label}
        style={{ flex: 1, color: colors.text, fontSize: 16, minHeight: TAP, paddingVertical: 0 }}
      />
      {value ? <IconBtn icon={X} sm size={18} label="Clear" onPress={() => onChangeText('')} /> : null}
    </View>
  )
}

/**
 * A number box that owns its text, for the reason the web documents at length:
 * a controlled box running Number() per keystroke turns "1." into 1 and eats the
 * dot before the 5 arrives, which reads as "decimals are not allowed".
 */
export function useOwnedNumber(value: number | null | undefined, onChange: (n: number) => void, { min = 0, max = 9999 } = {}) {
  const [text, setText] = useState(String(value ?? ''))
  const mine = useRef(false)
  useEffect(() => {
    if (!mine.current) setText(String(value ?? ''))
    mine.current = false
  }, [value])
  const commit = (raw: string) => {
    const clean = String(raw).replace(',', '.').replace(/[^\d.]/g, '')
    mine.current = true
    setText(clean)
    const n = Number(clean)
    if (clean !== '' && Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)))
  }
  const reset = () => setText(String(value ?? ''))
  return { text, commit, reset }
}

/** .stepper: − / the amount, typeable / +. */
export function Stepper({ value, onChange, step = 1, min = 0, max = 9999, suffix }: {
  value: number
  onChange: (n: number) => void
  step?: number
  min?: number
  max?: number
  suffix?: string
}) {
  const { text, commit, reset } = useOwnedNumber(value, onChange, { min, max })
  const bump = (d: number) => onChange(Math.min(max, Math.max(min, round((Number(value) || 0) + d, 2) ?? 0)))
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
      <StepBtn label="Less" icon={Minus} onPress={() => bump(-step)} />
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
        <TextInput
          value={text}
          onChangeText={commit}
          onBlur={reset}
          keyboardType="decimal-pad"
          keyboardAppearance="dark"
          selectionColor={colors.accent}
          selectTextOnFocus
          accessibilityLabel="Amount"
          style={{ width: 96, fontSize: 30, fontWeight: '700', textAlign: 'center', color: colors.text, fontVariant: ['tabular-nums'], paddingVertical: 0 }}
        />
        {suffix ? <T muted>{suffix}</T> : null}
      </View>
      <StepBtn label="More" icon={Plus} onPress={() => bump(step)} />
    </View>
  )
}

/** .step-btn: the round − and + either side of an amount. */
export function StepBtn({ label, icon: Icon, onPress, children }: { label: string; icon?: IconType; onPress: () => void; children?: React.ReactNode }) {
  return (
    <Pressable
      onPress={() => { tap(); onPress() }}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [st.stepBtn, pressed && { backgroundColor: colors.accent, borderColor: colors.accent }]}
    >
      {({ pressed }) => (Icon ? <Icon size={20} color={pressed ? colors.onAccent : colors.text} /> : children)}
    </Pressable>
  )
}

/** .macro-readout: the big number and its three macros, centred in a card. */
export function MacroReadout({ kcal, unit = 'kcal', protein, carbs, fat, top, children }: {
  kcal: number
  unit?: string
  protein: number
  carbs: number
  fat: number
  top?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <View style={st.readout}>
      {top}
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
        <T size={40} weight={700} tabular lineHeight={46}>{kcal.toLocaleString()}</T>
        <T muted>{unit}</T>
      </View>
      <View style={{ flexDirection: 'row', gap: 14, flexWrap: 'wrap', justifyContent: 'center' }}>
        {([['protein', protein], ['carbs', carbs], ['fat', fat]] as const).map(([k, v]) => (
          <T key={k} size={13} muted><T size={13} weight={700}>{v}</T>g {k}</T>
        ))}
      </View>
      {children}
    </View>
  )
}

/** .filled-note: which numbers on a form are not his, with the glyph in amber. */
export function FilledNote({ icon: Icon, children, style }: { icon: IconType; children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[st.filled, style]}>
      <Icon size={14} color={colors.accent} style={{ marginTop: 3 }} />
      <T size={13} muted lineHeight={19} style={{ flex: 1 }}>{children}</T>
    </View>
  )
}

/** .row-btns: buttons sharing a row equally. */
export function RowBtns({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: 'row', gap: 10 }, style]}>{children}</View>
}

export function Loading({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[{ paddingVertical: 30, alignItems: 'center' }, style]}><ActivityIndicator color={colors.muted} /></View>
}

export const st = StyleSheet.create({
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    minHeight: TAP, paddingHorizontal: 20,
    borderWidth: 1, borderColor: colors.line, borderRadius: radius.r, backgroundColor: colors.panel2,
  },
  chip: {
    minHeight: TAP, justifyContent: 'center', alignItems: 'center',
    paddingVertical: 6, paddingHorizontal: 14,
    borderWidth: 1, borderColor: colors.line, borderRadius: radius.r, backgroundColor: colors.panel,
  },
  chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  seg: { flexDirection: 'row', padding: 3, borderRadius: radius.r, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line },
  segBtn: { flex: 1, minHeight: 40, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
  input: {
    flexDirection: 'row', alignItems: 'center', minHeight: TAP, paddingHorizontal: 14,
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: radius.r,
  },
  panel: { gap: 14, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: radius.panel, padding: 14 },
  big: {
    flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 72,
    paddingVertical: 14, paddingHorizontal: 16, borderWidth: 1, borderRadius: radius.panel, overflow: 'hidden',
  },
  search: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 14, paddingRight: 4,
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: radius.r,
  },
  stepBtn: {
    width: 52, height: 52, borderRadius: 26, borderWidth: 1, borderColor: colors.line,
    backgroundColor: colors.panel2, alignItems: 'center', justifyContent: 'center',
  },
  readout: { alignItems: 'center', gap: 6, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: radius.panel, padding: 18 },
  filled: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 10, paddingHorizontal: 12,
    borderRadius: radius.r, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line,
  },
})
