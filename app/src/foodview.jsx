/*
 * Krakatoa — one food, and every time he has had it.
 *
 * Two asks turned out to be one screen: a page for one product, listing every
 * time it was logged, and a way to fix a mis-tap (a snack that landed under a
 * lunch that never happened).
 *
 * Fixing a row and understanding a food are the same question asked from two
 * distances, and splitting them would have meant two screens that both need a
 * photo, a name and a set of macros. So: the food at the top, the controls for
 * ONE logged entry under it, and the whole history below — and tapping a row in
 * that history moves the editor onto that row rather than opening anything.
 *
 * Opened with no entry (from a recents row, say) the edit panel is simply
 * absent: there is nothing to correct, and the history is the answer.
 */

import { useMemo, useState } from 'react'
import {
  ChevronLeft, Trash2, Plus, CalendarDays, CircleCheck, Utensils,
} from 'lucide-react'
import Thumb from './thumb.jsx'
import {
  MEALS, amountFor, dayLabel, isoDate, mealLabel, portionLabel, shiftDate, titleOf,
} from './lib/food.js'

/** "3 times this week · 27 in all". What a history is actually worth saying. */
function statsFor(history, today) {
  if (!history.length) return null
  const weekAgo = shiftDate(today, -6)
  const thisWeek = history.filter(h => h.date >= weekAgo).length
  const kcal = history.reduce((n, h) => n + (Number(h.kcal) || 0), 0)
  return {
    times: history.length,
    thisWeek,
    last: history[0]?.date,
    avgKcal: Math.round(kcal / history.length),
  }
}

/* --------------------------------------------------------- the edit panel */

