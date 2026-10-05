/*
 * Krakatoa — the shell.
 *
 * One screen (the day) and two overlays: adding food, and looking at one food.
 * There is deliberately no tab bar — this app does one thing, and Bushido's
 * standing direction (fewer surfaces, not more) is why it is a separate app at
 * all rather than a tab inside that one.
 */

import { useEffect, useState } from 'react'
import Today from './today.jsx'
import AddFlow from './add.jsx'
import FoodView from './foodview.jsx'
import Overlay from './overlay.jsx'
import SettingsPane from './settings.jsx'
import { useStore } from './lib/store.js'
import { componentsFromEntries } from './lib/combos.js'
import { foodKey, isoDate, totals } from './lib/food.js'
import { balanceFor, useWhoop } from './lib/whoop.js'
import { useThreads } from './lib/askapi.js'
import { useServerInfo } from './lib/server.js'
import { Loader2, Sparkles } from 'lucide-react'

/*
 * Ask AI works in the background, so it has to be able to say so from the day:
 * a pill while something is working, and one that opens the answer when it
 * lands and he has not looked yet. Gone once he opens it or logs it.
 */
function AskPill({ onOpen }) {
  const { threads } = useThreads()
  const working = threads.filter(t => t.status === 'working')
  const fresh = threads.find(t => (t.status === 'ready' || t.status === 'error') && !t.seenAt && !t.loggedAt)
  if (fresh) {
    return (
      <button className="ask-pill ready" onClick={() => onOpen(fresh.id)}>
        <Sparkles size={15} />
        <span><b>{fresh.title}</b> {fresh.status === 'error' ? 'did not finish' : `is ready · ${fresh.kcal.toLocaleString()} kcal`}</span>
      </button>
    )
  }
  if (working.length) {
    return (
      <button className="ask-pill" onClick={() => onOpen(working[0].id)}>
        <Loader2 className="spin" size={15} />
        <span>Ask AI is working{working.length > 1 ? ` on ${working.length}` : ''}…</span>
      </button>
    )
  }
  return null
}

export default function App() {
  const store = useStore()
  const { whoop, refresh: refreshWhoop, refreshing: whoopRefreshing } = useWhoop()
  const [date, setDate] = useState(isoDate)
  const [adding, setAdding] = useState(null)   // null | { seedComponents? }
  const [viewing, setViewing] = useState(null) // null | { entryId?, key }
  // Settings opens from the header, from any screen that needs something set up
  // (openSettings in lib/server.js), and once right after first-run setup.
  const [settingsAt, setSettingsAt] = useState(() => {
    const q = new URLSearchParams(window.location.search).get('settings')
    return q ? { section: q } : null
  })
  const info = useServerInfo()

  useEffect(() => {
    if (settingsAt && window.location.search.includes('settings=')) {
      window.history.replaceState(null, '', window.location.pathname)
    }
  }, [settingsAt])
  useEffect(() => {
    const open = (e) => { setAdding(null); setViewing(null); setSettingsAt({ section: e.detail?.section || null }) }
    window.addEventListener('krakatoa:settings', open)
    return () => window.removeEventListener('krakatoa:settings', open)
  }, [])

  // Everything below is DERIVED every render, never held as a copy. Bushido shipped
  // that bug twice — a sheet rendering an entry as it was when it opened — and it
  // renders perfectly while being wrong, so no test catches it. See lib/store.js.
  const items = store.dayItems(date)
  const balance = balanceFor(whoop, date, totals(items).kcal, isoDate())
  const entry = viewing?.entryId ? store.entryById(viewing.entryId) : null
  const history = viewing ? store.historyFor(viewing.key) : []

  const openEntry = (id) => {
    const e = store.entryById(id)
    if (e) setViewing({ entryId: id, key: foodKey(e) })
  }

  return (
    <div className="app">
      <Today
        date={date}
        setDate={setDate}
        items={items}
        targets={store.targets}
        sync={store.sync}
        balance={balance}
        whoop={whoop}
        onRefreshWhoop={refreshWhoop}
        whoopRefreshing={whoopRefreshing}
        waterOz={store.waterOn(date)}
        onAdd={() => setAdding({})}
        onScan={() => setAdding({ scan: true })}
        onOpenEntry={openEntry}
        onSaveMeal={(mealItems) => setAdding({ seedComponents: componentsFromEntries(mealItems) })}
        onSaveTargets={store.setTargets}
        onAddWater={store.addWater}
        onOpenSettings={() => setSettingsAt({ section: null })}
        energy={!!info?.features?.whoop}
      />

      {settingsAt && (
        <Overlay onClose={() => setSettingsAt(null)}>
          <SettingsPane section={settingsAt.section} onClose={() => setSettingsAt(null)} />
        </Overlay>
      )}

      {!adding && !viewing && !settingsAt && <AskPill onOpen={(id) => setAdding({ askThread: id })} />}

      {viewing && (
        <Overlay onClose={() => setViewing(null)}>
          <FoodView
            entry={entry}
            history={history}
            food={entry || history[0]}
            onClose={() => setViewing(null)}
            onEdit={(patch) => entry && store.editFood(entry.id, patch)}
            onMove={(to) => {
              if (!entry) return
              store.moveEntry(entry.id, to)
              // Follow the food to the day it moved to, so the screen behind is
              // not showing a day the entry has just left.
              setDate(to)
            }}
            onRemove={() => {
              if (entry) store.removeFood(entry.id)
              setViewing(null)
            }}
            onPickEntry={(id) => setViewing(v => ({ ...v, entryId: id }))}
            onLogAgain={(subject, portions) => {
              setViewing(null)
              setAdding({ relog: { ...subject, portions } })
            }}
          />
        </Overlay>
      )}

      {adding && (
        <Overlay onClose={() => setAdding(null)}>
          <AddFlow
            date={date}
            recent={store.recent}
            combos={store.combos}
            starred={store.starred}
            isStarred={store.isStarred}
            seedComponents={adding.seedComponents}
            relog={adding.relog}
            startScanning={adding.scan}
            askThread={adding.askThread}
            onClose={() => setAdding(null)}
            onLog={store.logFood}
            onSaveCombo={store.saveCombo}
            onStar={(food, on) => (on ? store.starFood(food) : store.unstarFood(food))}
          />
        </Overlay>
      )}
    </div>
  )
}
