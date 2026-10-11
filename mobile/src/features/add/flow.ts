/*
 * The add flow's state: what AddFlow in app/src/add.jsx holds in useState, kept
 * here so each of its views can be its own screen in the add sheet's stack.
 *
 * On the web one overlay swaps views (`home | scan | result | detail | …`). On
 * the phone the add sheet is a native stack (src/app/add/), so a view is a push
 * with the system back swipe, and this module is what they share: the mode
 * (logging, or picking an ingredient for a combo), the combo being built, the
 * food picked, the barcode that missed. The flow's endings are the web's:
 *
 *   - finish(): log it and close the sheet, or hand the component back to the
 *     combo being built and return to it.
 *   - pick(): every door lands on the one detail screen.
 *
 * Reset each time the sheet opens (openAdd), as the web's AddFlow mounts fresh.
 */

import { useSyncExternalStore } from 'react'
import { router } from 'expo-router'
import { componentOf } from '../../lib/combos'
import { getStore } from '../../lib/store'
import type { Component, Food, Portion } from '../../lib/types'
import type { Chain } from '../../lib/restaurants'

export interface Draft { id?: string; name: string; components: Component[]; meal?: string | null }
export interface Defaults { portion?: Portion; qty?: number; meal?: string }

interface Flow {
  /** 'component': picking an ingredient for the combo being built. */
  mode: 'log' | 'component'
  draft: Draft | null
  picked: Food | null
  defaults: Defaults | null
  /** The barcode that missed, when the label screen was opened from the miss. */
  labelGtin: string | null
  /** What was typed in the search box, for the label and by-hand screens. */
  query: string
  chain: Chain | null
  /** The day being added to. */
  date: string
}

let flow: Flow = { mode: 'log', draft: null, picked: null, defaults: null, labelGtin: null, query: '', chain: null, date: '' }
const subs = new Set<() => void>()
const set = (patch: Partial<Flow>) => { flow = { ...flow, ...patch }; subs.forEach(fn => fn()) }
const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn) } }

export const useFlow = () => useSyncExternalStore(subscribe, () => flow, () => flow)
export const getFlow = () => flow
export const setFlow = set

/* Closing the whole sheet is the parent stack's back, which src/app/add/_layout.tsx registers. */
let closer: (() => void) | null = null
export function registerClose(fn: (() => void) | null) { closer = fn }
export function closeAdd() { if (closer) closer(); else router.back() }

/**
 * Open the add sheet, the way the web opens AddFlow: plain, or straight at a
 * combo to save (from the day), a food to log again, a barcode to look up (the
 * day's scan button), an Ask AI thread (the day's pill), or the by-hand form
 * (the camera's way out).
 */
export function openAdd(date: string, opts: { seedComponents?: Component[]; relog?: Food; code?: string; askThread?: string; manual?: boolean } = {}) {
  flow = { mode: 'log', draft: null, picked: null, defaults: null, labelGtin: null, query: '', chain: null, date }
  if (opts.seedComponents) {
    set({ draft: { name: '', components: opts.seedComponents } })
    router.push('/add/meal')
  } else if (opts.relog) {
    set({ picked: opts.relog })
    router.push('/add/detail')
  } else if (opts.code) {
    router.push({ pathname: '/add/result', params: { code: opts.code } })
  } else if (opts.manual) {
    router.push('/add/manual')
  } else if (opts.askThread) {
    router.push({ pathname: '/add/thread', params: { id: opts.askThread } })
  } else {
    router.push('/add')
  }
}

/** Every door lands here: the detail screen, with what it should open on. */
export function pick(food: Food, defaults?: Defaults | null, { replace = false } = {}) {
  set({ picked: food, defaults: defaults || null })
  if (replace) router.replace('/add/detail')
  else router.push('/add/detail')
}

/** Where the detail screen's button goes: the log, or the combo being built. */
export function finish({ food, portion, qty, meal, date }: { food: Food; portion: Portion; qty: number; meal: string; date: string }) {
  if (flow.mode === 'component') {
    addComponents([componentOf(food, portion, qty)])
    return
  }
  getStore().logFood({ food, portion, qty, meal, date })
  closeAdd()
}

/** Back to the combo being built with these in it (an ingredient, or a bowl's parts). */
export function addComponents(components: Component[]) {
  const d = flow.draft || { name: '', components: [] }
  set({ draft: { ...d, components: [...d.components, ...components] }, mode: 'log' })
  router.dismissTo('/add/meal')
}

/** Start building a combo (or edit one), from the add screen or a chain menu. */
export function buildCombo(draft: Draft = { name: '', components: [] }) {
  set({ draft, mode: 'log' })
  router.push('/add/meal')
}

/** From the combo: go and pick the next ingredient, keeping what is built so far. */
export function pickIngredient(draft: Draft) {
  set({ draft, mode: 'component' })
  router.push('/add/ingredient')
}

/** Leave ingredient-picking without one: back to the combo. */
export function stopPicking() {
  set({ mode: 'log' })
  router.dismissTo('/add/meal')
}

/** The label form, for a barcode that missed or for any packaged food. */
export function openLabel(gtin: string | null = null) {
  set({ labelGtin: gtin })
  router.push('/add/label')
}
