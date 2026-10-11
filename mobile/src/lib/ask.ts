/*
 * Krakatoa — the list Ask AI hands back, and what becomes of it. Pure.
 *
 * The server (server/ai.js) answers with items whose numbers are already real
 * wherever Krakatoa knows the food — his combo, a chain's menu, a USDA basic — and
 * an estimate only where it does not, each marked with its `basis`. This file is
 * what the review screen does with that: tick, change a quantity, correct a
 * number, and turn what is ticked into ordinary log entries or a combo. Ported
 * from app/src/lib/ask.js; keep the two in step.
 */

import type { Food, Portion } from './types'

/* An item as the server's answer has it, plus what the review screen holds. */
export interface AskItem {
  key: string
  name: string
  qty: number
  portion: string
  per: { kcal: number; protein: number; carbs: number; fat: number; [k: string]: number }
  basis?: string
  where?: string
  confidence?: string
  eaten?: boolean
  on: boolean
  edited: boolean
  matched?: any
  matchId?: string | null
  parts?: any[]
  components?: any[] | null
  note?: string
  [k: string]: any
}

export interface Review {
  kind?: string
  place?: string | null
  question?: string | null
  reply?: string
  items: AskItem[]
  skipped?: string[]
  [k: string]: any
}

/* What each basis is called on screen, and whether it is a number to trust. */
export const BASIS: Record<string, { label: string; tone: 'good' | 'guess' }> = {
  yours: { label: 'Your food', tone: 'good' },
  menu: { label: 'Menu', tone: 'good' },
  basic: { label: 'USDA', tone: 'good' },
  label: { label: 'Label', tone: 'good' },
  estimate: { label: 'AI estimate', tone: 'guess' },
  edited: { label: 'You edited', tone: 'good' },
}

export function basisLabel(item: AskItem) {
  if (item.edited) return BASIS.edited.label
  if (item.basis === 'menu' && item.where) return `${item.where.split(' · ')[0]} menu`
  return BASIS[item.basis || '']?.label || 'AI estimate'
}

let seq = 0
/** The server's answer, with the bits the screen needs to hold per row. */
export function reviewOf(answer: any): Review {
  return {
    ...answer,
    items: (answer.items || []).map((it: any) => ({ ...it, key: `i${++seq}`, on: it.eaten !== false, edited: false })),
  }
}

const r1 = (n: unknown) => Math.round((Number(n) || 0) * 10) / 10

export function itemTotal(it: AskItem) {
  const q = Number(it.qty) || 0
  return {
    kcal: Math.round((it.per?.kcal || 0) * q),
    protein: r1((it.per?.protein || 0) * q),
    carbs: r1((it.per?.carbs || 0) * q),
    fat: r1((it.per?.fat || 0) * q),
  }
}

export function ticked(review: Review | null | undefined) {
  return (review?.items || []).filter(it => it.on && Number(it.qty) > 0)
}

export function reviewTotals(review: Review) {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0 }
  for (const it of ticked(review)) {
    const n = itemTotal(it)
    t.kcal += n.kcal; t.protein += n.protein; t.carbs += n.carbs; t.fat += n.fat
  }
  return { kcal: t.kcal, protein: r1(t.protein), carbs: r1(t.carbs), fat: r1(t.fat) }
}

/** Change one row; returns a new review. Editing a number makes it his. */
export function updateItem(review: Review, key: string, patch: Partial<AskItem>): Review {
  return {
    ...review,
    items: review.items.map(it => {
      if (it.key !== key) return it
      const next = { ...it, ...patch }
      if (patch.per) next.edited = true
      return next
    }),
  }
}

const SOURCE: Record<string, string | null> = { yours: null, menu: 'restaurant', basic: 'basic', label: 'label' }

/**
 * One reviewed row as the `{ food, portion, qty }` the ordinary log writer takes.
 * A matched food keeps its real portion (fibre, sodium and all) unless he edited
 * the numbers; a dish built from parts is logged the way a combo is, remembering
 * what went into it; an estimate is `source: 'ai'`, which is what it is.
 */
export function toLog(it: AskItem, place?: string | null): { food: Food; portion: Portion; qty: number } {
  const m = it.matched
  const useMatch = m && !it.edited
  const portion: Portion = useMatch
    ? m.portion
    : { id: 'ai', label: it.portion, grams: null, kcal: it.per.kcal, protein: it.per.protein, carbs: it.per.carbs, fat: it.per.fat }
  const built = it.components?.length && !it.edited
  const comboLike = built || (useMatch && m.source === 'combo')
  const source = comboLike ? 'combo'
    : it.edited ? 'ai'
      : it.basis === 'yours' ? (m?.source || 'manual')
        : SOURCE[it.basis || ''] || 'ai'
  return {
    food: {
      name: it.name,
      brand: (useMatch && m.brand) || place || null,
      gtin: (useMatch && m.gtin) || null,
      image: null,
      source,
      comboId: (useMatch && m.comboId) || null,
      components: built ? it.components : (useMatch && m.components) || null,
      portions: [portion],
    },
    portion,
    qty: Number(it.qty) || 1,
  }
}

/**
 * What goes back up when he asks for a change: the list as it stands NOW, with
 * his ticks, quantities and edited numbers, so a revision starts from his
 * version and not from the one the model first wrote.
 */
export function previousOf(review: Review) {
  return {
    kind: review.kind,
    place: review.place,
    items: review.items.map(it => ({
      name: it.name,
      qty: it.qty,
      portion: it.portion,
      eaten: it.on,
      matchId: it.matchId || null,
      parts: it.parts || [],
      // His numbers, and the model's own estimates, go back as they are: an
      // estimate re-made on every turn drifts (a horchata was 330, then 260,
      // with nobody mentioning it). Matches send none — the table has them.
      ...(it.edited ? { edited: true, per: it.per } : !it.matched && !it.components?.length ? { per: it.per } : {}),
      basis: it.basis,
      note: it.note,
    })),
  }
}
