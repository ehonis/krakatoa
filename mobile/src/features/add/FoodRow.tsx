// .food-row from app/src/add.jsx: the square, the name and a line, where the
// number came from (`.src`), and the calories. One row for every list a food is
// picked from.
import React from 'react'
import { StyleSheet, View } from 'react-native'
import { titleOf } from '../../lib/food'
import { colors, radius, TAP } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import Thumb from '../../ui/Thumb'

/* Where a number came from. Worth showing: OFF is crowdsourced and USDA is not. */
const SRC_COLOR: Record<string, string> = { usda: colors.tone2, basic: colors.tone1, combo: colors.accent, restaurant: colors.accent }

export function Src({ badge }: { badge: string }) {
  return (
    <View style={st.src}>
      <T size={10} caps color={SRC_COLOR[badge] || colors.muted} lineHeight={13}>{badge}</T>
    </View>
  )
}

export default function FoodRow({ food, sub, right, onPress, badge }: {
  food: { name?: string | null; brand?: string | null; gtin?: string | null; image?: string | null }
  sub?: string | null
  right?: string | null
  onPress?: () => void
  badge?: string | null
}) {
  return (
    <Press haptic style={st.row} onPress={onPress} accessibilityRole="button">
      <Thumb food={food} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T weight={600} numberOfLines={1}>{titleOf(food)}</T>
        {sub ? <T size={12} muted numberOfLines={1}>{sub}</T> : null}
      </View>
      {badge ? <Src badge={badge} /> : null}
      {right ? <T size={13} muted tabular>{right}</T> : null}
    </Press>
  )
}

export const st = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: TAP,
    paddingVertical: 10, paddingHorizontal: 14,
    borderWidth: 1, borderColor: colors.line, borderRadius: radius.r, backgroundColor: colors.panel,
  },
  src: { paddingVertical: 2, paddingHorizontal: 6, borderRadius: 6, backgroundColor: colors.panel2 },
})
