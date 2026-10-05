/*
 * Krakatoa — Ask AI. A receipt, a photo of the food, or just words, and a list to
 * review before anything is logged.
 *
 * Three screens: ASK (a photo and/or a sentence), WORKING (it takes 15–60 s, so the
 * screen says what it is doing), and REVIEW, where the rule of every other
 * AI-filled screen in this app holds: nothing it produced is logged until he
 * taps, every number says where it came from, and anything he changes is his.
 *
 * IN THE BACKGROUND. A run used to live inside the phone's request, so backing
 * out of the app mid-run killed it. Every run is now a THREAD the server works through by itself (server/aithreads.js). This screen
 * starts one and reads it back; he can leave the moment he taps Send, and the
 * answer is waiting in the list — and on Today — when he comes back. His ticks
 * and edits are saved into the thread as he makes them.
 *
 * What makes it trustworthy, in practice:
 *  - EXACT WHERE KRAKATOA KNOWS. His combos, the chain menus and the basics are
 *    matched and computed by the server; the model only guesses what nobody
 *    publishes, and those rows say "AI estimate" on them.
 *  - A CONVERSATION, NOT A VENDING MACHINE. "I only had half the fries" or
 *    "the burrito was steak" revises the list in place, keeping his ticks and
 *    his edits (the same lesson Bushido's planner learned).
 *  - THE RIGHT ENDING. A restaurant receipt logs; a grocery receipt is things
 *    bought, not eaten, so it arrives unticked and offers to keep them as his
 *    foods; any list can be saved as a combo for next time.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft, ChevronRight, Camera, Loader2, Sparkles, CircleAlert, X, Check, Minus, Plus, Send, BookMarked, Star, ScanText,
  ChevronDown, Trash2, RotateCw, Globe,
} from 'lucide-react'
import { shrink } from './lib/photo.js'
import { openSettings, useServerInfo } from './lib/server.js'
import { MEALS, mealLabel, mealNow, round } from './lib/food.js'
import { componentOf, suggestName } from './lib/combos.js'
import {
  basisLabel, BASIS, itemTotal, previousOf, reviewOf, reviewTotals, ticked, toLog, updateItem,
} from './lib/ask.js'
import {
  continueThread, deleteThread, getThread, lastAnswer, photoUrl, startThread, updateThread, useThreads,
} from './lib/askapi.js'

const EXAMPLES = [
  '3 carne asada tacos and a large horchata from the taqueria',
  'my protein shake and a glazed donut',
  'a slice of pepperoni pizza and a can of Coke',
]

/* ------------------------------------------------------------------ a row */

