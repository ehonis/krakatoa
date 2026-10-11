/*
 * Krakatoa — meals you build once.
 *
 * The case it exists for: scrambled eggs made from 4 eggs, 1 tbsp of butter
 * and a dash of milk, eaten several times a week, and not worth rebuilding
 * every time.
 *
 * A COMBO is a named list of components, each one an ordinary
 * `{ food, portion, qty }` — the same three things the log screen asks for. It
 * is stored as an entry (`kind: 'combo'`, no date) so it syncs and merges like
 * everything else rather than being a second kind of store.
 *
 * Logging one writes ONE food entry, not several. Two reasons, and the second is
 * the one that matters: scrambled eggs is one thing he ate and should be one row
 * he can delete in one tap; and every reader downstream — the day total, the
 * digest, the Totem note — keeps working unchanged, because what lands is an
 * ordinary food entry that happens to carry its `components`.
 *
 * Pure. The store does the writing. Ported from app/src/lib/combos.js; keep the
 * two in step.
 */

import { amountFor, round } from './food'
import type { Combo, Component, Entry, Food, Item, Portion } from './types'

/** What one serving of a combo costs: its components, summed. */
export function comboTotals(components: Component[] | null | undefined) {
  const sum = { kcal: 0, protein: 0, carbs: 0, fat: 0 }
  for (const c of components || []) {
    const a = amountFor(c.portion, c.qty)
    sum.kcal += a.kcal
    sum.protein += a.protein
    sum.carbs += a.carbs
    sum.fat += a.fat
  }
  return {
    kcal: Math.round(sum.kcal),
    protein: round(sum.protein, 1) ?? 0,
    carbs: round(sum.carbs, 1) ?? 0,
    fat: round(sum.fat, 1) ?? 0,
  }
}

/**
 * A combo behaves like any other food: one PORTION called "1 serving", carrying
 * the summed macros. That is what lets it travel through the same detail screen,
 * the same quantity stepper and the same log writer as a scanned bar — half a
 * batch of scrambled eggs is 0.5 of this portion and needs no special case.
 */
export function comboAsFood(combo: Combo): Food {
  const t = comboTotals(combo.components)
  return {
    name: combo.name,
    brand: null,
    gtin: null,
    // A combo has no photo of its own. The first component that HAS one lends it,
    // so a saved breakfast still reads as a picture in the list rather than a
    // letter tile — it is a picture of the eggs, which is honest enough.
    image: combo.components?.find(c => c.image)?.image || null,
    imageGtin: combo.components?.find(c => c.image && c.gtin)?.gtin || null,
    source: 'combo',
    comboId: combo.id,
    portions: [{ id: 'combo', label: '1 serving', grams: null, ...t }],
  }
}

/** The one-line summary under a meal's name: "4 large eggs · 1 tbsp · a dash". */
export function comboSummary(combo: Combo, max = 3) {
  const parts = (combo.components || []).map(c => c.name)
  if (parts.length <= max) return parts.join(', ')
  return `${parts.slice(0, max).join(', ')} +${parts.length - max} more`
}

/**
 * Turn logged entries back into components. This is the path that matters most:
 * he logs the eggs, the butter and the milk the ordinary way, then says "that
 * was a meal" — rather than building it up front, which is a thing nobody does
 * before they have eaten.
 */
export function componentsFromEntries(items: Item[] | null | undefined): Component[] {
  return (items || []).map(i => ({
    name: i.name,
    brand: i.brand || null,
    gtin: i.gtin || null,
    image: i.image || null,
    source: i.source || 'manual',
    portion: i.portion,
    qty: i.qty ?? 1,
  }))
}

/** A component, from a food and a chosen portion. Used by the meal builder. */
export const componentOf = (food: Partial<Food> & { name: string }, portion: Portion, qty?: number | null): Component => ({
  name: food.name,
  brand: food.brand || null,
  gtin: food.gtin || null,
  image: food.image || null,
  source: food.source || 'manual',
  portion,
  qty: qty ?? 1,
})

/**
 * A name for a meal nobody has named. Built from its components rather than
 * "Meal 3", because a list of meals called Meal 1..9 is a list you have to open
 * one at a time to use.
 */
export function suggestName(components: Component[] | null | undefined) {
  const names = (components || []).map(c => String(c.name || '').split(',')[0].trim()).filter(Boolean)
  if (!names.length) return ''
  if (names.length === 1) return names[0]
  return `${names[0]} + ${names.length - 1} more`
}

/** Live combos, newest first. Tombstones and other entry kinds are not combos. */
export function listCombos(entries: Record<string, Entry> | null | undefined): Combo[] {
  return Object.values(entries || {})
    .filter(e => e && !e.deleted && e.kind === 'combo' && e.data?.components?.length)
    .map(e => ({ id: e.id, ...e.data }))
    .sort((a, b) => String(b.lastUsedAt || b.createdAt || '').localeCompare(String(a.lastUsedAt || a.createdAt || '')))
}
