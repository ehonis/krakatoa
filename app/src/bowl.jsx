/*
 * Krakatoa — build an order at a chain: a bowl at Chipotle or Bibibop, a tray at
 * McDonald's or Culver's.
 *
 * The question a build-your-own menu raises is "how much is the steak, in
 * calories and protein?" So every part shows its own numbers on its chip — the steak says 240 and 23 g of protein before it is tapped —
 * and the running total sits at the thumb, moving as he taps.
 *
 * One screen, every step on it, rather than a wizard that asks one question per
 * page. A bowl is five taps; five screens of one question each is how a thing
 * built for a restaurant queue ends up used at a desk.
 *
 * Two things the bigger menus added. A thing that comes in SIZES is one chip
 * with its sizes under it, not four chips — pick Large, then tap the fries. And
 * a long menu is searchable and its tail folded (drinks, sauces, breakfast),
 * because a hundred chips is a page you scroll to find the Big Mac on.
 */

import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronDown, Minus, Plus, Check, BookMarked, FileText, Search, X } from 'lucide-react'
import {
  addToBowl, removeFromBowl, bowlTotals, bowlName, bowlComponents, bowlVessel, effectiveQty,
  stepSize, selKey, portionOf, defaultPortionId, picks,
} from './lib/restaurants.js'
import { round } from './lib/food.js'

/** "½", "1½", "2" — how a quantity reads on a chip. */
function qtyLabel(q) {
  const whole = Math.floor(q)
  const half = Math.abs(q - whole - 0.5) < 0.01
  if (half) return whole ? `${whole}½` : '½'
  return String(round(q, 2))
}

/** "Regular · 22 fl oz" -> "Regular". The chip's own line carries the rest. */
const sizeName = (p) => p.label.split(' · ')[0]

function Part({ item, selection, size, onAdd, onRemove }) {
  const [pid, setPid] = useState(defaultPortionId(item))
  const p = portionOf(item, pid)
  const qty = selection[selKey(item, p.id)] || 0
  const anyOn = item.portions.some(x => selection[selKey(item, x.id)] > 0)
  // The chip shows what THIS order gets of it: a bibiCup's rice is half.
  const eff = effectiveQty(item, qty > 0 ? qty : 1, size)
  const kcal = Math.round(p.kcal * eff)
  const protein = round((p.protein || 0) * eff, 1)

  return (
    <div className={`part ${anyOn ? 'on' : ''}`}>
      <button className="part-main" onClick={() => onAdd(p.id)} aria-label={`Add ${item.name}${item.portions.length > 1 ? `, ${sizeName(p)}` : ''}`}>
        <span className="part-name">{item.name}</span>
        <span className="part-nums">
          <b>{kcal}</b> kcal · {protein}P
          <small>{p.label}</small>
        </span>
      </button>
      {item.portions.length > 1 && (
        <div className="part-sizes" role="radiogroup" aria-label={`${item.name} size`}>
          {item.portions.map(x => {
            const n = selection[selKey(item, x.id)] || 0
            return (
              <button
                key={x.id}
                role="radio"
                aria-checked={x.id === p.id}
                className={`part-size ${x.id === p.id ? 'on' : ''}`}
                onClick={() => setPid(x.id)}
              >
                {sizeName(x)}{n > 0 && <b>{qtyLabel(n)}</b>}
              </button>
            )
          })}
        </div>
      )}
      {qty > 0 && (
        <span className="part-qty">
          <button className="icon-btn sm" onClick={() => onRemove(p.id)} aria-label={`Less ${item.name}`}><Minus size={14} /></button>
          <b>{qtyLabel(qty)}×</b>
          <button className="icon-btn sm" onClick={() => onAdd(p.id)} aria-label={`More ${item.name}`}><Plus size={14} /></button>
        </span>
      )}
    </div>
  )
}

function Step({ chain, step, items, selection, size, searching, onAdd, onRemove }) {
  const inIt = picks(chain, selection).filter(x => x.item.step === step.id).length
  // Within a step, grouped by the chain's own table: hot and cold toppings are
  // one step and two headings.
  const cats = [...new Set(items.map(i => i.category))]
  const head = (
    <>
      {step.label}
      {inIt > 0 && <span className="step-count">{inIt}</span>}
      {step.hint && !step.collapsed && <small className="step-hint">{step.hint}</small>}
      {!step.hint && stepSize(chain, step.id) === 0.5 && <small className="step-hint">in halves</small>}
    </>
  )
  const body = cats.map(cat => (
    <div key={cat}>
      {cats.length > 1 && <h4 className="bowl-cat">{cat}</h4>}
      <div className="parts">
        {items.filter(i => i.category === cat).map(item => (
          <Part
            key={item.id}
            item={item}
            selection={selection}
            size={size}
            onAdd={(pid) => onAdd(item, pid)}
            onRemove={(pid) => onRemove(item, pid)}
          />
        ))}
      </div>
    </div>
  ))

  // A folded step is still IN the page — a <details> — so nothing on the menu
  // is ever more than one tap from the screen. It opens itself while he is
  // searching, and stays open once something in it is picked.
  if (step.collapsed && !searching) {
    return (
      <details className="bowl-step bowl-fold" open={inIt > 0 || undefined}>
        <summary className="list-head">{head}<small className="step-hint">{items.length}</small><ChevronDown size={16} className="fold-chev" /></summary>
        {body}
      </details>
    )
  }
  return (
    <section className="bowl-step">
      <h3 className="list-head">{head}</h3>
      {body}
    </section>
  )
}

