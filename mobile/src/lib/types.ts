// The shapes the web passes around untyped (it is JavaScript), written down once
// so the ported code can say what it means. Loose on purpose: these mirror JSON
// the server owns, and an extra field from a newer server must not be an error.

/** One portion of a food, carrying the macros for ONE of it (AGENTS.md §4). */
export interface Portion {
  id: string
  label: string
  grams?: number | null
  kcal: number
  protein?: number | null
  carbs?: number | null
  fat?: number | null
  fiber?: number | null
  sugar?: number | null
  sodium?: number | null
  satFat?: number | null
  cholesterol?: number | null
  /** A chain portion that decides what the order is (a burrito tortilla). */
  vessel?: string
  [k: string]: any
}

/** A food from any door: a scan, a search, a basic, a menu item, a combo, by hand. */
export interface Food {
  id?: string
  key?: string
  name: string
  brand?: string | null
  gtin?: string | null
  image?: string | null
  imageGtin?: string | null
  source?: string
  comboId?: string | null
  components?: Component[] | null
  portions: Portion[]
  defaultPortion?: string
  usdaName?: string | null
  category?: string
  [k: string]: any
}

/** What goes into a combo: a food, a portion and how many. */
export interface Component {
  name: string
  brand?: string | null
  gtin?: string | null
  image?: string | null
  source?: string
  portion: Portion
  qty: number
  [k: string]: any
}

/** A logged food as the day reads it: the entry's data with its id (and date). */
export interface Item {
  id: string
  date?: string
  at?: string
  name: string
  brand?: string | null
  gtin?: string | null
  source?: string
  image?: string | null
  imageGtin?: string | null
  meal?: string
  qty: number
  portion: Portion
  note?: string | null
  comboId?: string | null
  components?: Component[] | null
  kcal: number
  protein: number
  carbs: number
  fat: number
  [k: string]: any
}

/** A saved combo (kind: 'combo'). */
export interface Combo {
  id: string
  name: string
  components: Component[]
  meal?: string | null
  createdAt?: string
  lastUsedAt?: string
  [k: string]: any
}

/** One record in the synced log. `data` depends on `kind`. */
export interface Entry {
  id: string
  kind: 'food' | 'water' | 'settings' | 'star' | 'combo' | string
  date: string | null
  updatedAt?: string
  deleted?: boolean
  data: any
}

export interface Totals { kcal: number; protein: number; carbs: number; fat: number }
