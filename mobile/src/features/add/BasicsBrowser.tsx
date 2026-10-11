/*
 * Krakatoa — the generic foods, by category. BasicsBrowser from app/src/add.jsx.
 * An egg, a tablespoon of butter, a cup of rice.
 *
 * The web folds each category in a <details>; here a category is a row that
 * opens in place, with the same count beside it.
 */

import React, { useMemo, useState } from 'react'
import { View } from 'react-native'
import { router } from 'expo-router'
import { ChevronDown } from '../../lib/icons'
import { byCategory, searchBasics, useBasics } from '../../lib/basics'
import { colors, hairline, radius, TAP } from '../../theme'
import { T } from '../../ui/Text'
import { Press, RowNote, SearchBox } from '../../ui/kit'
import { Pane } from '../../ui/Pane'
import FoodRow from './FoodRow'
import { pick } from './flow'

export default function BasicsBrowser() {
  const basics = useBasics()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const groups = useMemo(() => byCategory(basics), [basics])
  const hits = useMemo(() => searchBasics(basics.foods, q, 40), [basics.foods, q])

  return (
    <Pane title="Basic foods" onBack={() => router.back()} scrollProps={{ keyboardDismissMode: 'on-drag' }}>
      <SearchBox value={q} onChangeText={setQ} placeholder="egg, butter, rice…" label="Search basic foods" />

      {q.trim() ? (
        <View style={{ gap: 6 }}>
          {hits.length === 0 ? <RowNote>Nothing in the basics matches that.</RowNote> : null}
          {hits.map(f => (
            <FoodRow key={f.id} food={f} sub={f.portions[0]?.label} right={`${f.portions[0]?.kcal} kcal`} onPress={() => pick(f)} />
          ))}
        </View>
      ) : (
        groups.map(g => {
          const on = !!open[g.category]
          return (
            <View key={g.category} style={{ backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: radius.r, overflow: 'hidden' }}>
              <Press
                haptic
                accessibilityRole="button"
                accessibilityState={{ expanded: on }}
                onPress={() => setOpen(o => ({ ...o, [g.category]: !on }))}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: TAP, paddingHorizontal: 14, borderBottomWidth: on ? hairline : 0, borderBottomColor: colors.line }}
              >
                <T weight={600} style={{ flex: 1 }}>{g.category}</T>
                <View style={{ backgroundColor: colors.panel2, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 }}>
                  <T size={12} muted>{g.foods.length}</T>
                </View>
                <View style={{ transform: [{ rotate: on ? '180deg' : '0deg' }] }}><ChevronDown size={16} color={colors.muted} /></View>
              </Press>
              {on ? (
                <View style={{ padding: 8, gap: 6 }}>
                  {g.foods.map(f => (
                    <FoodRow key={f.id} food={f} sub={f.portions[0]?.label} right={`${f.portions[0]?.kcal} kcal`} onPress={() => pick(f)} />
                  ))}
                </View>
              ) : null}
            </View>
          )
        })
      )}
    </Pane>
  )
}
