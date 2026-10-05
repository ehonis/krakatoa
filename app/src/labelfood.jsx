/*
 * Krakatoa — build a food from its Nutrition Facts label.
 *
 * Two ways to enter what the back of the package says, on one screen:
 * the form is laid out the way the label is, and the camera button above it
 * fills the form from a photo. The photo only ever FILLS the boxes — it never
 * saves or logs anything — because a number read off a photo is a number to
 * check, and the boxes are where he checks it.
 *
 * Saving keeps the food: it is starred, so it is one tap away from then on, and
 * when he got here from a barcode that missed, it is remembered under that
 * barcode, so the next scan finds it. Then it goes to the ordinary detail
 * screen to be logged, like anything else.
 */

import { useMemo, useRef, useState } from 'react'
import { ChevronLeft, Camera, Loader2, Sparkles, CircleAlert, RotateCw } from 'lucide-react'
import { LABEL_FIELDS, checkLabel, emptyLabel, fromReading, labelFood, labelReady, numbersOf } from './lib/label.js'
import { shrink } from './lib/photo.js'
import { openSettings, useServerInfo } from './lib/server.js'

const clean = (v, decimal = true) => v.replace(decimal ? /[^\d.,]/g : /[^\d]/g, '')

function Row({ field, value, onChange, filled }) {
  return (
    <label className={`lbl-row ${field.big ? 'big' : ''} ${field.indent ? 'indent' : ''} ${filled ? 'filled' : ''}`}>
      <span className="lbl-name">{field.label}</span>
      <span className="lbl-input">
        <input
          className="text-input"
          inputMode="decimal"
          value={value}
          onChange={e => onChange(clean(e.target.value))}
          placeholder="–"
          aria-label={field.label}
        />
        {field.unit && <small>{field.unit}</small>}
      </span>
    </label>
  )
}

