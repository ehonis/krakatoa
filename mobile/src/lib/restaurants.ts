/*
 * Krakatoa — chain menus and the bowl you build from one.
 *
 * The menus are CONTENT, generated from each chain's own published nutrition
 * PDF by `scripts/restaurants.build.mjs` and cross-checked against the chain's
 * web page. Fetched once and kept, like the basics, so a bowl can be built in a
 * restaurant queue with no signal.
 *
 * A build-your-own chain is not a list of dishes, it is a list of PARTS — which
 * is why a bowl here is built step by step (base, protein, toppings, sauce)
 * rather than picked from a flat menu of 58 things. Pure: nothing here fetches
 * except `loadRestaurants`, and nothing writes.
 *
 * Ported from app/src/lib/restaurants.js. As with the basics, the phone keeps a
 * copy in localStorage so a bowl can still be built with no signal.
 */

import { useEffect, useState } from 'react'
import { amountFor, round as round0 } from './food'
import { componentOf } from './combos'
import { apiFetch } from './connection'
import type { Component, Portion } from './types'

const round = (n: number, dp = 1) => round0(n, dp) ?? 0
const KEY = 'krakatoa.restaurants.v1'

/* A chain as content/restaurants.json has it. Loose: the build script owns it. */
export type Chain = Record<string, any> & { id: string; name: string; short: string; kind?: string; items: MenuItem[]; steps?: Step[]; sizes?: Size[] }
export type MenuItem = Record<string, any> & { id: string; name: string; step: string; category: string; portions: Portion[]; defaultPortion?: string }
export type Step = Record<string, any> & { id: string; label: string; increment?: number; split?: boolean; names?: boolean; extra?: boolean; collapsed?: boolean; hint?: string }
export type Size = Record<string, any> & { id: string; label: string; scale?: Record<string, number>; vessel?: string }
export type Selection = Record<string, number>
export interface Restaurants { chains: Chain[]; built: boolean }

let cache: Restaurants | null = null
let fetched = false
let inFlight: Promise<Restaurants> | null = null

function stored(): Restaurants | null {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || 'null')
    return d?.chains ? { chains: d.chains, built: d.built !== false } : null
  } catch { return null }
}

export async function loadRestaurants(): Promise<Restaurants> {
  cache = cache || stored()
  if (cache && fetched) return cache
  if (inFlight) return inFlight
  inFlight = apiFetch('/api/restaurants')
    .then(r => r.json())
    .then(d => {
      fetched = true
      cache = { chains: d.chains || [], built: d.built !== false }
      try { localStorage.setItem(KEY, JSON.stringify(cache)) } catch { /* the copy in memory still works */ }
      return cache
    })
    .catch(() => cache || { chains: [], built: true })
    .finally(() => { inFlight = null })
  return inFlight
}

export function useRestaurants(): Restaurants {
  const [state, setState] = useState<Restaurants>(() => cache || stored() || { chains: [], built: true })
  useEffect(() => {
    let alive = true
    loadRestaurants().then(d => { if (alive) setState(d) })
    return () => { alive = false }
  }, [])
  return state
}

/* ------------------------------------------------------------------ search */

/**
 * Menu items matching a query, across every chain. The BRAND is searched too, so
 * "bibibop steak" finds the steak — and every word has to match something, so
 * "bibibop" alone lists the menu and "steak" alone finds steak at every chain.
 */
