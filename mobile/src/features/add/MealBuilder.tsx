/*
 * Krakatoa — building a combo you will have again: the iced latte, the shake, the
 * eggs. Called a COMBO on screen, not a meal, because a homemade iced latte is
 * not a meal. Breakfast, lunch, dinner and snack are still meals; those are
 * WHEN, a combo is WHAT. Ported from app/src/mealbuilder.jsx.
 *
 * The scrambled eggs case. Two ways in, and the second is the one that gets
 * used: build it from scratch here, or — far more likely — log the eggs, the
 * butter and the milk the ordinary way and then say "that was a meal", because
 * nobody assembles a recipe before they have cooked it.
 *
 * Components are added through the same picker everything else uses, so there is
 * no second way to choose a food. On the phone that picker is a push in the add
 * sheet's stack (flow.pickIngredient); the ingredient comes back through
 * flow.addComponents, which updates the draft and dismisses back to this screen.
 */

import React, { useEffect, useState } from 'react'
import { View } from 'react-native'
import { router } from 'expo-router'
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable'
import { Pane } from '../../ui/Pane'
import { T } from '../../ui/Text'
import Thumb from '../../ui/Thumb'
import { BigAction, Btn, Field, IconBtn, Input, ListHead, MacroReadout, Press, RowNote } from '../../ui/kit'
import { confirm, showMenu } from '../../ui/menu'
import { success } from '../../ui/haptics'
import { colors, radius, TAP } from '../../theme'
import { Ellipsis, Minus, Plus, Trash2 } from '../../lib/icons'
import { comboSummary, comboTotals, suggestName } from '../../lib/combos'
import { amountFor, portionLabel, round, titleOf } from '../../lib/food'
import { getStore } from '../../lib/store'
import type { Combo, Component } from '../../lib/types'
import { pickIngredient, useFlow } from './flow'

export default function MealBuilder() {
  const { draft } = useFlow()
  const [name, setName] = useState(draft?.name || '')
  const [components, setComponents] = useState<Component[]>(draft?.components || [])

  // The draft is where an ingredient comes back to (flow.addComponents), so when
  // it changes, take its components — and the name, which went out with it.
  useEffect(() => {
    setName(draft?.name || '')
    setComponents(draft?.components || [])
  }, [draft])

  const total = comboTotals(components)
  // The name is a PLACEHOLDER built from the components, never a pre-filled
  // value — same rule as the estimate on Bushido's minutes box. An invented name
  // sitting in the box is one he confirms without reading.
  const suggested = suggestName(components)
  const finalName = name.trim() || suggested

  const bump = (i: number, d: number) => setComponents(cs => cs.map((c, j) => (
    j === i ? { ...c, qty: Math.max(0.25, round((Number(c.qty) || 1) + d, 2) ?? 1) } : c
  )))

  const drop = (i: number) => setComponents(cs => cs.filter((_, j) => j !== i))

  const save = () => {
    getStore().saveCombo({ id: draft?.id, name: finalName, components })
    success()
    router.back()
  }

  return (
    <Pane
      title={draft?.id ? 'Edit combo' : 'New combo'}
      onBack={() => router.back()}
      foot={(
        <Btn
          kind="primary"
          disabled={!components.length || !finalName}
          onPress={save}
          title={draft?.id ? 'Save changes' : `Save “${finalName || 'combo'}”`}
        />
      )}
    >
      <Field label="What do you call it">
        <Input
          value={name}
          onChangeText={setName}
          placeholder={suggested || 'Scrambled eggs'}
          accessibilityLabel="What do you call it"
          returnKeyType="done"
        />
      </Field>

      <MacroReadout kcal={total.kcal} unit="kcal a serving" protein={total.protein} carbs={total.carbs} fat={total.fat} />

      <View style={{ gap: 8 }}>
        <ListHead title="What is in it" />
        {components.length === 0 && (
          <RowNote>Nothing yet — add the first thing below.</RowNote>
        )}
        {components.map((c, i) => (
          <CompRow
            key={`${c.name}-${i}`}
            c={c}
            onLess={() => bump(i, -0.25)}
            onMore={() => bump(i, 0.25)}
            onRemove={() => drop(i)}
          />
        ))}
        <BigAction
          kind="subtle"
          icon={Plus}
          title="Add an ingredient"
          sub="Scan it, search it, or pick a basic"
          onPress={() => pickIngredient({ ...(draft || {}), name, components })}
          style={{ marginTop: 4 }}
        />
      </View>
    </Pane>
  )
}

