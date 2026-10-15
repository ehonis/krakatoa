/*
 * Krakatoa — the day.
 *
 * The only screen that matters. A number, how far through the target it is, what
 * filled it, and one button. Everything else in this app exists to put a row on
 * this list.
 */

import { useMemo, useState } from 'react'
import {
  ChevronLeft, ChevronRight, Plus, CloudOff, Settings, X, BookMarked, Target,
  ChevronRight as Chev, Flame, TrendingDown, TrendingUp, ScanBarcode,
  RefreshCw, CircleAlert,
} from 'lucide-react'
import { MEALS, dayLabel, isoDate, mealLabel, portionLabel, shiftDate, titleOf, totals } from './lib/food.js'
import { macroSplit, ringSegments } from './lib/macros.js'
import Thumb from './thumb.jsx'
import Water from './water.jsx'

/**
 * The ring, which is also the macro pie.
 *
 * ONE shape answering two questions, rather than a second chart next to the
 * first: how far ROUND it goes is how close the day is to its calorie target,
 * and the colours WITHIN that arc are the protein/carb/fat split. A separate
 * donut would have repeated the same three numbers already written underneath
 * it, in a card that is trying to be the one glance a day gets.
 *
 * With no target set the ring is drawn whole and is purely the split — a
 * fraction of nothing is not a fraction. With no macros logged it falls back to
 * a plain arc, because three equal thirds would be a chart of nothing that looks
 * exactly like a chart of something.
 */
function Ring({ value, target, totals: t }) {
  const { fill, segments, over } = ringSegments(t, target)
  const R = 54
  const C = 2 * Math.PI * R
  const plain = !segments.length

  return (
    <div className={`ring ${over ? 'over' : ''}`}>
      <svg viewBox="0 0 128 128" aria-hidden="true">
        <circle className="ring-track" cx="64" cy="64" r={R} />
        {plain && target > 0 && (
          <circle
            className="ring-fill"
            cx="64" cy="64" r={R}
            strokeDasharray={`${C * Math.min(1, value / target)} ${C}`}
            transform="rotate(-90 64 64)"
          />
        )}
        {segments.map(seg => (
          <circle
            key={seg.key}
            className={`ring-seg tone-s${seg.key === 'protein' ? 1 : seg.key === 'carbs' ? 2 : 3}`}
            cx="64" cy="64" r={R}
            // A gap between segments would be drawn out of the arc itself and
            // would make the colours lie about their share, so they butt up and
            // the stroke's flat cap is the only separator.
            strokeDasharray={`${(C * seg.length) / 100} ${C}`}
            strokeDashoffset={`${-(C * seg.offset) / 100}`}
            transform="rotate(-90 64 64)"
          />
        ))}
      </svg>
      <div className="ring-label">
        <strong>{value.toLocaleString()}</strong>
        <span>{target ? `of ${target.toLocaleString()} kcal` : 'kcal'}</span>
      </div>
    </div>
  )
}

