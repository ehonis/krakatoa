/*
 * Krakatoa — putting food on the day.
 *
 * ONE screen with every door on it, rather than a menu that asks how he would
 * like to answer before letting him answer. Recents and saved meals lead because
 * they are the honest majority of eating: nobody scans the same oats every
 * morning for a month, and a tracker that makes him is one he stops opening.
 *
 * Every door lands on `FoodDetail`, which is the only place a quantity is
 * chosen — so the scan, the search, the recent, the basic, the saved meal and
 * the hand-typed food all end at the same two questions (how much, which meal)
 * and produce the same entry.
 *
 * The one variation is MODE. Opened normally it logs; opened from the meal
 * builder it hands a component back instead. Same screens, one branch at the end.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ScanBarcode, Search, X, Plus, Minus, ChevronLeft, Loader2,
  History, PencilLine, CircleAlert, RotateCw, Sparkles, Carrot, BookMarked, Star,
  UtensilsCrossed, ScanText,
} from 'lucide-react'
import Scanner from './scanner.jsx'
import Thumb from './thumb.jsx'
import MealBuilder, { MealRow } from './mealbuilder.jsx'
import BowlBuilder from './bowl.jsx'
import LabelFood from './labelfood.jsx'
import AskAI from './ask.jsx'
import { portionOf, searchMenus, useRestaurants } from './lib/restaurants.js'
import { byCategory, searchBasics, useBasics } from './lib/basics.js'
import { comboAsFood, componentOf } from './lib/combos.js'
import { MEALS, amountFor, mealLabel, mealNow, portionLabel, round, titleOf } from './lib/food.js'

/* ------------------------------------------------------------------ pieces */

function Stepper({ value, onChange, step = 1, min = 0, max = 9999, suffix }) {
  // A text input that owns its text, for the reason Bushido documents at length: a
  // controlled box running Number() per keystroke turns "1." into 1 and eats the
  // dot before the 5 arrives, which reads as "decimals are not allowed".
  const [text, setText] = useState(String(value ?? ''))
  const mine = useRef(false)

  useEffect(() => {
    if (!mine.current) setText(String(value ?? ''))
    mine.current = false
  }, [value])

  const commit = (raw) => {
    const clean = String(raw).replace(',', '.').replace(/[^\d.]/g, '')
    mine.current = true
    setText(clean)
    const n = Number(clean)
    if (clean !== '' && Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)))
  }

  const bump = (d) => onChange(Math.min(max, Math.max(min, round((Number(value) || 0) + d, 2))))

  return (
    <div className="stepper">
      <button className="step-btn" onClick={() => bump(-step)} aria-label="Less"><Minus size={20} /></button>
      <div className="step-value">
        <input
          type="text"
          inputMode="decimal"
          value={text}
          onChange={e => commit(e.target.value)}
          onBlur={() => setText(String(value ?? ''))}
          aria-label="Amount"
        />
        {suffix && <span className="step-suffix">{suffix}</span>}
      </div>
      <button className="step-btn" onClick={() => bump(step)} aria-label="More"><Plus size={20} /></button>
    </div>
  )
}

function FoodRow({ food, sub, right, onClick, badge }) {
  return (
    <button className="food-row" onClick={onClick}>
      <Thumb food={food} />
      <span className="food-row-main">
        <span className="food-row-name">{titleOf(food)}</span>
        {sub && <span className="food-row-sub">{sub}</span>}
      </span>
      {badge && <span className={`src src-${badge}`}>{badge}</span>}
      {right && <span className="food-row-kcal">{right}</span>}
    </button>
  )
}

/**
 * Look the typed name up without leaving the form. This closes a real gap:
 * the only search in the app was on the screen BEFORE this one, so landing here
 * from a missed scan meant either backing out or typing calories from memory.
 *
 * It does not search until asked. An automatic search on every keystroke would
 * put a list of half-matches under a half-typed word, and the name box is the
 * one field on this screen that is always right — he knows what he ate.
 */