function matches(item, words) {
  const hay = `${item.name} ${item.category}`.toLowerCase()
  return words.every(w => hay.includes(w))
}

const longDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

export default function BowlBuilder({ chain, mode, onBack, onLog, onSave, onAddComponents }) {
  const [sizeId, setSizeId] = useState(chain.sizes?.[0]?.id || null)
  const [selection, setSelection] = useState({})
  const [saved, setSaved] = useState(false)
  const [q, setQ] = useState('')

  const size = chain.sizes?.find(s => s.id === sizeId) || null
  const total = useMemo(() => bowlTotals(chain, selection, size), [chain, selection, size])
  const name = bowlName(chain, selection, size)
  const empty = !Object.keys(selection).length
  const forMeal = mode === 'component'
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  // A bowl menu is sixty parts on one screen and needs no search; a menu of
  // whole dishes is a hundred-odd and does.
  const searchable = chain.kind === 'order' || chain.items.length > 80

  const add = (item, pid) => { setSelection(s => addToBowl(s, item, chain, pid)); setSaved(false) }
  const remove = (item, pid) => { setSelection(s => removeFromBowl(s, item, chain, pid)); setSaved(false) }

  /* The order as an ordinary food: one portion carrying the whole total, plus
     its parts — so it goes through the same detail screen and the same log
     writer as everything else, and the food screen can list what was in it. */
  const asFood = () => {
    const vessel = bowlVessel(chain, selection, size)
    return {
      name,
      brand: null,
      gtin: null,
      image: null,
      source: 'combo',
      components: bowlComponents(chain, selection, size),
      portions: [{
        id: 'combo',
        label: vessel ? `1 ${vessel}` : '1 order',
        grams: null,
        kcal: total.kcal, protein: total.protein, carbs: total.carbs, fat: total.fat,
      }],
    }
  }

  const src = chain.source || {}
  const shown = (chain.steps || []).map(step => ({
    step,
    items: chain.items.filter(i => i.step === step.id && (!words.length || matches(i, words))),
  })).filter(s => s.items.length)

  return (
    <div className="pane">
      <header className="pane-head">
        <button className="icon-btn" onClick={onBack} aria-label="Back"><ChevronLeft size={24} /></button>
        <h2>{chain.name}</h2>
      </header>

      <div className="pane-body bowl-body">
        {chain.sizes?.length > 1 && (
          <div className="seg" role="tablist" aria-label="Size">
            {chain.sizes.map(s => (
              <button
                key={s.id}
                role="tab"
                aria-selected={s.id === sizeId}
                className={`seg-btn ${s.id === sizeId ? 'on' : ''}`}
                onClick={() => setSizeId(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}

        {searchable && (
          <div className="search-box">
            <Search size={18} />
            <input className="text-input" value={q} onChange={e => setQ(e.target.value)}
              placeholder={`Search ${chain.short}…`} aria-label={`Search the ${chain.short} menu`} />
            {q && <button className="icon-btn sm" onClick={() => setQ('')} aria-label="Clear"><X size={18} /></button>}
          </div>
        )}

        {shown.map(({ step, items }) => (
          <Step
            key={step.id}
            chain={chain}
            step={step}
            items={items}
            selection={selection}
            size={size}
            searching={words.length > 0}
            onAdd={add}
            onRemove={remove}
          />
        ))}
        {words.length > 0 && !shown.length && <p className="muted row-note">Nothing on the {chain.short} menu matches “{q.trim()}”.</p>}

        {/* The receipt. Every number on this screen came from this source. */}
        <p className="provenance bowl-source">
          <FileText size={12} /> From {src.what || `${chain.short}'s nutrition data`}
          {src.published && <>, {src.dateWord || 'updated'} {longDate(src.published)}</>}
          {src.from && src.from !== src.published && <> (oldest item {longDate(src.from)})</>}.
          {' '}{chain.note}
        </p>
      </div>

      <footer className="pane-foot bowl-foot">
        <div className="bowl-total">
          <strong>{total.kcal.toLocaleString()}</strong><span>kcal</span>
          <em><b>{Math.round(total.protein)}</b>P · <b>{Math.round(total.carbs)}</b>C · <b>{Math.round(total.fat)}</b>F</em>
          {total.sodium > 0 && <small>{name.replace(`${chain.short} · `, '')} · {total.sodium.toLocaleString()} mg sodium</small>}
        </div>

        {forMeal ? (
          <button className="btn btn-primary" disabled={empty}
            onClick={() => onAddComponents(bowlComponents(chain, selection, size))}>
            Add these to the combo
          </button>
        ) : (
          <div className="row-btns">
            <button
              className="btn"
              disabled={empty || saved}
              onClick={() => { onSave({ name, components: bowlComponents(chain, selection, size) }); setSaved(true) }}
            >
              {saved ? <><Check size={16} /> Saved</> : <><BookMarked size={16} /> Save combo</>}
            </button>
            <button className="btn btn-primary" disabled={empty} onClick={() => onLog(asFood())}>
              Log it
            </button>
          </div>
        )}
      </footer>
    </div>
  )
}