export default function LabelFood({ gtin = null, initialName = '', onBack, onSave }) {
  const info = useServerInfo()
  const aiOff = info?.features && !info.features.ai
  const [form, setForm] = useState(() => emptyLabel({ name: initialName }))
  const [read, setRead] = useState({ status: 'idle' }) // idle | reading | done | error
  const [filled, setFilled] = useState(() => new Set())
  const fileRef = useRef(null)

  const set = (key) => (v) => {
    setForm(f => ({ ...f, [key]: v }))
    // A box he has typed in is his, not the photo's.
    setFilled(s => { if (!s.has(key)) return s; const n = new Set(s); n.delete(key); return n })
  }
  const warnings = useMemo(() => checkLabel(numbersOf(form)), [form])
  const ready = labelReady(form)

  const onPhoto = async (file) => {
    if (!file) return
    setRead({ status: 'reading' })
    try {
      const { blob, preview } = await shrink(file)
      setRead({ status: 'reading', preview })
      const res = await fetch('/api/label', { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: blob })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `The label reader answered ${res.status}.`)
      if (!body.label?.isLabel) {
        setRead({ status: 'error', preview, error: 'That does not look like a nutrition label. Try again closer, straight on, with the whole panel in the frame.' })
        return
      }
      setForm(f => fromReading(body.label, f))
      setFilled(new Set(Object.entries(body.label).filter(([k, v]) => v != null && k in form && k !== 'name').map(([k]) => k)))
      setRead({ status: 'done', preview, notes: body.label.notes, model: body.model, ms: body.ms })
    } catch (e) {
      setRead(r => ({ status: 'error', preview: r.preview, error: String(e.message || e) }))
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="pane">
      <header className="pane-head">
        <button className="icon-btn" onClick={onBack} aria-label="Back"><ChevronLeft size={24} /></button>
        <h2>From the label</h2>
      </header>
      <div className="pane-body">
        {/* No `capture` attribute: on a phone that offers the camera AND the
            photo library, and the label he photographed in the shop is in the
            library. */}
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={e => onPhoto(e.target.files?.[0])} />
        {aiOff ? (
          <section className="ai-setup">
            <p><strong>Reading a label from a photo needs AI</strong>, which is not set up on this server yet. The form below works without it.</p>
            <button className="btn" onClick={() => openSettings('ai')}><Sparkles size={16} /> Set up AI in Settings</button>
          </section>
        ) : (
        <button
          className="big-action"
          disabled={read.status === 'reading'}
          onClick={() => fileRef.current?.click()}
        >
          {read.status === 'reading' ? <Loader2 className="spin" size={26} /> : <Camera size={26} />}
          <span>
            <strong>{read.status === 'reading' ? 'Reading the label…' : read.status === 'idle' ? 'Photograph the label' : 'Photograph it again'}</strong>
            <small>{read.status === 'reading' ? 'About ten seconds' : 'The numbers fill in below. You check them.'}</small>
          </span>
        </button>
        )}

        {read.preview && (
          <div className="lbl-read">
            <img src={read.preview} alt="The label you photographed" />
            <div>
              {read.status === 'done' && (
                <p className="filled-note">
                  <Sparkles size={14} />
                  <span>
                    Read from your photo — <b>check each number against the label</b>.
                    {read.notes && <> {read.notes}</>}
                  </span>
                </p>
              )}
              {read.status === 'error' && (
                <p className="lbl-error">
                  <CircleAlert size={14} /> {read.error}
                  <button className="link" onClick={() => fileRef.current?.click()}><RotateCw size={12} /> Try again</button>
                </p>
              )}
            </div>
          </div>
        )}

        <section className="field">
          <label htmlFor="lf-name">What is it</label>
          <input id="lf-name" className="text-input" value={form.name}
            onChange={e => set('name')(e.target.value)} placeholder="Peanut butter protein bar" />
          <input className="text-input" value={form.brand} aria-label="Brand"
            onChange={e => set('brand')(e.target.value)} placeholder="Brand (optional)" />
        </section>

        <section className="lbl">
          <div className="lbl-title">Nutrition Facts</div>
          <label className={`lbl-row thin ${filled.has('servingsPerContainer') ? 'filled' : ''}`}>
            <span className="lbl-name">Servings per container</span>
            <span className="lbl-input">
              <input className="text-input" inputMode="decimal" value={form.servingsPerContainer} placeholder="–"
                onChange={e => set('servingsPerContainer')(clean(e.target.value))} aria-label="Servings per container" />
            </span>
          </label>
          <div className={`lbl-row serving ${filled.has('servingLabel') || filled.has('servingGrams') ? 'filled' : ''}`}>
            <span className="lbl-name">Serving size</span>
            <span className="lbl-serving">
              <input className="text-input" value={form.servingLabel} placeholder="2/3 cup"
                onChange={e => set('servingLabel')(e.target.value)} aria-label="Serving size" />
              <span className="lbl-input">
                <input className="text-input" inputMode="decimal" value={form.servingGrams} placeholder="–"
                  onChange={e => set('servingGrams')(clean(e.target.value))} aria-label="Serving size in grams" />
                <small>g</small>
              </span>
            </span>
          </div>
          <div className="lbl-per">Amount per serving</div>
          {LABEL_FIELDS.map(f => (
            <Row key={f.key} field={f} value={form[f.key]} onChange={set(f.key)} filled={filled.has(f.key)} />
          ))}
        </section>

        {warnings.length > 0 && (
          <ul className="lbl-warn">
            {warnings.map(w => <li key={w}><CircleAlert size={14} /> {w}</li>)}
          </ul>
        )}
        {gtin && <p className="muted small-note">Saved under barcode {gtin}, so scanning it next time finds this.</p>}
      </div>
      <footer className="pane-foot">
        <button className="btn btn-primary" disabled={!ready} onClick={() => onSave(labelFood(form, { gtin }))}>
          {ready ? 'Save and log it' : form.name.trim() ? 'Calories are needed' : 'Name it first'}
        </button>
      </footer>
    </div>
  )
}