export function searchMenus(chains: Chain[], query: string, limit = 12): MenuItem[] {
  const words = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const scored: { item: MenuItem; score: number }[] = []
  for (const chain of chains || []) {
    for (const item of chain.items || []) {
      const name = item.name.toLowerCase()
      const hay = `${name} ${chain.name} ${chain.short} ${item.category}`.toLowerCase()
      let score = 0
      let ok = true
      for (const w of words) {
        if (name.startsWith(w)) score += 100
        else if (name.split(/\s+/).some(p => p.startsWith(w))) score += 60
        else if (hay.includes(w)) score += 20
        else { ok = false; break }
      }
      if (ok) scored.push({ item, score: score - name.length / 20 })
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.item)
}

/* -------------------------------------------------------------- the bowl */

/*
 * A selection is `{ "<itemId>@<portionId>": qty }`. The portion is in the key
 * because an order can hold two sizes of one thing — a medium fry for him and a
 * large for the table — and for a single-portion item the key simply never
 * varies. Everything a step does (halves, splitting, naming) is DECLARED on the
 * chain's step in restaurants.json, not known here by step id.
 */

export const itemOf = (chain: Chain | null | undefined, id: string): MenuItem | null => chain?.items?.find(i => i.id === id) || null
export const stepOf = (chain: Chain | null | undefined, id: string): Step | null => chain?.steps?.find(s => s.id === id) || null
export const portionOf = (item: { portions?: Portion[] } | null | undefined, pid?: string | null): Portion | null => item?.portions?.find(p => p.id === pid) || item?.portions?.[0] || null
export const defaultPortionId = (item: MenuItem | null | undefined): string | undefined => item?.defaultPortion || item?.portions?.[0]?.id

export const selKey = (item: MenuItem, pid?: string | null) => `${item.id}@${pid ?? defaultPortionId(item)}`

/** Each line of a selection, resolved: `[{ key, item, portion, qty }]`, in step order. */
export function picks(chain: Chain, selection: Selection): { key: string; item: MenuItem; portion: Portion; qty: number }[] {
  const order = new Map((chain?.steps || []).map((s, i) => [s.id, i]))
  const out: { key: string; item: MenuItem; portion: Portion; qty: number }[] = []
  for (const [key, qty] of Object.entries(selection || {})) {
    const at = key.lastIndexOf('@')
    const item = itemOf(chain, at < 0 ? key : key.slice(0, at))
    if (!item || !(qty > 0)) continue
    out.push({ key, item, portion: portionOf(item, at < 0 ? null : key.slice(at + 1))!, qty })
  }
  return out.sort((a, b) => (order.get(a.item.step) ?? 99) - (order.get(b.item.step) ?? 99))
}

/*
 * How far one tap moves a step. A base goes in HALVES because two halves is how
 * a split bowl is ordered; everything else goes in wholes, where 2 is "double
 * protein" or a second burger.
 */
export const stepSize = (chain: Chain, stepId: string): number => stepOf(chain, stepId)?.increment || 1

/**
 * Add one of an item to a selection, and the one bit of ordering logic the
 * builder knows: on a `split` step, tapping a SECOND thing while the first is a
 * whole one halves both, because that is what ordering two bases means. Returns
 * a new selection; never mutates.
 */
export function addToBowl(selection: Selection, item: MenuItem, chain: Chain, pid?: string | null): Selection {
  const next = { ...selection }
  const key = selKey(item, pid)
  const step = stepOf(chain, item.step)
  if (step?.split && !next[key]) {
    const same = picks(chain, next).filter(p => p.item.step === item.step)
    if (same.length === 1 && same[0].qty === 1) {
      next[same[0].key] = 0.5
      next[key] = 0.5
      return next
    }
    next[key] = 1
    return next
  }
  next[key] = round((next[key] || 0) + stepSize(chain, item.step), 2)
  return next
}

/** Take one step off; at zero the item leaves the bowl. */
export function removeFromBowl(selection: Selection, item: MenuItem, chain: Chain, pid?: string | null): Selection {
  const next = { ...selection }
  const key = selKey(item, pid)
  const q = round((next[key] || 0) - stepSize(chain, item.step), 2)
  if (q > 0) next[key] = q
  else delete next[key]
  return next
}

/**
 * The portion multiplier an item actually carries. A size scales only the steps
 * it names — a bibiCup is `{ base: 0.5 }`, "THE BASE CALORIES FOR BIBICUP = ½
 * PORTIONS" from the chain's own PDF — because that is all the chain says
 * shrinks. Halving the protein too would be a guess about a portion nobody
 * published.
 */
export function effectiveQty(item: MenuItem, qty: number, size: Size | null | undefined) {
  const scale = size?.scale?.[item.step] ?? 1
  return round(qty * scale, 3)
}

/** The whole order, added up. */
export function bowlTotals(chain: Chain, selection: Selection, size: Size | null | undefined) {
  const sum = { kcal: 0, protein: 0, carbs: 0, fat: 0, sodium: 0, fiber: 0, sugar: 0 }
  for (const { item, portion: p, qty } of picks(chain, selection)) {
    const q = effectiveQty(item, qty, size)
    const a = amountFor(p, q)
    sum.kcal += a.kcal
    sum.protein += a.protein
    sum.carbs += a.carbs
    sum.fat += a.fat
    sum.sodium += (p.sodium || 0) * q
    sum.fiber += (p.fiber || 0) * q
    sum.sugar += (p.sugar || 0) * q
  }
  return {
    kcal: Math.round(sum.kcal),
    protein: round(sum.protein, 1),
    carbs: round(sum.carbs, 1),
    fat: round(sum.fat, 1),
    sodium: Math.round(sum.sodium),
    fiber: round(sum.fiber, 1),
    sugar: round(sum.sugar, 1),
  }
}

/** A portion's name as it reads in front of the item: "Medium", "4 piece" — never "1 order". */
function sizeWord(item: MenuItem, portion: Portion | null) {
  if (!portion || item.portions.length < 2) return ''
  return portion.label.split(' · ')[0]
}

/**
 * What a bowl IS: a burrito, tacos, a salad, a bibiCup, or a bowl. Decided by
 * the first pick whose portion says so (a burrito tortilla), then by the size,
 * then the chain's default — and only once something that makes a bowl is in
 * it, because chips and a drink on their own are not a bowl of anything.
 */
export function bowlVessel(chain: Chain, selection: Selection, size: Size | null | undefined): string | null {
  if (chain.kind === 'order') return null
  const ps = picks(chain, selection)
  if (!ps.some(p => !stepOf(chain, p.item.step)?.extra)) return null
  const from = ps.find(p => p.portion?.vessel)
  return from?.portion.vessel || size?.vessel || chain.vessel || 'bowl'
}

/**
 * A name for the order, from what is in it.
 *   bowl:  "Bibibop · Steak bowl", "Chipotle · Chicken & Steak burrito" — from
 *          the step that `names` it (the protein), else the first thing in it.
 *   order: "McDonald's · Big Mac + French Fries, Medium" — the first two things,
 *          then a count, because a receipt of six names is not a name.
 */
export function bowlName(chain: Chain, selection: Selection, size: Size | null | undefined): string {
  const ps = picks(chain, selection)
  if (!ps.length) return `${chain.short} · Order`
  if (chain.kind === 'order') {
    // "Name, Size" — the size AFTER the name, because in front it reads
    // "Single The Culver's Deluxe".
    const line = ({ item, portion, qty }: { item: MenuItem; portion: Portion; qty: number }) => {
      const sz = sizeWord(item, portion)
      return `${qty > 1 ? `${qty}× ` : ''}${item.name}${sz ? `, ${sz}` : ''}`
    }
    const shown = ps.slice(0, 2).map(line).join(' + ')
    return `${chain.short} · ${shown}${ps.length > 2 ? ` + ${ps.length - 2} more` : ''}`
  }
  const vessel = bowlVessel(chain, selection, size)
  const naming = ps.filter(p => stepOf(chain, p.item.step)?.names).map(p => p.item.name)
  const inBowl = ps.filter(p => !stepOf(chain, p.item.step)?.extra && !p.portion?.vessel).map(p => p.item.name)
  const what = [...new Set(naming.length ? naming : inBowl.slice(0, 1))].join(' & ')
  if (!vessel) return `${chain.short} · Order`
  return `${chain.short} · ${what ? `${what} ${vessel}` : vessel[0].toUpperCase() + vessel.slice(1)}`
}

/**
 * The order as components, for the log and for a saved meal. Each carries the
 * EFFECTIVE quantity — a bibiCup's rice goes in as half a portion — and the
 * portion that was picked, so the components add up to exactly what the builder
 * showed, with no size to remember anywhere downstream.
 */
export function bowlComponents(chain: Chain, selection: Selection, size: Size | null | undefined): Component[] {
  return picks(chain, selection).map(({ item, portion, qty }) => componentOf(
    { ...item, name: sizeWord(item, portion) && chain.kind === 'order' ? `${item.name}, ${sizeWord(item, portion)}` : item.name, brand: chain.short },
    portion,
    effectiveQty(item, qty, size),
  ))
}
