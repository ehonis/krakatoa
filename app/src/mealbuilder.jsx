/*
 * Krakatoa — building a combo you will have again: the iced latte, the shake, the
 * eggs. Called a COMBO on screen, not a meal, because a homemade iced latte is
 * not a meal. Breakfast, lunch, dinner and snack are still meals; those are
 * WHEN, a combo is WHAT.
 *
 * The scrambled eggs case. Two ways in, and the second is the one that gets
 * used: build it from scratch here, or — far more likely — log the eggs, the
 * butter and the milk the ordinary way and then say "that was a meal", because
 * nobody assembles a recipe before they have cooked it.
 *
 * Components are added through the same picker everything else uses, so there is
 * no second way to choose a food.
 */

import { useState } from 'react'
import { ChevronLeft, Plus, Trash2, Minus } from 'lucide-react'
import Thumb from './thumb.jsx'
import { comboSummary, comboTotals, suggestName } from './lib/combos.js'
import { amountFor, portionLabel, round, titleOf } from './lib/food.js'

export default function MealBuilder({ initial, onBack, onSave, onAddComponent }) {
  const [name, setName] = useState(initial?.name || '')
  const [components, setComponents] = useState(initial?.components || [])

  const total = comboTotals(components)
  // The name is a PLACEHOLDER built from the components, never a pre-filled
  // value — same rule as the estimate on Bushido's minutes box. An invented name
  // sitting in the box is one he confirms without reading.
  const suggested = suggestName(components)
  const finalName = name.trim() || suggested

  const bump = (i, d) => setComponents(cs => cs.map((c, j) => (
    j === i ? { ...c, qty: Math.max(0.25, round((Number(c.qty) || 1) + d, 2)) } : c
  )))

  const drop = (i) => setComponents(cs => cs.filter((_, j) => j !== i))

  return (
    <div className="pane">
      <header className="pane-head">
        <button className="icon-btn" onClick={onBack} aria-label="Back"><ChevronLeft size={24} /></button>
        <h2>{initial?.id ? 'Edit combo' : 'New combo'}</h2>
      </header>

      <div className="pane-body">
        <section className="field">
          <label htmlFor="mb-name">What do you call it</label>
          <input
            id="mb-name"
            className="text-input"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={suggested || 'Scrambled eggs'}
          />
        </section>

        <div className="macro-readout">
          <div className="macro-readout-kcal">
            <strong>{total.kcal.toLocaleString()}</strong>
            <span>kcal a serving</span>
          </div>
          <div className="macro-readout-macros">
            <span><b>{total.protein}</b>g protein</span>
            <span><b>{total.carbs}</b>g carbs</span>
            <span><b>{total.fat}</b>g fat</span>
          </div>
        </div>

        <section className="list">
          <h3 className="list-head">What is in it</h3>
          {components.length === 0 && (
            <p className="muted row-note">Nothing yet — add the first thing below.</p>
          )}
          {components.map((c, i) => {
            const a = amountFor(c.portion, c.qty)
            return (
              <div className="comp-row" key={`${c.name}-${i}`}>
                <Thumb food={c} size={38} />
                <span className="comp-main">
                  <span className="comp-name">{titleOf(c)}</span>
                  <span className="comp-sub">{portionLabel(c.qty, c.portion)} · {a.kcal} kcal</span>
                </span>
                <button className="icon-btn sm" onClick={() => bump(i, -0.25)} aria-label="Less"><Minus size={16} /></button>
                <button className="icon-btn sm" onClick={() => bump(i, 0.25)} aria-label="More"><Plus size={16} /></button>
                <button className="icon-btn sm ghost" onClick={() => drop(i)} aria-label="Remove"><Trash2 size={16} /></button>
              </div>
            )
          })}
          <button
            className="big-action subtle"
            onClick={() => onAddComponent(components, name, (c) => setComponents(cs => [...cs, c]))}
          >
            <Plus size={22} />
            <span>
              <strong>Add an ingredient</strong>
              <small>Scan it, search it, or pick a basic</small>
            </span>
          </button>
        </section>
      </div>

      <footer className="pane-foot">
        <button
          className="btn btn-primary"
          disabled={!components.length || !finalName}
          onClick={() => onSave({ id: initial?.id, name: finalName, components })}
        >
          {initial?.id ? 'Save changes' : `Save “${finalName || 'combo'}”`}
        </button>
      </footer>
    </div>
  )
}

/** The row a saved meal renders as, in the add screen's list. */
export function MealRow({ combo, onClick, onEdit }) {
  const t = comboTotals(combo.components)
  return (
    <div className="food-row meal-row">
      <button className="meal-main" onClick={onClick}>
        <Thumb food={{ name: combo.name, gtin: combo.components.find(c => c.gtin)?.gtin, image: combo.components.find(c => c.image)?.image }} />
        <span className="food-row-main">
          <span className="food-row-name">{combo.name}</span>
          <span className="food-row-sub">{comboSummary(combo)}</span>
        </span>
        <span className="food-row-kcal">{t.kcal} kcal</span>
      </button>
      <button className="icon-btn sm ghost" onClick={onEdit} aria-label={`Edit ${combo.name}`}>⋯</button>
    </div>
  )
}
