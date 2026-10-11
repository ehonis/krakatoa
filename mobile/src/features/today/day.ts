// Which day the day screen shows. On the web it is App's `date` state; here the
// food sheet also moves it (an entry moved to yesterday takes the day with it,
// so the screen behind is not showing a day the entry has just left), so it is
// a small store both read.
//
// The web reads the date when the page loads; the app stays in memory for days.
// Back in the foreground after midnight, a day still showing what was today moves
// on to the new today, or "+" would log breakfast to yesterday. A day he picked
// stays where it is.
import { useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import { isoDate } from '../../lib/food'

let day = isoDate()
let today = day
const subs = new Set<() => void>()
const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn) } }
AppState.addEventListener('change', (s) => {
  if (s !== 'active') return
  const now = isoDate()
  if (now === today) return
  if (day === today) setDay(now)
  today = now
})

export const getDay = () => day
export function setDay(iso: string) {
  if (iso === day) return
  day = iso
  subs.forEach(fn => fn())
}
export const useDay = () => useSyncExternalStore(subscribe, () => day, () => day)
