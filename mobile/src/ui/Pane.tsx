// The web's .pane: a head (back or close, a title, actions), a body that scrolls,
// and a foot pinned under it that rides the keyboard. On the web a pane is a
// full-screen overlay; here it is the content of a page sheet, so the head needs
// no status-bar inset and the sheet itself swipes down to close.
//
// The body keeps the focused field above the foot and the keyboard
// (KeyboardAwareScrollView): a plain ScrollView leaves a box low in a long form,
// such as the label's, under the keyboard inside a page sheet.
import React, { useState } from 'react'
import { StyleSheet, View, type ScrollView, type ScrollViewProps, type StyleProp, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { KeyboardAvoidingView, KeyboardAwareScrollView, type KeyboardAwareScrollViewRef } from 'react-native-keyboard-controller'
import { colors, hairline } from '../theme'
import { ChevronLeft, X } from '../lib/icons'
import { T } from './Text'
import { IconBtn } from './kit'

export function PaneHead({ title, onBack, onClose, right }: {
  title: string
  /** A back chevron on the left. */
  onBack?: () => void
  /** A close cross on the right (the web's top-level panes). */
  onClose?: () => void
  right?: React.ReactNode
}) {
  return (
    <View style={st.head}>
      {onBack ? <IconBtn icon={ChevronLeft} label="Back" onPress={onBack} /> : <View style={{ width: 8 }} />}
      <T size={18} weight={700} numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>{title}</T>
      {right}
      {onClose ? <IconBtn icon={X} label="Close" onPress={onClose} /> : null}
    </View>
  )
}

export function Pane({ title, onBack, onClose, right, foot, children, center, scrollRef, bodyStyle, scrollProps, head }: {
  title?: string
  onBack?: () => void
  onClose?: () => void
  right?: React.ReactNode
  foot?: React.ReactNode
  children?: React.ReactNode
  /** .pane-center: a message in the middle instead of a list. */
  center?: boolean
  scrollRef?: React.Ref<ScrollView>
  bodyStyle?: StyleProp<ViewStyle>
  scrollProps?: ScrollViewProps
  /** A head of its own instead of PaneHead. */
  head?: React.ReactNode
}) {
  const insets = useSafeAreaInsets()
  const bottom = Math.max(insets.bottom, 12)
  // The foot rides the keyboard, so a focused field has to clear it too.
  const [footHeight, setFootHeight] = useState(0)
  return (
    <KeyboardAvoidingView behavior="padding" style={st.pane}>
      {head ?? (title !== undefined ? <PaneHead title={title} onBack={onBack} onClose={onClose} right={right} /> : null)}
      <KeyboardAwareScrollView
        ref={scrollRef as React.Ref<KeyboardAwareScrollViewRef>}
        style={{ flex: 1 }}
        contentContainerStyle={[st.body, center && st.center, !foot && { paddingBottom: bottom + 16 }, bodyStyle]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        bottomOffset={(foot ? footHeight : 0) + 16}
        {...scrollProps}
      >
        {children}
      </KeyboardAwareScrollView>
      {foot ? <View style={[st.foot, { paddingBottom: bottom }]} onLayout={(e) => setFootHeight(e.nativeEvent.layout.height)}>{foot}</View> : null}
    </KeyboardAvoidingView>
  )
}

/** .pane.pane-center with nothing else in it: a spinner or a message, mid-sheet. */
export function CenterPane({ children }: { children: React.ReactNode }) {
  return <View style={[st.pane, st.center, { padding: 16 }]}>{children}</View>
}

const st = StyleSheet.create({
  pane: { flex: 1, backgroundColor: colors.bg },
  head: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingTop: 10, paddingBottom: 8, paddingHorizontal: 8,
    borderBottomWidth: hairline, borderBottomColor: colors.line,
  },
  body: { padding: 16, gap: 18 },
  center: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  foot: { paddingTop: 12, paddingHorizontal: 16, borderTopWidth: hairline, borderTopColor: colors.line, backgroundColor: colors.panel, gap: 10 },
})
