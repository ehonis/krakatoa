/*
 * Krakatoa — how much, and which meal. FoodDetail from app/src/add.jsx.
 *
 * The portion list comes from the database and the real-world serving leads it
 * — see server/nutrition.js on why 100 g is never first when a bar is a bar.
 */

import React, { useState } from 'react'
import { router } from 'expo-router'
import { Star } from '../../lib/icons'
import { MEALS, amountFor, mealLabel, mealNow, portionLabel, titleOf } from '../../lib/food'
import { useStore } from '../../lib/store'
import type { Portion } from '../../lib/types'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Chip, Chips, Field, Hint, IconBtn, MacroReadout, Stepper } from '../../ui/kit'
import { CenterPane, Pane } from '../../ui/Pane'
import Thumb from '../../ui/Thumb'
import { success, tap } from '../../ui/haptics'
import { finish, useFlow } from './flow'

export default function FoodDetail() {
  const store = useStore()
  const { mode, date, ...flow } = useFlow()
  // The food this screen was opened on, kept: another pick pushes another
  // detail screen over this one rather than changing this one underneath.
  const [{ picked: food, defaults }] = useState(() => ({ picked: flow.picked, defaults: flow.defaults }))
  const portions: Portion[] = food?.portions?.length ? food.portions : [{ id: 'serving', label: 'serving', kcal: 0 }]
  // A chain item opens on the size you would order unasked (a medium fry), not
  // the first one listed (the small).
  const [portionId, setPortionId] = useState(defaults?.portion?.id || food?.defaultPortion || portions[0].id)
  const [qty, setQty] = useState(defaults?.qty ?? 1)
  const [meal, setMeal] = useState(defaults?.meal || mealNow())

  if (!food) return <CenterPane><T muted>Nothing picked.</T></CenterPane>

  const portion = portions.find(p => p.id === portionId) || portions[0]
  const amount = amountFor(portion, qty)
  const forMeal = mode === 'component'
  const starred = store.isStarred(food)

  return (
    <Pane
      title={titleOf(food)}
      onBack={() => router.back()}
      right={
        /* Starring here rather than only after eating: the point of a star is
           the protein powder he has just looked up and has not had yet. */
        <IconBtn
          icon={Star}
          size={22}
          color={starred ? colors.accent : colors.text}
          fill={starred ? colors.accent : undefined}
          label={starred ? 'Unstar' : 'Star this food'}
          onPress={() => { tap(); if (starred) store.unstarFood(food); else store.starFood(food) }}
        />
      }
      foot={
        <Btn
          kind="primary"
          title={forMeal
            ? `Add ${amount.kcal.toLocaleString()} kcal to the combo`
            : `Add ${amount.kcal.toLocaleString()} kcal to ${mealLabel(meal)}`}
          onPress={() => { success(); finish({ food, portion, qty, meal, date }) }}
        />
      }
    >
      <MacroReadout kcal={amount.kcal} protein={amount.protein} carbs={amount.carbs} fat={amount.fat} top={<Thumb food={food} size={72} />}>
        {food.usdaName ? <T size={11} muted align="center" style={{ maxWidth: 280, marginTop: 4 }}>USDA · {food.usdaName}</T> : null}
        {food.source === 'label' ? <T size={11} muted align="center" style={{ marginTop: 4 }}>From its nutrition label, as you saved it</T> : null}
        {food.source === 'ai' ? <T size={11} muted align="center" style={{ marginTop: 4 }}>Estimated by AI — nobody publishes this one</T> : null}
      </MacroReadout>

      {portions.length > 1 ? (
        <Field label="Serving">
          <Chips>
            {portions.map(p => (
              <Chip key={p.id} label={p.label} sub={`${p.kcal} kcal`} on={p.id === portionId} onPress={() => setPortionId(p.id)} />
            ))}
          </Chips>
        </Field>
      ) : null}

      <Field label="How many">
        {/* Quarters, because half a bar and a quarter of a pizza are the two
            corrections anyone actually makes. */}
        <Stepper value={qty} onChange={setQty} step={0.25} min={0.25} max={99} />
        <Hint>{portionLabel(qty, portion)}</Hint>
      </Field>

      {/* A component of a meal has no meal of its own — the meal does. */}
      {!forMeal ? (
        <Field label="Meal">
          <Chips>
            {MEALS.map(m => <Chip key={m.id} label={m.label} on={m.id === meal} onPress={() => setMeal(m.id)} />)}
          </Chips>
        </Field>
      ) : null}
    </Pane>
  )
}