function LookupHelper({ query, basics, onFill }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState(null)
  const q = query.trim()

  // The basics answer instantly and offline, so they are shown the moment he
  // asks while the two databases are still being waited on.
  const local = useMemo(() => searchBasics(basics.foods, q, 6), [basics.foods, q])

  const run = async () => {
    setOpen(true)
    setBusy(true)
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`)
      const body = await res.json()
      setResults(body.foods || [])
    } catch {
      setResults([])
    } finally {
      setBusy(false)
    }
  }

  if (q.length < 2) return null

  if (!open) {
    return (
      <button className="lookup-btn" onClick={run}>
        <Search size={16} />
        Look up “{q}” for the calories
      </button>
    )
  }

  const shown = [...local, ...(results || [])].slice(0, 10)

  return (
    <section className="field">
      <label>
        Tap one to fill the numbers in
        <button className="link lookup-again" onClick={run} disabled={busy}>
          <RotateCw size={13} /> Search again
        </button>
      </label>
      {busy && !local.length && <p className="muted row-note"><Loader2 className="spin" size={16} /> Searching…</p>}
      {!busy && shown.length === 0 && (
        <p className="muted row-note">Nothing found — type the numbers below.</p>
      )}
      <div className="list">
        {shown.map((food, i) => (
          <FoodRow
            key={`${food.gtin || food.id || food.name}-${i}`}
            food={food}
            sub={food.portions[0]?.label}
            right={`${food.portions[0]?.kcal} kcal`}
            badge={food.source}
            onClick={() => { onFill(food); setOpen(false) }}
          />
        ))}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------- food detail */

/**
 * How much, and which meal. The portion list comes from the database and the
 * real-world serving leads it — see server/nutrition.js on why 100 g is never
 * first when a bar is a bar.
 */
function FoodDetail({ food, date, defaults, mode, starred, onStar, onBack, onLog }) {
  const portions = food.portions?.length ? food.portions : [{ id: 'serving', label: 'serving', kcal: 0 }]
  // A chain item opens on the size you would order unasked (a medium fry), not
  // the first one listed (the small).
  const [portionId, setPortionId] = useState(defaults?.portion?.id || food.defaultPortion || portions[0].id)
  const [qty, setQty] = useState(defaults?.qty ?? 1)
  const [meal, setMeal] = useState(defaults?.meal || mealNow())

  const portion = portions.find(p => p.id === portionId) || portions[0]
  const amount = amountFor(portion, qty)
  const forMeal = mode === 'component'

  return (
    <div className="pane">
      <header className="pane-head">
        <button className="icon-btn" onClick={onBack} aria-label="Back"><ChevronLeft size={24} /></button>
        <h2>{titleOf(food)}</h2>
        {/* Starring here rather than only after eating: the point of a star is
            the protein powder he has just looked up and has not had yet. */}
        {onStar && (
          <button
            className={`icon-btn ${starred ? 'starred' : ''}`}
            onClick={() => onStar(food, !starred)}
            aria-label={starred ? 'Unstar' : 'Star this food'}
          >
            <Star size={22} fill={starred ? 'currentColor' : 'none'} />
          </button>
        )}
      </header>

      <div className="pane-body">
        <div className="macro-readout">
          <Thumb food={food} size={72} />
          <div className="macro-readout-kcal">
            <strong>{amount.kcal.toLocaleString()}</strong>
            <span>kcal</span>
          </div>
          <div className="macro-readout-macros">
            <span><b>{amount.protein}</b>g protein</span>
            <span><b>{amount.carbs}</b>g carbs</span>
            <span><b>{amount.fat}</b>g fat</span>
          </div>
          {food.usdaName && <p className="provenance">USDA · {food.usdaName}</p>}
          {food.source === 'label' && <p className="provenance">From its nutrition label, as you saved it</p>}
          {food.source === 'ai' && <p className="provenance">Estimated by AI — nobody publishes this one</p>}
        </div>

        {portions.length > 1 && (
          <section className="field">
            <label>Serving</label>
            <div className="chips">
              {portions.map(p => (
                <button
                  key={p.id}
                  className={`chip ${p.id === portionId ? 'on' : ''}`}
                  onClick={() => setPortionId(p.id)}
                >
                  {p.label}
                  <span className="chip-sub">{p.kcal} kcal</span>
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="field">
          <label>How many</label>
          {/* Quarters, because half a bar and a quarter of a pizza are the two
              corrections anyone actually makes. */}
          <Stepper value={qty} onChange={setQty} step={0.25} min={0.25} max={99} />
          <p className="field-hint">{portionLabel(qty, portion)}</p>
        </section>

        {/* A component of a meal has no meal of its own — the meal does. */}
        {!forMeal && (
          <section className="field">
            <label>Meal</label>
            <div className="chips">
              {MEALS.map(m => (
                <button key={m.id} className={`chip ${m.id === meal ? 'on' : ''}`} onClick={() => setMeal(m.id)}>
                  {m.label}
                </button>
              ))}
            </div>
          </section>
        )}
      </div>

      <footer className="pane-foot">
        <button className="btn btn-primary" onClick={() => onLog({ food, portion, qty, meal, date })}>
          {forMeal
            ? `Add ${amount.kcal.toLocaleString()} kcal to the combo`
            : `Add ${amount.kcal.toLocaleString()} kcal to ${mealLabel(meal)}`}
        </button>
      </footer>
    </div>
  )
}

/* ----------------------------------------------------------- manual entry */

/** The escape hatch, and the answer for everything with no barcode on it. */
function ManualFood({ onBack, onPick, initialName = '', basics }) {
  const [name, setName] = useState(initialName)
  const [kcal, setKcal] = useState('')
  const [protein, setProtein] = useState('')
  const [carbs, setCarbs] = useState('')
  const [fat, setFat] = useState('')
  const [filledFrom, setFilledFrom] = useState(null)

  const n = (v) => (v === '' ? 0 : Number(v) || 0)
  const ready = name.trim() && kcal !== '' && Number(kcal) > 0

  /*
   * Taking the numbers off a database result and dropping them into the boxes,
   * rather than jumping to the detail screen. The difference matters: this screen
   * is where he lands when a scan MISSED, so the food is usually nearly-but-not-
   * quite one of the results — his leftovers are not the restaurant's portion —
   * and every field stays his to correct afterwards.
   */
  const fillFrom = (food) => {
    const p = food.portions?.[0]
    if (!p) return
    setName(prev => prev.trim() || food.name)
    setKcal(String(p.kcal ?? ''))
    setProtein(p.protein == null ? '' : String(p.protein))
    setCarbs(p.carbs == null ? '' : String(p.carbs))
    setFat(p.fat == null ? '' : String(p.fat))
    setFilledFrom({ label: p.label, source: food.source, name: titleOf(food) })
  }

  const sourceName = (s) => (s === 'usda' ? 'USDA' : s === 'basic' ? 'the basics' : s === 'label' ? 'its label' : 'Open Food Facts')

  return (
    <div className="pane">
      <header className="pane-head">
        <button className="icon-btn" onClick={onBack} aria-label="Back"><ChevronLeft size={24} /></button>
        <h2>Add it by hand</h2>
      </header>
      <div className="pane-body">
        <section className="field">
          <label htmlFor="mf-name">What was it</label>
          <input id="mf-name" className="text-input" value={name} autoFocus
            onChange={e => setName(e.target.value)} placeholder="Chicken burrito" />
        </section>

        <LookupHelper query={name} basics={basics} onFill={fillFrom} />

        {filledFrom && (
          <p className="filled-note">
            <Sparkles size={14} />
            Numbers from <b>{filledFrom.name}</b> ({filledFrom.label}, {sourceName(filledFrom.source)}).
            Change anything that was not what you had.
          </p>
        )}

        <section className="field">
          <label htmlFor="mf-kcal">Calories</label>
          <input id="mf-kcal" className="text-input" inputMode="numeric" value={kcal}
            onChange={e => setKcal(e.target.value.replace(/[^\d.]/g, ''))} placeholder="650" />
        </section>
        {/* Macros are optional on purpose. A number he does not know is a field
            that stops the form, and calories alone is still a logged meal. */}
        <section className="field">
          <label>Macros, if you know them</label>
          <div className="macro-inputs">
            <span><input className="text-input" inputMode="decimal" value={protein}
              onChange={e => setProtein(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0" /><small>protein</small></span>
            <span><input className="text-input" inputMode="decimal" value={carbs}
              onChange={e => setCarbs(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0" /><small>carbs</small></span>
            <span><input className="text-input" inputMode="decimal" value={fat}
              onChange={e => setFat(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0" /><small>fat</small></span>
          </div>
        </section>
      </div>
      <footer className="pane-foot">
        <button
          className="btn btn-primary"
          disabled={!ready}
          onClick={() => onPick({
            name: name.trim(),
            brand: null,
            gtin: null,
            source: 'manual',
            image: null,
            portions: [{ id: 'serving', label: 'serving', grams: null, kcal: n(kcal), protein: n(protein), carbs: n(carbs), fat: n(fat) }],
          })}
        >
          Next
        </button>
      </footer>
    </div>
  )
}

/* --------------------------------------------------------- basics browser */

/** The generic foods, by category. An egg, a tablespoon of butter, a cup of rice. */
function BasicsBrowser({ basics, onBack, onPick }) {
  const [q, setQ] = useState('')
  const groups = useMemo(() => byCategory(basics), [basics])
  const hits = useMemo(() => searchBasics(basics.foods, q, 40), [basics.foods, q])

  return (
    <div className="pane">
      <header className="pane-head">
        <button className="icon-btn" onClick={onBack} aria-label="Back"><ChevronLeft size={24} /></button>
        <h2>Basic foods</h2>
      </header>
      <div className="pane-body">
        <div className="search-box">
          <Search size={18} />
          <input className="text-input" value={q} onChange={e => setQ(e.target.value)}
            placeholder="egg, butter, rice…" aria-label="Search basic foods" />
          {q && <button className="icon-btn sm" onClick={() => setQ('')} aria-label="Clear"><X size={18} /></button>}
        </div>

        {q.trim() ? (
          <section className="list">
            {hits.length === 0 && <p className="muted row-note">Nothing in the basics matches that.</p>}
            {hits.map(f => (
              <FoodRow key={f.id} food={f} sub={f.portions[0]?.label}
                right={`${f.portions[0]?.kcal} kcal`} onClick={() => onPick(f)} />
            ))}
          </section>
        ) : (
          /* Native <details>, so every food is in the page whether or not the
             group is open — the same reason Bushido folds its sport catalogs that
             way rather than mounting them on demand. */
          groups.map(g => (
            <details className="cat" key={g.category}>
              <summary>{g.category}<span className="cat-count">{g.foods.length}</span></summary>
              <div className="list">
                {g.foods.map(f => (
                  <FoodRow key={f.id} food={f} sub={f.portions[0]?.label}
                    right={`${f.portions[0]?.kcal} kcal`} onClick={() => onPick(f)} />
                ))}
              </div>
            </details>
          ))
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------ restaurant menus */

/**
 * Chain menus — Chipotle, and the rest. A separate screen from the main search
 * because this source costs a METERED API call: folding it into the debounced
 * grocery search would spend a day's free quota on a morning of typing.
 *
 * A row arrives with calories only (`partial`), because Nutritionix gives macros
 * one item at a time. Tapping fetches the full one, which is also when it gets
 * cached — so a bowl he eats weekly costs one call ever.
 */
function RestaurantSearch({ chains, onBack, onPick, onBuildMeal, onOpenChain }) {
  const [q, setQ] = useState('')
  // `configured: null` means NOT YET KNOWN. Starting it at `true` showed a search
  // box to someone with no key, who would then type, get nothing back, and have
  // no idea why — the setup steps have to be the first thing on the screen, not
  // the consolation prize after a failed search.
  const [state, setState] = useState({ status: 'idle', foods: [], configured: null, error: null })
  const [loading, setLoading] = useState(null)

  useEffect(() => {
    let alive = true
    // Costs no API call: the server answers this from the presence of a key.
    fetch('/api/restaurant?q=')
      .then(r => r.json())
      .then(d => { if (alive) setState(s => ({ ...s, configured: d.configured })) })
      .catch(() => { if (alive) setState(s => ({ ...s, configured: true })) })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    const query = q.trim()
    if (query.length < 2) { setState(s => ({ ...s, status: 'idle', foods: [] })); return undefined }
    setState(s => ({ ...s, status: 'searching' }))
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/restaurant?q=${encodeURIComponent(query)}`)
        const body = await res.json()
        setState({ status: 'done', foods: body.foods || [], configured: body.configured, error: body.error || null })
      } catch (e) {
        setState({ status: 'done', foods: [], configured: true, error: String(e.message || e) })
      }
    }, 400)
    return () => clearTimeout(t)
  }, [q])

  /* A partial row cannot be logged — fetch the macros before going on. */
  const take = async (food) => {
    if (!food.partial) { onPick(food); return }
    setLoading(food.nixItemId)
    try {
      const res = await fetch(`/api/restaurant/item?id=${encodeURIComponent(food.nixItemId)}`)
      const body = await res.json()
      if (body.food) onPick(body.food)
    } catch { /* leave him on the list rather than opening an empty food */ } finally {
      setLoading(null)
    }
  }

  return (
    <div className="pane">
      <header className="pane-head">
        <button className="icon-btn" onClick={onBack} aria-label="Back"><ChevronLeft size={24} /></button>
        <h2>Restaurant menus</h2>
      </header>
      <div className="pane-body">
        {/*
          Chains with a menu here, first. These are generated from each chain's
          own nutrition data (scripts/restaurants.build.mjs), need no key, and work
          offline — which is why they lead, above everything that does not.
        */}
        {chains.length === 0 && (
          <p className="muted small-note">
            No chain menus are built on this server. They are optional; the server's
            owner can generate them (see Restaurant menus in docs/self-hosting.md).
            Ask AI can still learn a chain from its own nutrition page.
          </p>
        )}
        {chains.length > 0 && (
          <section className="list">
            <h3 className="list-head"><UtensilsCrossed size={16} /> Menus</h3>
            {chains.map(c => (
              <button key={c.id} className="big-action" onClick={() => onOpenChain(c)}>
                <UtensilsCrossed size={26} />
                <span>
                  <strong>{c.name}</strong>
                  <small>{c.kind === 'order' ? 'Build an order' : 'Build a bowl'} · {c.items.length} items, from {c.source?.what || 'their own nutrition data'}</small>
                </span>
              </button>
            ))}
          </section>
        )}

        <h3 className="list-head">Other chains</h3>
        {state.configured === null ? (
          <p className="muted row-note"><Loader2 className="spin" size={16} /> Checking…</p>
        ) : state.configured === false ? (
          /*
           * Nutritionix CLOSED its free tier on 2026-09-22 — "Free public trials
           * for the Nutritionix API are no longer available", business accounts
           * only. So this screen no longer sends anyone to a signup that will
           * turn them away; it names the one thing that does work today and is one tap
           * from here. The integration itself is kept: it lights up the moment
           * credentials exist, and nothing else in the app depends on it.
           */
          <section className="field">
            <div className="filled-note">
              <CircleAlert size={14} />
              <span>
                <b>There is no free database of chain menus any more.</b> Nutritionix
                closed its free tier, and MenuStat, Open Food Facts and USDA were
                all checked — none carry restaurant chains. A chain gets a menu
                here by having its own nutrition PDF read in, which is how
                Bibibop is above.
              </span>
            </div>

            <p className="muted">
              What works: get the numbers once from the chain&apos;s own nutrition
              page, build it here as a combo, and it is one tap forever after. A
              Chipotle bowl is the same bowl every time.
            </p>

            <button className="btn btn-primary" onClick={onBuildMeal}>
              <BookMarked size={18} /> Build it as a combo
            </button>

            <p className="muted small-note">
              If you ever get Nutritionix business credentials, put
              <code>nutritionixId</code> and <code>nutritionixKey</code> in
              <code>data/config.json</code> and this screen becomes a search.
            </p>
          </section>
        ) : (
          <>
            <div className="search-box">
              <Search size={18} />
              <input className="text-input" value={q} onChange={e => setQ(e.target.value)} autoFocus
                placeholder="chipotle chicken bowl, big mac…" aria-label="Search restaurant menus" />
              {q && <button className="icon-btn sm" onClick={() => setQ('')} aria-label="Clear"><X size={18} /></button>}
            </div>

            {state.error && <p className="muted row-note"><CircleAlert size={15} /> {state.error}</p>}
            {state.status === 'searching' && <p className="muted row-note"><Loader2 className="spin" size={16} /> Searching…</p>}
            {state.status === 'done' && !state.foods.length && !state.error && (
              <p className="muted row-note">Nothing on the menus matches that.</p>
            )}

            <section className="list">
              {state.foods.map(f => (
                <FoodRow
                  key={f.nixItemId}
                  food={f}
                  sub={loading === f.nixItemId ? 'Getting the macros…' : f.portions[0]?.label}
                  right={`${f.portions[0]?.kcal} kcal`}
                  onClick={() => take(f)}
                />
              ))}
            </section>
          </>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------- the barcode result */

/**
 * What a scan produced. The three outcomes are deliberately different screens,
 * because "not in the database", "the databases are down" and "that is not a
 * barcode" have three different fixes and one of them is just pressing retry.
 */
function ScanResult({ state, code, onBack, onRetry, onManual, onLabel }) {
  if (state.status === 'looking') {
    return (
      <div className="pane pane-center">
        <Loader2 className="spin" size={32} />
        <p>Looking up {code}…</p>
      </div>
    )
  }

  const reason = state.reason
  const copy = reason === 'sources-down'
    ? { head: 'The food databases did not answer', body: 'Could be them, could be the network. The barcode is fine.', retry: true }
    : reason === 'not-a-barcode'
      ? { head: 'That is not a valid barcode', body: 'The check digit does not match, so it was misread or mistyped.', retry: false }
      : { head: 'Not in either database', body: 'Open Food Facts and USDA have both never heard of it. Photograph the nutrition label on the back and it fills itself in — and the next time you scan this barcode, it is there.', retry: false, label: true }

  return (
    <div className="pane">
      <header className="pane-head">
        <button className="icon-btn" onClick={onBack} aria-label="Back"><ChevronLeft size={24} /></button>
        <h2>{code}</h2>
      </header>
      <div className="pane-body pane-center">
        <CircleAlert size={32} className="muted" />
        <h3>{copy.head}</h3>
        <p className="muted">{copy.body}</p>
        <div className="stack">
          {copy.retry && <button className="btn" onClick={onRetry}><RotateCw size={16} /> Try again</button>}
          {copy.label
            ? <>
              <button className="btn btn-primary" onClick={onLabel}><ScanText size={16} /> Read the label</button>
              <button className="btn" onClick={onManual}>Just the calories</button>
            </>
            : <button className="btn btn-primary" onClick={onManual}>Add it by hand</button>}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- the add flow */

export default function AddFlow({
  date, recent, combos, starred, isStarred, seedComponents, relog, startScanning, askThread,
  onClose, onLog, onSaveCombo, onStar,
}) {
  // home | scan | result | detail | manual | label | ask | basics | meal
  const [view, setView] = useState(
    seedComponents ? 'meal' : relog ? 'detail' : startScanning ? 'scan' : askThread ? 'ask' : 'home',
  )
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [searching, setSearching] = useState(false)
  const [picked, setPicked] = useState(relog || null)
  const [defaults, setDefaults] = useState(null)
  const [scan, setScan] = useState({ status: 'idle', code: null, reason: null })
  // The barcode that missed, when the label screen was opened from the miss.
  const [labelGtin, setLabelGtin] = useState(null)

  /* The meal being built, and where a picked food should go back to. */
  const [draft, setDraft] = useState(seedComponents ? { name: '', components: seedComponents } : null)
  const [mode, setMode] = useState('log')
  const takeComponent = useRef(null)

  const basics = useBasics()
  const restaurants = useRestaurants()
  const [chain, setChain] = useState(null)

  const lookup = useCallback(async (code) => {
    setView('result')
    setScan({ status: 'looking', code, reason: null })
    try {
      const res = await fetch(`/api/lookup?code=${encodeURIComponent(code)}`)
      const body = await res.json()
      if (body.food) {
        setPicked(body.food)
        setDefaults(null)
        setView('detail')
        setScan({ status: 'idle', code, reason: null })
      } else {
        setScan({ status: 'done', code, reason: body.reason || 'not-found' })
      }
    } catch {
      setScan({ status: 'done', code, reason: 'sources-down' })
    }
  }, [])

  /*
   * Debounced network search. The basics are matched locally and instantly, so
   * something useful is on screen before this resolves.
   *
   * Every request is ABORTED when the query moves on. Before 2026-09-25 only the
   * timer was cleared, so a slow answer for "don" could land after the answer
   * for "donut" and replace it — one of the ways "donut found nothing, then
   * found everything" happened. `tried` is kept so the screen can tell "nothing
   * matched" from "the databases did not answer", which it used to call the
   * same thing.
   */
  const [tried, setTried] = useState([])
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setResults(null); setTried([]); setSearching(false); return undefined }
    setSearching(true)
    const ctl = new AbortController()
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctl.signal })
        const body = await res.json()
        setResults(body.foods || [])
        setTried(body.tried || [])
      } catch (e) {
        if (e.name === 'AbortError') return
        setResults([])
        setTried([{ source: 'network', error: 'Krakatoa did not answer' }])
      }
      setSearching(false)
    }, 350)
    return () => { clearTimeout(t); ctl.abort() }
  }, [query, retry])

  const allDown = tried.length > 0 && tried.every(x => x.error)
  // One automatic second try when everything failed — most of these are a
  // database having a bad few seconds, and a retry is what he did by hand.
  const autoRetried = useRef('')
  useEffect(() => {
    const q = query.trim()
    if (!allDown || searching || autoRetried.current === q) return undefined
    autoRetried.current = q
    const t = setTimeout(() => setRetry(n => n + 1), 1500)
    return () => clearTimeout(t)
  }, [allDown, searching, query])

  const localHits = useMemo(
    () => searchBasics(basics.foods, query, 8),
    [basics.foods, query],
  )
  // Menu items are on the device too, so "steak" or "bibibop" answers instantly
  // alongside the basics, before either database has been asked.
  const menuHits = useMemo(
    () => searchMenus(restaurants.chains, query, 6),
    [restaurants.chains, query],
  )

  const pick = (food, d) => { setPicked(food); setDefaults(d || null); setView('detail') }

  /** Where the detail screen's button goes: the log, or the meal being built. */
  const finish = ({ food, portion, qty, meal, date: when }) => {
    if (mode === 'component') {
      takeComponent.current?.(componentOf(food, portion, qty))
      setMode('log')
      setView('meal')
      return
    }
    onLog({ food, portion, qty, meal, date: when })
    onClose()
  }

  /* --------------------------------------------------------------- screens */

  if (view === 'scan') {
    return (
      <Scanner
        onCode={lookup}
        // Backing out of the camera returns where he CAME from. Opened straight
        // from the day, that is the day — landing him on the add screen he never
        // asked for would make the shortcut cost a tap instead of saving two.
        onClose={() => {
          if (startScanning) { onClose(); return }
          setView(mode === 'component' ? 'meal' : 'home')
        }}
        onManual={() => setView('manual')}
      />
    )
  }

  if (view === 'result') {
    return (
      <ScanResult
        state={scan}
        code={scan.code}
        onBack={() => setView('home')}
        onRetry={() => lookup(scan.code)}
        onManual={() => setView('manual')}
        onLabel={() => { setLabelGtin(scan.code); setView('label') }}
      />
    )
  }

  if (view === 'ask') {
    return (
      <AskAI
        date={date}
        openThreadId={askThread || null}
        onBack={() => setView('home')}
        // Each ticked row through the ordinary log writer, one entry apiece —
        // the store merges functionally and mints a fresh id per entry, so
        // five at once cannot land on top of each other.
        onLogMany={(list) => { for (const l of list) onLog(l); onClose() }}
        onSaveCombo={(combo) => onSaveCombo(combo)}
        onStar={onStar}
        onLabel={() => { setLabelGtin(null); setView('label') }}
      />
    )
  }

  if (view === 'label') {
    return (
      <LabelFood
        gtin={labelGtin}
        initialName={labelGtin ? '' : query.trim()}
        onBack={() => setView(labelGtin ? 'result' : mode === 'component' ? 'meal' : 'home')}
        onSave={(food) => {
          // Kept, not just logged once: starred so it is one tap away from now
          // on, and remembered under its barcode so the scan that missed today
          // finds it tomorrow. Neither may stop it being logged.
          onStar?.(food, true)
          if (food.gtin) {
            fetch('/api/food', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ food }) })
              .catch(() => {})
          }
          pick(food)
        }}
      />
    )
  }

  if (view === 'manual') {
    return (
      <ManualFood
        initialName={query.trim()}
        basics={basics}
        onBack={() => setView(mode === 'component' ? 'meal' : 'home')}
        onPick={(food) => pick(food)}
      />
    )
  }

  if (view === 'restaurant') {
    return (
      <RestaurantSearch
        chains={restaurants.chains}
        onBack={() => setView(mode === 'component' ? 'meal' : 'home')}
        onPick={(food) => pick(food)}
        onBuildMeal={() => { setDraft({ name: '', components: [] }); setView('meal') }}
        onOpenChain={(c) => { setChain(c); setView('bowl') }}
      />
    )
  }

  if (view === 'bowl' && chain) {
    return (
      <BowlBuilder
        chain={chain}
        mode={mode}
        onBack={() => setView('restaurant')}
        // Logging goes through the ordinary detail screen, so the meal and the
        // quantity are asked the same way as for anything else — half a bowl
        // eaten is 0.5 there, not a special case here.
        onLog={(food) => pick(food, { qty: 1, meal: mealNow() })}
        onSave={(combo) => onSaveCombo(combo)}
        onAddComponents={(components) => {
          // Building a meal: the bowl's PARTS go in, not the bowl — meals do not
          // nest, so a combo's total can never depend on another one.
          for (const c of components) takeComponent.current?.(c)
          setMode('log')
          setView('meal')
        }}
      />
    )
  }

  if (view === 'basics') {
    return (
      <BasicsBrowser
        basics={basics}
        onBack={() => setView(mode === 'component' ? 'meal' : 'home')}
        onPick={(food) => pick(food)}
      />
    )
  }

  if (view === 'meal') {
    return (
      <MealBuilder
        initial={draft}
        onBack={() => { setDraft(null); setView('home') }}
        onSave={(combo) => { onSaveCombo(combo); setDraft(null); setView('home') }}
        onAddComponent={(components, name, take) => {
          // Keep what has been built so far, then go and pick the next thing.
          setDraft(d => ({ ...(d || {}), name, components }))
          takeComponent.current = (c) => setDraft(d => ({ ...d, components: [...(d?.components || []), c] }))
          void take
          setMode('component')
          setView('home')
        }}
      />
    )
  }

  if (view === 'detail' && picked) {
    return (
      <FoodDetail
        food={picked}
        date={date}
        defaults={defaults}
        mode={mode}
        starred={isStarred(picked)}
        onStar={onStar}
        onBack={() => setView('home')}
        onLog={finish}
      />
    )
  }

  const building = mode === 'component'
  const searchingNow = query.trim().length >= 2

  return (
    <div className="pane">
      <header className="pane-head">
        <h2>{building ? 'Add an ingredient' : 'Add food'}</h2>
        <button
          className="icon-btn"
          onClick={() => (building ? (setMode('log'), setView('meal')) : onClose())}
          aria-label="Close"
        >
          <X size={24} />
        </button>
      </header>

      <div className="pane-body">
        {/* The two doors that need no typing, side by side: a barcode, and
            everything else — a receipt, a plate, a sentence. */}
        <div className="big-pair">
          <button className="big-action" onClick={() => setView('scan')}>
            <ScanBarcode size={26} />
            <span>
              <strong>Scan a barcode</strong>
              <small>Packaged food</small>
            </span>
          </button>
          {!building && (
            <button className="big-action ai" onClick={() => setView('ask')}>
              <Sparkles size={26} />
              <span>
                <strong>Ask AI</strong>
                <small>A receipt, a plate, or words</small>
              </span>
            </button>
          )}
        </div>

        <div className="search-box">
          <Search size={18} />
          <input
            className="text-input"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search — egg, butter, burrito…"
            aria-label="Search for a food"
          />
          {query && <button className="icon-btn sm" onClick={() => setQuery('')} aria-label="Clear"><X size={18} /></button>}
        </div>

        {searchingNow ? (
          <section className="list">
            {/* Basics first and instantly: they are on the device, so "egg"
                answers before the databases have been asked. */}
            {localHits.map(f => (
              <FoodRow key={f.id} food={f} sub={f.portions[0]?.label}
                right={`${f.portions[0]?.kcal} kcal`} badge="basic" onClick={() => pick(f)} />
            ))}
            {menuHits.map(f => {
              const p = portionOf(f, f.defaultPortion)
              return (
                <FoodRow key={f.id} food={f} sub={`${f.brand} · ${p?.label}${f.portions.length > 1 ? ` · ${f.portions.length} sizes` : ''}`}
                  right={`${p?.kcal} kcal`} badge="restaurant" onClick={() => pick(f)} />
              )
            })}
            {searching && <p className="muted row-note"><Loader2 className="spin" size={16} /> Searching…</p>}
            {!searching && allDown && (
              <p className="muted row-note search-down">
                <CircleAlert size={16} /> The food databases did not answer.
                <button className="link" onClick={() => setRetry(n => n + 1)}>Try again</button>
              </p>
            )}
            {!searching && !allDown && tried.some(x => x.error && x.source === 'off') && (
              <p className="muted row-note small-note">Open Food Facts did not answer, so some results may be missing. <button className="link" onClick={() => setRetry(n => n + 1)}>Try again</button></p>
            )}
            {!searching && !allDown && results?.length === 0 && localHits.length === 0 && menuHits.length === 0 && (
              <p className="muted row-note">Nothing found. <button className="link" onClick={() => { setLabelGtin(null); setView('label') }}>From the label</button> or <button className="link" onClick={() => setView('manual')}>add it by hand</button></p>
            )}
            {results?.map((food, i) => (
              <FoodRow
                key={`${food.gtin || food.name}-${i}`}
                food={food}
                sub={food.portions[0]?.label}
                right={`${food.portions[0]?.kcal} kcal`}
                badge={food.source}
                onClick={() => pick(food)}
              />
            ))}
          </section>
        ) : (
          <>
            {/* A saved meal cannot be an ingredient of another meal — one level
                deep is a feature, not a limitation, and nesting would make a
                combo's totals depend on something that can change underneath it. */}
            {!building && combos.length > 0 && (
              <section className="list">
                <h3 className="list-head"><BookMarked size={16} /> Your combos</h3>
                {combos.map(c => (
                  <MealRow
                    key={c.id}
                    combo={c}
                    onClick={() => pick(comboAsFood(c), { qty: 1, meal: c.meal || mealNow() })}
                    onEdit={() => { setDraft(c); setView('meal') }}
                  />
                ))}
              </section>
            )}

            {starred.length > 0 && (
              <section className="list">
                <h3 className="list-head"><Star size={16} /> Starred</h3>
                {starred.map(f => (
                  <FoodRow
                    key={f.key}
                    food={f}
                    sub={f.portions?.[0]?.label}
                    right={f.portions?.[0] ? `${f.portions[0].kcal} kcal` : null}
                    onClick={() => pick(f)}
                  />
                ))}
              </section>
            )}

            {recent.length > 0 && (
              <section className="list">
                <h3 className="list-head"><History size={16} /> Recently eaten</h3>
                {recent.slice(0, 20).map(r => (
                  <FoodRow
                    key={r.key}
                    food={r.food}
                    sub={portionLabel(r.qty, r.portion)}
                    right={`${amountFor(r.portion, r.qty).kcal} kcal`}
                    onClick={() => pick(
                      { ...r.food, portions: r.portion ? [r.portion] : [] },
                      { portion: r.portion, qty: r.qty, meal: mealNow() },
                    )}
                  />
                ))}
              </section>
            )}

            <button className="big-action subtle" onClick={() => setView('restaurant')}>
              <UtensilsCrossed size={24} />
              <span>
                <strong>Restaurant menus</strong>
                {/* Read off the catalog, so it never again names one chain when there are five. */}
                <small>{restaurants.chains.map(c => c.short).join(', ') || 'No chain menus on this server yet'}</small>
              </span>
            </button>

            <button className="big-action subtle" onClick={() => setView('basics')}>
              <Carrot size={24} />
              <span>
                <strong>Basic foods</strong>
                <small>{basics.foods.length || 150} generic foods — eggs, rice, a donut, a cheeseburger</small>
              </span>
            </button>

            {!building && (
              <button
                className="big-action subtle"
                onClick={() => { setDraft({ name: '', components: [] }); setView('meal') }}
              >
                <BookMarked size={24} />
                <span>
                  <strong>Build a combo</strong>
                  <small>Your iced latte, your shake, your eggs — saved, one tap next time</small>
                </span>
              </button>
            )}

            <button className="big-action subtle" onClick={() => { setLabelGtin(null); setView('label') }}>
              <ScanText size={24} />
              <span>
                <strong>From a nutrition label</strong>
                <small>Photograph the back of the package, or type what it says</small>
              </span>
            </button>

            <button className="big-action subtle" onClick={() => setView('manual')}>
              <PencilLine size={24} />
              <span>
                <strong>Add it by hand</strong>
                <small>No barcode, or something you made yourself</small>
              </span>
            </button>
          </>
        )}
      </div>
    </div>
  )
}