/**
 * One ingredient: −, +, and the bin, as on the web. The row also swipes left to a
 * red Remove, which is how every list on the phone deletes a row.
 */
function CompRow({ c, onLess, onMore, onRemove }: { c: Component; onLess: () => void; onMore: () => void; onRemove: () => void }) {
  const a = amountFor(c.portion, c.qty)
  return (
    <ReanimatedSwipeable
      friction={2}
      rightThreshold={40}
      overshootRight={false}
      containerStyle={{ borderRadius: radius.r }}
      renderRightActions={(_p, _t, methods) => (
        <Press
          haptic
          accessibilityRole="button"
          accessibilityLabel="Remove"
          onPress={() => { methods.close(); onRemove() }}
          style={{ width: 96, marginLeft: 8, borderRadius: radius.r, backgroundColor: colors.danger, alignItems: 'center', justifyContent: 'center' }}
        >
          <T size={15} weight={700} color={colors.onDanger}>Remove</T>
        </Press>
      )}
    >
      <View style={{
        flexDirection: 'row', alignItems: 'center', gap: 8,
        paddingVertical: 8, paddingLeft: 12, paddingRight: 6,
        backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: radius.r,
      }}
      >
        <Thumb food={c} size={38} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T weight={600} numberOfLines={1}>{titleOf(c)}</T>
          <T size={12} muted numberOfLines={1}>{portionLabel(c.qty, c.portion)} · {a.kcal} kcal</T>
        </View>
        <IconBtn icon={Minus} sm size={16} label="Less" onPress={onLess} />
        <IconBtn icon={Plus} sm size={16} label="More" onPress={onMore} />
        <IconBtn icon={Trash2} sm ghost size={16} label="Remove" onPress={onRemove} />
      </View>
    </ReanimatedSwipeable>
  )
}

/**
 * The row a saved combo renders as, in the add screen's list. The web's ⋯ opens
 * the editor; here it opens the system menu with Edit and Delete, because a long
 * list of combos needs a way to lose one that is not "open it and empty it".
 */
export function MealRow({ combo, onPress, onEdit }: { combo: Combo; onPress: () => void; onEdit: () => void }) {
  const t = comboTotals(combo.components)
  const menu = () => showMenu([
    { label: 'Edit combo', onPress: onEdit },
    {
      label: 'Delete combo',
      destructive: true,
      onPress: () => {
        void confirm(`Delete “${combo.name}”?`, { message: 'The times you logged it stay in the log.' })
          .then(ok => { if (ok) getStore().removeCombo(combo.id) })
      },
    },
  ], { title: combo.name })
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', minHeight: TAP,
      borderWidth: 1, borderColor: colors.line, borderRadius: radius.r, backgroundColor: colors.panel,
    }}
    >
      <Press
        haptic
        accessibilityRole="button"
        onPress={onPress}
        onLongPress={menu}
        style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingLeft: 14 }}
      >
        <Thumb food={{ name: combo.name, gtin: combo.components.find(c => c.gtin)?.gtin, image: combo.components.find(c => c.image)?.image }} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T weight={600} numberOfLines={1}>{combo.name}</T>
          <T size={12} muted numberOfLines={1}>{comboSummary(combo)}</T>
        </View>
        <T size={13} muted tabular>{t.kcal} kcal</T>
      </Press>
      <IconBtn icon={Ellipsis} sm ghost size={18} label={`Edit ${combo.name}`} onPress={menu} style={{ marginHorizontal: 4 }} />
    </View>
  )
}
