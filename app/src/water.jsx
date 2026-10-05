/*
 * Krakatoa — the day's water.
 *
 * A glass that fills. The buttons are the things he actually drinks out of
 * rather than a slider asking him to estimate in a unit nobody pours, and the
 * meter is the one place in this app where the point is to be nice to look at:
 * water is logged out of habit rather than interest, and a thing you enjoy
 * tapping gets tapped.
 *
 * THE WAVES ARE DRAWN, and that is the exception rather than the rule here — no
 * icon library has an animated liquid fill, because it is a shape driven by a
 * number rather than a glyph. Two sine paths at different speeds and opacities,
 * which is what stops it reading as one rigid shape sliding past.
 */

import { useState } from 'react'
import { Droplet, Minus, Plus, Undo2, PencilLine, X } from 'lucide-react'
import { WATER_NUDGE, WATER_STEPS, customWaterOz, ozToL, waterLevel } from './lib/macros.js'

/* One period of a sine, repeated four times so the path can slide a full period
   without its end coming into view. Drawn once, reused by both layers. */
const WAVE_D = `
  M 0 10
  c 12.5 0 12.5 -10 25 -10 s 12.5 10 25 10 s 12.5 -10 25 -10 s 12.5 10 25 10
  s 12.5 -10 25 -10 s 12.5 10 25 10 s 12.5 -10 25 -10 s 12.5 10 25 10
  L 200 40 L 0 40 Z
`

/*
 * Any amount at all, for the glass that is none of the buttons. Opens in the
 * buttons' place rather than a dialog: it is one number and one tap, and the
 * glass it is filling stays in view while he types it.
 */
function Custom({ onAdd, onClose }) {
  const [text, setText] = useState('')
  const [unit, setUnit] = useState('oz')
  const oz = customWaterOz(text, unit)
  const add = () => { if (oz) { onAdd(oz); onClose() } }
  return (
    <form className="water-custom" onSubmit={(e) => { e.preventDefault(); add() }}>
      <div className="water-custom-row">
        <input
          className="text-input"
          inputMode="decimal"
          autoFocus
          value={text}
          onChange={e => setText(e.target.value.replace(/[^\d.,]/g, ''))}
          placeholder={unit === 'ml' ? '500' : '20'}
          aria-label={`Amount in ${unit === 'ml' ? 'millilitres' : 'ounces'}`}
        />
        <div className="seg water-unit" role="tablist" aria-label="Unit">
          {['oz', 'ml'].map(u => (
            <button key={u} type="button" role="tab" aria-selected={unit === u}
              className={`seg-btn ${unit === u ? 'on' : ''}`} onClick={() => setUnit(u)}>
              {u === 'ml' ? 'mL' : 'oz'}
            </button>
          ))}
        </div>
      </div>
      <div className="water-custom-row">
        <button type="submit" className="btn btn-primary" disabled={!oz}>
          {oz ? `Add ${oz} oz` : 'Add'}
        </button>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Cancel"><X size={18} /></button>
      </div>
    </form>
  )
}

export default function Water({ oz, target, onAdd }) {
  const level = waterLevel(oz, target)
  const [custom, setCustom] = useState(false)

  return (
    <section className="water">
      <h3 className="panel-head">
        <Droplet size={15} /> Water / liquids
      </h3>

      <div className="water-body">
        <div className={`glass ${level.met ? 'met' : ''}`}>
          {/*
            The fill is a block whose HEIGHT is the level, with the waves riding
            on its top edge — so the surface is always exactly at the waterline
            and the animation never has to know what the level is.
          */}
          <div className="glass-fill" style={{ height: `${level.pct}%` }}>
            <svg className="wave wave-back" viewBox="0 0 200 40" preserveAspectRatio="none" aria-hidden="true">
              <path d={WAVE_D} />
            </svg>
            <svg className="wave wave-front" viewBox="0 0 200 40" preserveAspectRatio="none" aria-hidden="true">
              <path d={WAVE_D} />
            </svg>
          </div>

          <div className="glass-read">
            <strong>{level.oz.toLocaleString()}</strong>
            <span>of {level.target} oz</span>
            <small>{ozToL(level.oz)} L</small>
          </div>
        </div>

        {custom ? (
          <Custom onAdd={onAdd} onClose={() => setCustom(false)} />
        ) : (
          <div className="water-steps">
            {WATER_STEPS.map(step => (
              <button key={step.oz} className="water-btn" onClick={() => onAdd(step.oz)}>
                <b>+{step.oz}</b>
                <small>{step.hint}</small>
              </button>
            ))}
            <button className="water-btn" onClick={() => setCustom(true)}>
              <b><PencilLine size={15} /></b>
              <small>custom</small>
            </button>
          </div>
        )}
      </div>

      <div className="water-foot">
        {/* Undo rather than a delete: the commonest correction is one tap too
            many, and subtracting the same amounts he added is how that is said. */}
        <button className="link sm" onClick={() => onAdd(-Math.min(WATER_NUDGE, level.oz))} disabled={!level.oz}>
          <Minus size={13} /> {WATER_NUDGE} oz
        </button>
        <button className="link sm" onClick={() => onAdd(-level.oz)} disabled={!level.oz}>
          <Undo2 size={13} /> Clear
        </button>
        <button className="link sm" onClick={() => onAdd(WATER_NUDGE)}>
          <Plus size={13} /> {WATER_NUDGE} oz
        </button>
      </div>
    </section>
  )
}
