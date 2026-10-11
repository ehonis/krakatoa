/*
 * Krakatoa — daily targets. Ported from TargetsPane in app/src/today.jsx, as a
 * page sheet over the day.
 */

import React, { useState } from 'react'
import { View } from 'react-native'
import { router } from 'expo-router'
import { useStore } from '../../lib/store'
import { T } from '../../ui/Text'
import { Btn, Field, Hint, Input } from '../../ui/kit'
import { Pane } from '../../ui/Pane'
import { success } from '../../ui/haptics'

export default function TargetsPane() {
  const store = useStore()
  const targets = store.targets
  const [form, setForm] = useState({
    kcal: targets.kcal != null ? String(targets.kcal) : '',
    protein: targets.protein != null ? String(targets.protein) : '',
    carbs: targets.carbs != null ? String(targets.carbs) : '',
    fat: targets.fat != null ? String(targets.fat) : '',
    water: targets.water != null ? String(targets.water) : '',
  })
  const set = (k: keyof typeof form) => (v: string) => setForm(f => ({ ...f, [k]: v.replace(/[^\d.]/g, '') }))
  const clean = (v: string) => (v === '' ? null : Number(v) || null)

  const save = () => {
    store.setTargets({
      kcal: clean(form.kcal),
      protein: clean(form.protein),
      carbs: clean(form.carbs),
      fat: clean(form.fat),
      water: clean(form.water),
    })
    success()
    router.back()
  }

  return (
    <Pane
      title="Daily targets"
      onClose={() => router.back()}
      foot={<Btn kind="primary" title="Save" onPress={save} />}
    >
      <T muted>
        Leave any of these blank and the app simply will not draw a bar for it —
        a target nobody set is not a target of zero.
      </T>
      <Field label="Calories">
        <Input value={form.kcal} onChangeText={set('kcal')} placeholder="2400" keyboardType="number-pad" accessibilityLabel="Calories" />
      </Field>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {([['protein', '160', 'protein g'], ['carbs', '250', 'carbs g'], ['fat', '80', 'fat g']] as const).map(([k, ph, label]) => (
          <View key={k} style={{ flex: 1, alignItems: 'center', gap: 4 }}>
            <Input value={form[k]} onChangeText={set(k)} placeholder={ph} keyboardType="number-pad" accessibilityLabel={label} boxStyle={{ alignSelf: 'stretch' }} textStyle={{ textAlign: 'center' }} />
            <T size={12} muted>{label}</T>
          </View>
        ))}
      </View>
      <Field label="Water / liquids">
        <Input value={form.water} onChangeText={set('water')} placeholder="64" keyboardType="number-pad" accessibilityLabel="Water in ounces" />
        {/* The one target with a default, because the glass has to be a
            fraction of SOMETHING to be drawn at all — and eight 8 oz glasses
            is the figure everyone already has in their head. */}
        <Hint>Ounces a day. Left blank it uses 64.</Hint>
      </Field>
    </Pane>
  )
}