function Item({ it, onChange }) {
  const [open, setOpen] = useState(false)
  const t = itemTotal(it)
  const guess = it.edited ? false : BASIS[it.basis]?.tone === 'guess'
  const setPer = (k, v) => {
    const n = Number(String(v).replace(',', '.'))
    onChange({ per: { ...it.per, [k]: Number.isFinite(n) && n >= 0 ? n : 0 } })
  }
  const step = (d) => onChange({ qty: Math.max(0.5, round((Number(it.qty) || 1) + d, 2)) })

  return (
    <div className={`ask-item ${it.on ? 'on' : 'off'}`}>
      <div className="ask-item-row">
        <button className="ask-check" onClick={() => onChange({ on: !it.on })} aria-label={it.on ? `Leave out ${it.name}` : `Include ${it.name}`} aria-pressed={it.on}>
          {it.on && <Check size={16} />}
        </button>
        <button className="ask-item-main" onClick={() => setOpen(o => !o)} aria-expanded={open}>
          <span className="ask-name">{it.name}</span>
          <span className="ask-sub">
            {Number(it.qty) !== 1 && <b>{it.qty} × </b>}{it.portion}
            <span className={`ask-basis ${guess ? 'guess' : ''}`}>{basisLabel(it)}{guess && it.confidence === 'low' ? ' · rough' : ''}</span>
          </span>
        </button>
        <span className="ask-kcal"><b>{t.kcal}</b><small>kcal</small></span>
      </div>
      {open && (
        <div className="ask-item-more">
          <div className="ask-qty">
            <span>How many</span>
            <button className="icon-btn sm" onClick={() => step(-0.5)} aria-label="Fewer"><Minus size={16} /></button>
            <b>{it.qty}</b>
            <button className="icon-btn sm" onClick={() => step(0.5)} aria-label="More"><Plus size={16} /></button>
          </div>
          <div className="ask-per">
            <small>Each {it.portion}</small>
            {[['kcal', 'kcal'], ['protein', 'P'], ['carbs', 'C'], ['fat', 'F']].map(([k, l]) => (
              <label key={k}>
                <input className="text-input" inputMode="decimal" value={String(it.per[k] ?? '')}
                  onChange={e => setPer(k, e.target.value.replace(/[^\d.,]/g, ''))} aria-label={`${l} per one`} />
                <small>{l}</small>
              </label>
            ))}
          </div>
          {it.components?.length > 0 && (
            <p className="ask-parts">{it.components.map(c => `${c.qty !== 1 ? `${c.qty}× ` : ''}${c.name}`).join(' · ')}</p>
          )}
          {it.note && <p className="ask-note">{it.note}</p>}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------ the screen */

const since = (iso) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))

function Working({ from, photo }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const s = since(from)
  return (
    <div className="ask-working-card">
      <Loader2 className="spin" size={22} />
      <div>
        <strong>{photo ? (s < 12 ? 'Reading the photo' : s < 30 ? 'Matching your foods and the menus' : 'Looking up anything it does not know') : (s < 10 ? 'Reading what you had' : 'Matching your foods and the menus')}… <span className="muted">{s} s</span></strong>
        <small>You can leave this screen, or close the app — it keeps going, and it will be here.</small>
      </div>
    </div>
  )
}

/* One conversation: what he sent, what came back, and the list to review. */
function Thread({ id, initial, date, onBack, onLogMany, onSaveCombo, onStar }) {
  const [t, setT] = useState(initial || null)
  const [review, setReview] = useState(null)
  const [change, setChange] = useState('')
  const [meal, setMeal] = useState(mealNow())
  const [saved, setSaved] = useState(null)
  const [error, setError] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const answer = lastAnswer(t)
  const answerAt = [...(t?.turns || [])].reverse().find(x => x.role === 'ai')?.at || null

  // Read the thread; again every 2 s while it is working.
  const load = useCallback(async () => {
    try { const d = await getThread(id); setT(d.thread); return d.thread } catch (e) { setError(String(e.message || e)); return null }
  }, [id])
  useEffect(() => {
    let alive = true
    let timer
    const loop = async () => {
      const th = await load()
      if (alive && th?.status === 'working') timer = setTimeout(loop, 2000)
    }
    loop()
    const wake = () => { if (document.visibilityState === 'visible') { clearTimeout(timer); loop() } }
    document.addEventListener('visibilitychange', wake)
    return () => { alive = false; clearTimeout(timer); document.removeEventListener('visibilitychange', wake) }
  }, [load, t?.status])

  // The list: his saved draft of THIS answer if there is one, else the answer.
  useEffect(() => {
    if (!answer) { setReview(null); return }
    if (t.draft && t.draft.answerAt === answerAt) {
      setReview({ ...answer, items: t.draft.items })
      if (t.draft.meal) setMeal(t.draft.meal)
    } else {
      setReview(reviewOf(answer))
    }
    setSaved(null)
    // Only when a NEW answer arrives — not on every poll of the same one.
  }, [answerAt])

  useEffect(() => {
    if (t?.status === 'ready' && !t.seenAt) updateThread(id, { seen: true }).catch(() => {})
  }, [id, t?.status, t?.seenAt])

  // His ticks and edits, saved into the thread a moment after he makes them.
  const draftTimer = useRef(null)
  const edit = (fn) => {
    setReview(r => {
      const next = fn(r)
      clearTimeout(draftTimer.current)
      draftTimer.current = setTimeout(() => {
        updateThread(id, { draft: { answerAt, items: next.items, meal } }).catch(() => {})
      }, 700)
      return next
    })
    setSaved(null)
  }

  const revise = async () => {
    const message = change.trim()
    if (!message || !review) return
    setChange('')
    setError(null)
    try {
      const d = await continueThread(id, { message, previous: previousOf(review) })
      setT(d.thread)
    } catch (e) { setError(String(e.message || e)) }
  }

  const totals = useMemo(() => (review ? reviewTotals(review) : null), [review])
  const chosen = review ? ticked(review) : []
  const grocery = review?.kind === 'grocery'
  const working = t?.status === 'working'
  const lastYou = [...(t?.turns || [])].reverse().find(x => x.role === 'you')
  const firstPhoto = t?.turns?.find(x => x.role === 'you')?.photo

  const log = () => {
    updateThread(id, { logged: true }).catch(() => {})
    onLogMany(chosen.map(it => ({ ...toLog(it, review.place), meal, date })))
  }
  const saveCombo = () => {
    const components = chosen.map(it => { const l = toLog(it, review.place); return componentOf(l.food, l.portion, l.qty) })
    onSaveCombo({ name: review.place && chosen.length > 1 ? `${review.place} usual` : suggestName(components), components })
    setSaved('combo')
  }
  const keepFoods = () => {
    for (const it of chosen) onStar(toLog({ ...it, qty: 1 }, review.place).food, true)
    setSaved('foods')
  }

  if (!t) {
    return (
      <div className="pane pane-center"><Loader2 className="spin" size={28} />{error && <p className="muted">{error}</p>}</div>
    )
  }

  return (
    <div className="pane">
      <header className="pane-head">
        <button className="icon-btn" onClick={onBack} aria-label="Back"><ChevronLeft size={24} /></button>
        <h2>{review?.place || t.title || (grocery ? 'Groceries' : 'Ask AI')}</h2>
        <button className="icon-btn ask-delete" onClick={() => setConfirmDelete(c => !c)} aria-label="Delete this conversation"><Trash2 size={18} /></button>
      </header>
      <div className="pane-body">
        {confirmDelete && (
          <div className="ask-confirm">
            <span>Delete this conversation and its photo? Anything you logged from it stays logged.</span>
            <div className="row-btns">
              <button className="btn" onClick={() => setConfirmDelete(false)}>Keep it</button>
              <button className="btn btn-danger" onClick={async () => { await deleteThread(id).catch(() => {}); onBack() }}>Delete</button>
            </div>
          </div>
        )}

        <div className="ask-thread">
          {t.turns.map((m, i) => (
            m.role === 'system' ? (
              <p key={i} className="ask-system"><Globe size={12} /> {m.text}</p>
            ) : m.role === 'you' ? (
              <div key={i} className="ask-bubble you">
                {m.photo && <img className="ask-bubble-photo" src={photoUrl(m.photo)} alt="What you sent" />}
                {m.text && <span>{m.text}</span>}
              </div>
            ) : (
              <p key={i} className="ask-bubble ai">
                <Sparkles size={14} />
                <span>
                  {m.answer?.reply}
                  {m.answer?.learned?.length > 0 && (
                    <span className="ask-learned"><Globe size={12} /> Checked {m.answer.learned.map(l => `${l.items} ${l.chain} item${l.items === 1 ? '' : 's'}`).join(', ')} against their own nutrition page and kept {m.answer.learned.length === 1 && m.answer.learned[0].items === 1 ? 'it' : 'them'} in Krakatoa. Reading the rest of their menu now.</span>
                  )}
                  {m.answer?.question && i === t.turns.length - 1 && <b className="ask-question"> {m.answer.question}</b>}
                </span>
              </p>
            )
          ))}
          {working && <Working from={lastYou?.at} photo={!!firstPhoto && t.turns.filter(x => x.role === 'ai').length === 0} />}
          {t.status === 'error' && (
            <div className="ask-confirm">
              <span><CircleAlert size={14} /> {t.error}</span>
              <button className="btn" onClick={async () => setT((await updateThread(id, { retry: true })).thread)}><RotateCw size={16} /> Try again</button>
            </div>
          )}
        </div>

        {review && (
          <>
            {grocery && (
              <p className="muted small-note">A grocery receipt is what you bought, not what you ate — tick what you ate to log it, or keep them as your foods for later.</p>
            )}
            <section className={`ask-list ${working ? 'stale' : ''}`}>
              {review.items.map(it => (
                <Item key={it.key} it={it} onChange={(patch) => edit(r => updateItem(r, it.key, patch))} />
              ))}
            </section>
            {review.skipped?.length > 0 && (
              <details className="ask-skipped">
                <summary>Left out {review.skipped.length}: {review.skipped.slice(0, 3).join(', ')}{review.skipped.length > 3 ? '…' : ''} <ChevronDown size={14} /></summary>
                <p>{review.skipped.join(' · ')}</p>
              </details>
            )}
          </>
        )}

        {(review || t.status !== 'working') && (
          <form className="ask-change" onSubmit={(e) => { e.preventDefault(); revise() }}>
            <input className="text-input" value={change} onChange={e => setChange(e.target.value)} disabled={working || !review}
              placeholder={review?.question ? 'Answer it, or tell it what to change' : 'Tell it what to change — "I only had half the fries"'} />
            <button className="icon-btn" type="submit" disabled={!change.trim() || working || !review} aria-label="Send"><Send size={18} /></button>
          </form>
        )}
        {error && <p className="lbl-error"><CircleAlert size={14} /> {error}</p>}
      </div>

      {review && (
        <footer className="pane-foot ask-foot">
          <div className="bowl-total">
            <strong>{totals.kcal.toLocaleString()}</strong><span>kcal</span>
            <em><b>{Math.round(totals.protein)}</b>P · <b>{Math.round(totals.carbs)}</b>C · <b>{Math.round(totals.fat)}</b>F</em>
            {t.loggedAt && <small>Logged {new Date(t.loggedAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })} — logging again adds it again</small>}
          </div>
          <div className="chips ask-meals" role="radiogroup" aria-label="Meal">
            {MEALS.map(m => (
              <button key={m.id} role="radio" aria-checked={meal === m.id} className={`chip ${meal === m.id ? 'on' : ''}`} onClick={() => setMeal(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
          <div className="row-btns">
            {grocery ? (
              <button className="btn" disabled={!chosen.length || saved === 'foods'} onClick={keepFoods}>
                {saved === 'foods' ? <><Check size={16} /> Kept</> : <><Star size={16} /> Keep as my foods</>}
              </button>
            ) : (
              <button className="btn" disabled={!chosen.length || saved === 'combo'} onClick={saveCombo}>
                {saved === 'combo' ? <><Check size={16} /> Saved</> : <><BookMarked size={16} /> Save combo</>}
              </button>
            )}
            <button className="btn btn-primary" disabled={!chosen.length || working} onClick={log}>
              {chosen.length ? `Log ${chosen.length} to ${mealLabel(meal)}` : 'Tick what you had'}
            </button>
          </div>
        </footer>
      )}
    </div>
  )
}

function statusLine(s) {
  if (s.status === 'working') return <><Loader2 className="spin" size={12} /> Working…</>
  if (s.status === 'error') return <><CircleAlert size={12} /> Did not finish — open to try again</>
  const what = s.items ? `${s.items} item${s.items === 1 ? '' : 's'} · ${s.kcal.toLocaleString()} kcal` : 'Nothing found'
  return s.loggedAt ? <>Logged · {what}</> : <>{!s.seenAt && <span className="ask-dot" />}{what}</>
}

const when = (iso) => {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

/* Ask AI: something new at the top, every earlier conversation below it. */
export default function AskAI({ date, openThreadId = null, onBack, onLogMany, onSaveCombo, onStar, onLabel }) {
  const [open, setOpen] = useState(openThreadId ? { id: openThreadId } : null)
  const [text, setText] = useState('')
  const [photo, setPhoto] = useState(null)
  const [error, setError] = useState(null)
  const [sending, setSending] = useState(false)
  const fileRef = useRef(null)
  const { threads, refresh } = useThreads({ enabled: !open })
  const info = useServerInfo()
  // Known to be off, not merely unknown: offline, the compose box still shows.
  const aiOff = info?.features && !info.features.ai

  const onPhoto = async (file) => {
    if (!file) return
    setError(null)
    try { setPhoto(await shrink(file)) } catch (e) { setError(String(e.message || e)) } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const send = async () => {
    setSending(true)
    setError(null)
    try {
      const d = await startThread({ text: text.trim(), image: photo?.dataUrl || null })
      setText('')
      setPhoto(null)
      setOpen({ id: d.thread.id, initial: d.thread })
    } catch (e) {
      setError(String(e.message || e))
    } finally {
      setSending(false)
    }
  }

  if (open) {
    return (
      <Thread
        key={open.id}
        id={open.id}
        initial={open.initial}
        date={date}
        onBack={() => { setOpen(null); refresh() }}
        onLogMany={onLogMany}
        onSaveCombo={onSaveCombo}
        onStar={onStar}
      />
    )
  }

  const ready = text.trim() || photo
  return (
    <div className="pane">
      <header className="pane-head">
        <button className="icon-btn" onClick={onBack} aria-label="Back"><ChevronLeft size={24} /></button>
        <h2>Ask AI</h2>
      </header>
      <div className="pane-body">
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={e => onPhoto(e.target.files?.[0])} />
        {aiOff ? (
          <section className="ai-setup">
            <p><strong>AI is not set up on this server yet.</strong> Ask AI reads a receipt, a plate or a sentence with the Claude Code CLI running on the server.</p>
            <button className="btn btn-primary" onClick={() => openSettings('ai')}><Sparkles size={16} /> Set up AI in Settings</button>
          </section>
        ) : (
        <section className="ask-compose">
          {photo ? (
            <div className="ask-photo">
              <img src={photo.preview} alt="Your photo" />
              <button className="icon-btn ask-photo-x" onClick={() => setPhoto(null)} aria-label="Remove the photo"><X size={18} /></button>
            </div>
          ) : (
            <button className="big-action" onClick={() => fileRef.current?.click()}>
              <Camera size={26} />
              <span>
                <strong>Add a photo</strong>
                <small>A receipt, your plate, or a menu</small>
              </span>
            </button>
          )}
          <textarea id="ask-text" className="text-input ask-text" rows={2} value={text}
            onChange={e => setText(e.target.value)}
            placeholder={photo ? 'Anything to add — "I only had the burrito"' : `Or say what you had — "${EXAMPLES[0]}"`} />
          {!photo && !text && (
            <div className="chips">
              {EXAMPLES.slice(1).map(x => <button key={x} className="chip" onClick={() => setText(x)}>{x}</button>)}
            </div>
          )}
          {error && <p className="lbl-error"><CircleAlert size={14} /> {error}</p>}
          <button className="btn btn-primary" disabled={!ready || sending} onClick={send}>
            {sending ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />} Send
          </button>
          <p className="muted small-note">
            It works in the background — send it and go. Your combos, the chain menus and USDA foods are matched exactly; anything else is an estimate and says so; nothing is logged until you check it.
          </p>
        </section>
        )}

        {threads.length > 0 && (
          <section className="list">
            <h3 className="list-head"><Sparkles size={16} /> Earlier</h3>
            {threads.map(s => (
              <button key={s.id} className={`food-row ask-row ${s.status}`} onClick={() => setOpen({ id: s.id })}>
                {s.photo ? <img className="ask-row-photo" src={photoUrl(s.photo)} alt="" /> : <span className="ask-row-icon"><Sparkles size={18} /></span>}
                <span className="ask-row-main">
                  <b>{s.title}</b>
                  <small>{statusLine(s)}</small>
                </span>
                <span className="ask-row-when">{when(s.updatedAt)}<ChevronRight size={16} /></span>
              </button>
            ))}
          </section>
        )}

        <button className="link ask-label-link" onClick={onLabel}><ScanText size={14} /> A nutrition label? The label form saves it with every number</button>
      </div>
    </div>
  )
}