function EntryEditor({ entry, portions, onEdit, onMove, onRemove }) {
  const [confirming, setConfirming] = useState(false)
  const today = isoDate()

  // Derived from the entry every render, never copied into state — see the
  // header of lib/store.js on why that rule exists.
  const portion = entry.portion
  const amount = amountFor(portion, entry.qty)

  if (confirming) {
    return (
      <section className="panel danger-panel">
        <p><b>Remove {titleOf(entry)}</b> from {dayLabel(entry.date, today)}?</p>
        <div className="row-btns">
          <button className="btn" onClick={() => setConfirming(false)}>Keep it</button>
          <button className="btn btn-danger" onClick={onRemove}>Remove</button>
        </div>
      </section>
    )
  }

  return (
    <section className="panel">
      <h3 className="panel-head">
        <CircleCheck size={16} />
        This one — {dayLabel(entry.date, today)}
      </h3>

      {/* The mis-click fix, first, because it is the reason this screen exists. */}
      <div className="field">
        <label>Meal</label>
        <div className="chips">
          {MEALS.map(m => (
            <button
              key={m.id}
              className={`chip ${m.id === entry.meal ? 'on' : ''}`}
              onClick={() => onEdit({ meal: m.id })}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {portions.length > 1 && (
        <div className="field">
          <label>Serving</label>
          <div className="chips">
            {portions.map(p => (
              <button
                key={p.id}
                className={`chip ${p.id === portion?.id ? 'on' : ''}`}
                onClick={() => onEdit({ portion: p })}
              >
                {p.label}
                <span className="chip-sub">{p.kcal} kcal</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="field">
        <label>How many</label>
        <div className="qty-row">
          <button className="step-btn" onClick={() => onEdit({ qty: Math.max(0.25, (entry.qty || 1) - 0.25) })}>−</button>
          <span className="qty-value">
            <strong>{portionLabel(entry.qty, portion)}</strong>
            <small>{amount.kcal.toLocaleString()} kcal · {amount.protein}P {amount.carbs}C {amount.fat}F</small>
          </span>
          <button className="step-btn" onClick={() => onEdit({ qty: (entry.qty || 1) + 0.25 })}>+</button>
        </div>
      </div>

      {/* The other everyday mistake: logging today what you ate yesterday. */}
      <div className="field">
        <label>Day</label>
        <div className="chips">
          <button className="chip" onClick={() => onMove(shiftDate(entry.date, -1))}>
            <CalendarDays size={15} /> Move back a day
          </button>
          {entry.date < today && (
            <button className="chip" onClick={() => onMove(shiftDate(entry.date, 1))}>
              Move forward a day
            </button>
          )}
        </div>
      </div>

      <button className="btn btn-quiet" onClick={() => setConfirming(true)}>
        <Trash2 size={16} /> Remove this one
      </button>
    </section>
  )
}

/* ------------------------------------------------------------- the screen */

export default function FoodView({
  entry, history, food, onClose, onEdit, onMove, onRemove, onLogAgain, onPickEntry,
}) {
  const today = isoDate()
  const subject = entry || food || history[0]
  const stats = useMemo(() => statsFor(history, today), [history, today])


  /*
   * Every portion this food is known to have: the catalogue's, plus whatever
   * portion each past entry was actually logged against. The second half is what
   * lets a serving picked months ago still be re-selectable today, even for a
   * hand-typed food that never had a portion list at all.
   */
  const portions = useMemo(() => {
    const seen = new Map()
    for (const p of food?.portions || []) seen.set(p.id, p)
    for (const h of history) if (h.portion && !seen.has(h.portion.id)) seen.set(h.portion.id, h.portion)
    if (entry?.portion && !seen.has(entry.portion.id)) seen.set(entry.portion.id, entry.portion)
    return [...seen.values()]
  }, [food, history, entry])

  if (!subject) {
    // The entry was removed while this screen was open — from another device, or
    // by the confirm above. Saying so beats rendering a blank pane.
    return (
      <div className="pane">
        <header className="pane-head">
          <button className="icon-btn" onClick={onClose} aria-label="Back"><ChevronLeft size={24} /></button>
          <h2>Gone</h2>
        </header>
        <div className="pane-body pane-center">
          <p className="muted">That food is no longer in the log.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="pane">
      <header className="pane-head">
        <button className="icon-btn" onClick={onClose} aria-label="Back"><ChevronLeft size={24} /></button>
        <h2>{titleOf(subject)}</h2>
      </header>

      <div className="pane-body">
        <div className="food-hero">
          <Thumb food={subject} size={84} />
          <div>
            <h3>{titleOf(subject)}</h3>
            {stats && (
              <p className="muted">
                {stats.times === 1 ? 'Eaten once' : `Eaten ${stats.times} times`}
                {stats.thisWeek > 0 && ` · ${stats.thisWeek} in the last 7 days`}
              </p>
            )}
            {subject.source === 'ai' && <p className="muted">Estimated by AI — nobody publishes this one</p>}
            {subject.components?.length > 0 && (
              <p className="muted">{subject.components.map(c => c.name).join(', ')}</p>
            )}
          </div>
        </div>

        {entry && (
          <EntryEditor
            entry={entry}
            portions={portions}
            onEdit={onEdit}
            onMove={onMove}
            onRemove={onRemove}
          />
        )}

        <button className="btn btn-primary" onClick={() => onLogAgain(subject, portions)}>
          <Plus size={18} /> Log it again
        </button>

        <section className="list">
          <h3 className="list-head"><Utensils size={16} /> Every time you have had this</h3>
          {history.length === 0 && <p className="muted row-note">Not logged yet.</p>}
          {history.map(h => (
            <button
              key={h.id}
              className={`hist-row ${entry?.id === h.id ? 'on' : ''}`}
              onClick={() => onPickEntry(h.id)}
            >
              <span className="hist-when">
                <strong>{dayLabel(h.date, today)}</strong>
                <small>{mealLabel(h.meal)} · {portionLabel(h.qty, h.portion)}</small>
              </span>
              <span className="hist-kcal">{Math.round(h.kcal).toLocaleString()}</span>
            </button>
          ))}
        </section>
      </div>
    </div>
  )
}
