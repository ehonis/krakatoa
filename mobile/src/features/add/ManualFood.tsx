/*
 * Krakatoa — add it by hand. ManualFood and LookupHelper from app/src/add.jsx.
 *
 * The escape hatch, and the answer for everything with no barcode on it.
 */

import React, { useMemo, useState } from 'react'
import { View } from 'react-native'
import { router } from 'expo-router'
import { RotateCw, Search, Sparkles } from '../../lib/icons'
import { searchBasics, useBasics, type Basics } from '../../lib/basics'
import { titleOf } from '../../lib/food'
import { apiFetch } from '../../lib/connection'
import type { Food } from '../../lib/types'
import { colors, radius, TAP } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Field, FilledNote, Input, Link, Press, RowNote } from '../../ui/kit'
import { Pane } from '../../ui/Pane'
import FoodRow from './FoodRow'
import { pick, useFlow } from './flow'

/**
 * Look the typed name up without leaving the form. This closes a real gap:
 * the only search in the app was on the screen BEFORE this one, so landing here
 * from a missed scan meant either backing out or typing calories from memory.
 *
 * It does not search until asked. An automatic search on every keystroke would
 * put a list of half-matches under a half-typed word, and the name box is the
 * one field on this screen that is always right — he knows what he ate.
 */
function LookupHelper({ query, basics, onFill }: { query: string; basics: Basics; onFill: (food: Food) => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Food[] | null>(null)
  const q = query.trim()

  // The basics answer instantly and offline, so they are shown the moment he
  // asks while the two databases are still being waited on.
  const local = useMemo(() => searchBasics(basics.foods, q, 6), [basics.foods, q])

  const run = async () => {
    setOpen(true)
    setBusy(true)
    try {
      const res = await apiFetch(`/api/search?q=${encodeURIComponent(q)}`)
      const body = await res.json()
      setResults(body.foods || [])
    } catch {
      setResults([])
    } finally {
      setBusy(false)
    }
  }

  if (q.length < 2) return null

  if (!open) {
    return (
      <Press
        haptic
        onPress={run}
        accessibilityRole="button"
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: TAP, paddingHorizontal: 16, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.line, borderRadius: radius.r }}
      >
        <Search size={16} color={colors.accent} />
        <T weight={600} color={colors.accent} style={{ flexShrink: 1 }}>Look up “{q}” for the calories</T>
      </Press>
    )
  }

  const shown = [...local, ...(results || [])].slice(0, 10)

  return (
    <Field
      label="Tap one to fill the numbers in"
      right={<Link sm icon={RotateCw} title="Search again" color={colors.accent} onPress={run} disabled={busy} />}
    >
      {busy && !local.length ? <RowNote spin>Searching…</RowNote> : null}
      {!busy && shown.length === 0 ? <RowNote>Nothing found — type the numbers below.</RowNote> : null}
      <View style={{ gap: 6 }}>
        {shown.map((food, i) => (
          <FoodRow
            key={`${food.gtin || food.id || food.name}-${i}`}
            food={food}
            sub={food.portions[0]?.label}
            right={`${food.portions[0]?.kcal} kcal`}
            badge={food.source}
            onPress={() => { onFill(food); setOpen(false) }}
          />
        ))}
      </View>
    </Field>
  )
}

export default function ManualFood() {
  const flow = useFlow()
  const basics = useBasics()
  const [name, setName] = useState(flow.query.trim())
  const [kcal, setKcal] = useState('')
  const [protein, setProtein] = useState('')
  const [carbs, setCarbs] = useState('')
  const [fat, setFat] = useState('')
  const [filledFrom, setFilledFrom] = useState<{ label: string; source?: string; name: string } | null>(null)

  const n = (v: string) => (v === '' ? 0 : Number(v) || 0)
  const ready = name.trim() && kcal !== '' && Number(kcal) > 0
  const digits = (v: string) => v.replace(/[^\d.]/g, '')

  /*
   * Taking the numbers off a database result and dropping them into the boxes,
   * rather than jumping to the detail screen. The difference matters: this screen
   * is where he lands when a scan MISSED, so the food is usually nearly-but-not-
   * quite one of the results — his leftovers are not the restaurant's portion —
   * and every field stays his to correct afterwards.
   */
  const fillFrom = (food: Food) => {
    const p = food.portions?.[0]
    if (!p) return
    setName(prev => prev.trim() || food.name)
    setKcal(String(p.kcal ?? ''))
    setProtein(p.protein == null ? '' : String(p.protein))
    setCarbs(p.carbs == null ? '' : String(p.carbs))
    setFat(p.fat == null ? '' : String(p.fat))
    setFilledFrom({ label: p.label, source: food.source, name: titleOf(food) })
  }

  const sourceName = (s?: string) => (s === 'usda' ? 'USDA' : s === 'basic' ? 'the basics' : s === 'label' ? 'its label' : 'Open Food Facts')

  return (
    <Pane
      title="Add it by hand"
      onBack={() => router.back()}
      foot={
        <Btn
          kind="primary"
          title="Next"
          disabled={!ready}
          onPress={() => pick({
            name: name.trim(),
            brand: null,
            gtin: null,
            source: 'manual',
            image: null,
            portions: [{ id: 'serving', label: 'serving', grams: null, kcal: n(kcal), protein: n(protein), carbs: n(carbs), fat: n(fat) }],
          })}
        />
      }
    >
      <Field label="What was it">
        <Input value={name} onChangeText={setName} placeholder="Chicken burrito" autoFocus returnKeyType="next" accessibilityLabel="What was it" />
      </Field>

      <LookupHelper query={name} basics={basics} onFill={fillFrom} />

      {filledFrom ? (
        <FilledNote icon={Sparkles}>
          Numbers from <T size={13} color={colors.text} weight={700}>{filledFrom.name}</T> ({filledFrom.label}, {sourceName(filledFrom.source)}).
          {' '}Change anything that was not what you had.
        </FilledNote>
      ) : null}

      <Field label="Calories">
        <Input value={kcal} onChangeText={(v) => setKcal(digits(v))} placeholder="650" keyboardType="decimal-pad" accessibilityLabel="Calories" />
      </Field>
      {/* Macros are optional on purpose. A number he does not know is a field
          that stops the form, and calories alone is still a logged meal. */}
      <Field label="Macros, if you know them">
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {([['protein', protein, setProtein], ['carbs', carbs, setCarbs], ['fat', fat, setFat]] as const).map(([label, value, setter]) => (
            <View key={label} style={{ flex: 1, alignItems: 'center', gap: 4 }}>
              <Input value={value} onChangeText={(v) => setter(digits(v))} placeholder="0" keyboardType="decimal-pad" accessibilityLabel={label} boxStyle={{ alignSelf: 'stretch' }} textStyle={{ textAlign: 'center' }} />
              <T size={12} muted>{label}</T>
            </View>
          ))}
        </View>
      </Field>
    </Pane>
  )
}