function MacroBar({ label, value, target, tone, share }) {
  const pct = target ? Math.min(100, (value / target) * 100) : 0
  return (
    <div className="macro">
      <div className="macro-top">
        {/* The dot ties this row to its slice of the ring above. Without it the
            ring is three anonymous colours and the reader has to guess. */}
        <span className="macro-name"><i className={`dot tone-${tone}`} />{label}</span>
        <span className="macro-num">
          {/* The share is the pie in words, which is what makes the ring
              readable to a number rather than only to an eye. */}
          {share != null && <em>{share}%</em>}
          {Math.round(value)}<small>{target ? ` / ${target} g` : ' g'}</small>
        </span>
      </div>
      <div className="macro-track">
        <div className={`macro-fill tone-${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

/*
 * A logged row. The WHOLE row opens the food screen rather than carrying its own
 * delete button: a bin beside every row is four taps of destruction a thumb can
 * reach by accident mid-scroll, and the mistake that actually happens is a
 * mis-tap putting a snack in the wrong meal. Correcting that needs a screen, and
 * once there is one, removing belongs on it behind the same confirmation.
 */
function Item({ item, onOpen }) {
  return (
    <li>
      <button className="item" onClick={() => onOpen(item.id)}>
        <Thumb food={item} size={38} />
        <span className="item-main">
          <span className="item-name">{titleOf(item)}</span>
          <span className="item-sub">
            {portionLabel(item.qty, item.portion)}
            {item.protein || item.carbs || item.fat
              ? ` · ${Math.round(item.protein)}P ${Math.round(item.carbs)}C ${Math.round(item.fat)}F`
              : ''}
          </span>
        </span>
        <span className="item-kcal">{Math.round(item.kcal).toLocaleString()}</span>
        <Chev size={18} className="item-chev" />
      </button>
    </li>
  )
}

/* ----------------------------------------------------------------- balance */

/**
 * Eaten against burned. The whole design problem here is honesty, because the
 * obvious version of this panel lies twice a day:
 *
 *   - TODAY's burn is what WHOOP has counted SO FAR and climbs until midnight.
 *     At 14:23 it read 1,890 against 1,853 eaten, which subtracts to "37 under"
 *     — a number that is not a deficit, it is a clock. So a partial day never
 *     shows a verdict; it shows both numbers with "so far" on them, and the
 *     average COMPLETE day underneath as the only honest yardstick.
 *   - A day with nothing logged is not a 2,800 deficit, it is a day he did not
 *     open the app. That one says so.
 *
 * And the burn is WHOOP's ESTIMATE from heart rate and basal rate, not a
 * measurement, which the panel says out loud once rather than implying never.
 */
/** "just now" / "12 min ago" / "3 h ago". Undefined instants say nothing. */
function ago(iso) {
  if (!iso) return null
  const mins = Math.floor((Date.now() - Date.parse(iso)) / 60000)
  if (!Number.isFinite(mins) || mins < 0) return null
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  return hrs < 24 ? `${hrs} h ago` : `${Math.round(hrs / 24)} d ago`
}

export function Balance({ balance, whoop, onRefresh, refreshing }) {
  /*
   * The panel renders for the ERROR case even with no balance, because that is
   * the state someone presses refresh to get out of: a Bushido that is down or a
   * grant that needs reconnecting says so here, with WHOOP's own wording, rather
   * than the card silently not existing.
   */
  const err = whoop?.error
  if (!balance) {
    if (!err || !onRefresh) return null
    return (
      <section className="balance">
        <h3 className="panel-head">
          <Flame size={15} /> Energy
          <RefreshButton onRefresh={onRefresh} refreshing={refreshing} />
        </h3>
        <p className="balance-verdict muted">
          <CircleAlert size={15} /> {err}
        </p>
      </section>
    )
  }
  const { burned, eaten, net, partial, untracked, typical } = balance
  const under = net < 0

  /*
   * A tug of war on one track: eaten grows from the left, burned from the right,
   * and the track is always full — so the MEETING POINT is the reading, and the
   * centre notch is what it is read against. Equal numbers meet dead centre;
   * burning more pulls the join left, eating more pushes it right.
   *
   * Proportional, `eaten / (eaten + burned)`, which is the only split where the
   * two bars can share one track and stay honest about their ratio. It is also
   * a DELIBERATELY undramatic scale: 500 kcal on a 2,200 day moves the join
   * about five per cent, and inflating that — clamping the track to ±1,000, say
   * — would make an ordinary day look like a crisis. The notch is what makes a
   * small offset legible without exaggerating it.
   */
  const total = eaten + burned
  // Clamped off the very ends so a lopsided day still shows a sliver of the
  // losing colour — a bar that reads as one solid block has stopped being a
  // comparison.
  const eatenPct = total > 0 ? Math.min(97, Math.max(3, (eaten / total) * 100)) : 50

  return (
    <section className="balance">
      <h3 className="panel-head">
        <Flame size={15} /> Energy{partial ? ' so far today' : ''}
        <RefreshButton onRefresh={onRefresh} refreshing={refreshing} at={whoop?.fetchedAt} />
      </h3>

      {/* An untracked day gets no bar at all. Drawing one would fill the whole
          track with burn and read as an enormous deficit, which is the exact
          lie the `untracked` flag exists to prevent — he did not eat nothing,
          he did not TELL us what he ate. */}
      {!untracked && (
        <>
          <div
            className="tug"
            role="img"
            aria-label={`${eaten} kcal eaten against ${burned} kcal burned`}
          >
            <span className="tug-fill tug-eaten" style={{ width: `${eatenPct}%` }} />
            <span className="tug-fill tug-burned" style={{ width: `${100 - eatenPct}%` }} />
          </div>

          {/* The "even" reference sits BELOW the track, not in it. Inside, it
              landed on top of the join whenever the two numbers were close —
              which is most days — and two dark vertical lines a few pixels apart
              cannot be told from one another, so the reading lost its reference
              exactly when it needed it. */}
          <div className="tug-scale">
            <span className="tug-even">even</span>
          </div>

          <div className="tug-labels">
            <span className="tug-label">
              <strong>{eaten.toLocaleString()}</strong>
              <small>eaten</small>
            </span>
            <span className="tug-label right">
              <strong>{burned.toLocaleString()}</strong>
              <small>burned{partial ? ' so far' : ''}</small>
            </span>
          </div>
        </>
      )}

      {untracked ? (
        <p className="balance-verdict muted">Nothing logged that day, so there is no balance to read.</p>
      ) : partial && typical ? (
        /* The "still counting" sentence that used to lead this line is gone: the
           panel heading already says "so far today" and the label under the bar
           says "burned so far", so it was the third time in one card. What is
           left is the only thing here the screen does not already say — the
           average COMPLETE day, which is what a partial number is read against. */
        <p className="balance-verdict muted">
          You usually finish around <b>{typical.toLocaleString()}</b>.
        </p>
      ) : partial ? null : (
        <p className={`balance-verdict ${under ? 'under' : 'over'}`}>
          {under ? <TrendingDown size={16} /> : <TrendingUp size={16} />}
          <b>{Math.abs(net).toLocaleString()} kcal {under ? 'under' : 'over'}</b>
        </p>
      )}

      {/* A failed pull leaves the previous cache in place and carries its reason
          alongside — so the numbers above are still real and this says why they
          did not move. Bushido's wording (WHOOP's, passed on) travels verbatim because it names
          the fix ("reconnect WHOOP", "authorized without read:workout"). */}
      {err && (
        <p className="balance-verdict muted">
          <CircleAlert size={14} /> {err}
        </p>
      )}

      <p className="balance-note">WHOOP's estimate from heart rate, not a measurement.</p>
    </section>
  )
}

function RefreshButton({ onRefresh, refreshing, at }) {
  if (!onRefresh) return null
  const when = ago(at)
  return (
    <span className="refresh-wrap">
      {when && <small className="refresh-at">{when}</small>}
      <button
        className="icon-btn sm"
        onClick={onRefresh}
        disabled={refreshing}
        aria-label="Refresh from WHOOP"
        title="Refresh from WHOOP"
      >
        <RefreshCw size={15} className={refreshing ? 'spin' : ''} />
      </button>
    </span>
  )
}

/* ----------------------------------------------------------------- targets */

function TargetsPane({ targets, onSave, onClose }) {
  const [form, setForm] = useState({
    kcal: targets.kcal ?? '',
    protein: targets.protein ?? '',
    carbs: targets.carbs ?? '',
    fat: targets.fat ?? '',
    water: targets.water ?? '',
  })
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value.replace(/[^\d.]/g, '') }))
  const clean = (v) => (v === '' ? null : Number(v) || null)

  return (
    <div className="pane">
      <header className="pane-head">
        <h2>Daily targets</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={24} /></button>
      </header>
      <div className="pane-body">
        <p className="muted">
          Leave any of these blank and the app simply will not draw a bar for it —
          a target nobody set is not a target of zero.
        </p>
        <section className="field">
          <label htmlFor="t-kcal">Calories</label>
          <input id="t-kcal" className="text-input" inputMode="numeric" value={form.kcal} onChange={set('kcal')} placeholder="2400" />
        </section>
        <div className="macro-inputs">
          <span><input className="text-input" inputMode="numeric" value={form.protein} onChange={set('protein')} placeholder="160" /><small>protein g</small></span>
          <span><input className="text-input" inputMode="numeric" value={form.carbs} onChange={set('carbs')} placeholder="250" /><small>carbs g</small></span>
          <span><input className="text-input" inputMode="numeric" value={form.fat} onChange={set('fat')} placeholder="80" /><small>fat g</small></span>
        </div>
        <section className="field">
          <label htmlFor="t-water">Water / liquids</label>
          <input id="t-water" className="text-input" inputMode="numeric" value={form.water}
            onChange={set('water')} placeholder="64" />
          {/* The one target with a default, because the glass has to be a
              fraction of SOMETHING to be drawn at all — and eight 8 oz glasses
              is the figure everyone already has in their head. */}
          <p className="field-hint">Ounces a day. Left blank it uses 64.</p>
        </section>
      </div>
      <footer className="pane-foot">
        <button
          className="btn btn-primary"
          onClick={() => {
            onSave({
              kcal: clean(form.kcal),
              protein: clean(form.protein),
              carbs: clean(form.carbs),
              fat: clean(form.fat),
              water: clean(form.water),
            })
            onClose()
          }}
        >
          Save
        </button>
      </footer>
    </div>
  )
}

/* --------------------------------------------------------------------- day */

export default function Today({
  date, setDate, items, targets, sync, balance, waterOz,
  whoop, onRefreshWhoop, whoopRefreshing,
  onAdd, onScan, onOpenEntry, onSaveMeal, onSaveTargets, onAddWater, onOpenSettings, energy = true,
}) {
  const [showTargets, setShowTargets] = useState(false)
  const total = useMemo(() => totals(items), [items])
  const split = useMemo(() => macroSplit(total), [total])
  const shareOf = (key) => (split.fromMacros > 0 ? split.parts.find(p => p.key === key).pct : null)
  const today = isoDate()

  const byMeal = useMemo(() => {
    const map = new Map(MEALS.map(m => [m.id, []]))
    for (const it of items) {
      const key = map.has(it.meal) ? it.meal : 'snack'
      map.get(key).push(it)
    }
    return [...map.entries()].filter(([, list]) => list.length)
  }, [items])

  if (showTargets) {
    return <TargetsPane targets={targets} onSave={onSaveTargets} onClose={() => setShowTargets(false)} />
  }

  return (
    <div className="day">
      <header className="day-head">
        <button className="icon-btn" onClick={() => setDate(shiftDate(date, -1))} aria-label="Previous day">
          <ChevronLeft size={24} />
        </button>
        <button className="day-title" onClick={() => setDate(today)}>
          <strong>{dayLabel(date, today)}</strong>
          {date !== today && <small>tap for today</small>}
        </button>
        <button
          className="icon-btn"
          onClick={() => setDate(shiftDate(date, 1))}
          // Tomorrow has not happened. Nothing stops him looking, but the arrow
          // stopping at today is the honest edge of the log.
          disabled={date >= today}
          aria-label="Next day"
        >
          <ChevronRight size={24} />
        </button>

        {/* Desktop only — see the FAB note in styles.css. */}
        <button className="btn head-scan" onClick={onScan} aria-label="Scan a barcode">
          <ScanBarcode size={18} /> Scan
        </button>
        <button className="btn btn-primary head-add" onClick={onAdd}>
          <Plus size={18} /> Add food
        </button>
        <button className="icon-btn ghost head-settings" onClick={onOpenSettings} aria-label="Settings" title="Settings">
          <Settings size={20} />
        </button>
      </header>

      {/* On a wide screen this whole column goes sticky beside the meals. On a
          phone it is simply what comes first. */}
      <div className="day-side">
        <section className="summary">
          <Ring value={total.kcal} target={targets.kcal} totals={total} />
          <div className="macros">
            <MacroBar label="Protein" value={total.protein} target={targets.protein} tone="1" share={shareOf('protein')} />
            <MacroBar label="Carbs" value={total.carbs} target={targets.carbs} tone="2" share={shareOf('carbs')} />
            <MacroBar label="Fat" value={total.fat} target={targets.fat} tone="3" share={shareOf('fat')} />
            {targets.kcal != null && (
              <p className="remaining">
                {total.kcal <= targets.kcal
                  ? `${(targets.kcal - total.kcal).toLocaleString()} kcal left`
                  : `${(total.kcal - targets.kcal).toLocaleString()} kcal over`}
              </p>
            )}
          </div>
        </section>

        {/* Only when a burn source is configured. Without one there is nothing
            to compare against, and an empty panel would read as a broken one. */}
        {energy && (
          <Balance
            balance={balance}
            whoop={whoop}
            onRefresh={onRefreshWhoop}
            refreshing={whoopRefreshing}
          />
        )}
        <Water oz={waterOz} target={targets.water} onAdd={(oz) => onAddWater(date, oz)} />
      </div>

      <div className="day-meals">
        {items.length === 0 ? (
          <div className="empty">
            <p>Nothing logged{date === today ? ' yet today' : ' that day'}.</p>
            <button className="btn" onClick={onAdd}><Plus size={18} /> Add the first thing</button>
          </div>
        ) : (
          byMeal.map(([meal, list]) => (
            <section className="meal" key={meal}>
              <h3 className="meal-head">
                <span>{mealLabel(meal)}</span>
                <span className="meal-kcal">{totals(list).kcal.toLocaleString()} kcal</span>
              </h3>
              <ul className="items">
                {list.map(it => <Item key={it.id} item={it} onOpen={onOpenEntry} />)}
              </ul>
              {/*
                The path that actually gets used for saving a meal. Nobody writes
                a recipe before they have cooked it — he logs the eggs, the butter
                and the milk the ordinary way, and THEN says that was a meal. Only
                offered where there is something to combine.
              */}
              {list.length > 1 && (
                <button className="save-meal" onClick={() => onSaveMeal(list)}>
                  <BookMarked size={14} /> Save this {mealLabel(meal).toLowerCase()} as a combo
                </button>
              )}
            </section>
          ))
        )}
      </div>

      <div className="day-foot">
        <span className="foot-links">
          <button className="link" onClick={() => setShowTargets(true)}>
            <Target size={14} /> Daily targets
          </button>
          {/* The phone's way in. On a desktop the header has a gear as well. */}
          <button className="link foot-settings" onClick={onOpenSettings}>
            <Settings size={14} /> Settings
          </button>
        </span>
        {sync.state === 'offline' && (
          <span className="muted offline"><CloudOff size={14} /> Saved on this device, not synced yet</span>
        )}
      </div>

      {/*
        Scanning is the single commonest way food gets into this app and it was
        three taps deep — the + , then the big scan button, then the camera. As
        its own control beside the + it is one. Deliberately the SMALLER of the
        two and second in reading order: it is the fast path, not the main one,
        because plenty of food has no barcode on it at all.
      */}
      <button className="fab fab-scan" onClick={onScan} aria-label="Scan a barcode">
        <ScanBarcode size={22} />
      </button>

      <button className="fab" onClick={onAdd} aria-label="Add food">
        <Plus size={28} />
      </button>
    </div>
  )
}
