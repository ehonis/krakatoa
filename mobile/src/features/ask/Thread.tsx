/*
 * Krakatoa — one Ask AI conversation: what he sent, what came back, and the list
 * to review. Ported from app/src/ask.jsx (Thread, Item, Working).
 *
 * The rule of every AI-filled screen in this app holds here: nothing it produced
 * is logged until he taps, every number says where it came from (the basis tag on
 * each row), and anything he changes is his ("You edited").
 *
 * The server works the thread by itself (server/aithreads.js), so this screen
 * only reads it back: every 2 s while it is working, and at once when the app
 * returns to the foreground (AppState here, visibilitychange on the web). His
 * ticks and edits are saved into the thread as he makes them, so leaving and
 * coming back finds his version, not the model's.
 *
 * Native differences: the screen is a push in the add sheet's stack (route param
 * `id`); delete asks with the system alert instead of an inline panel; the
 * skipped list is a tap-to-open row instead of <details>.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, StyleSheet, TextInput, View } from 'react-native'
import { Image } from 'expo-image'
import { router, useLocalSearchParams } from 'expo-router'
import { CenterPane, Pane } from '../../ui/Pane'
import { T } from '../../ui/Text'
import { Btn, Chip, Chips, IconBtn, Input, Press, RowBtns, Spin, useOwnedNumber } from '../../ui/kit'
import { confirm } from '../../ui/menu'
import { success, tap } from '../../ui/haptics'
import { colors, radius, alpha } from '../../theme'
import {
  BookMarked, Check, ChevronDown, CircleAlert, Globe, Minus, Plus, RotateCw, Send, Sparkles, Star, Trash2,
} from '../../lib/icons'
import { MEALS, mealLabel, mealNow, round } from '../../lib/food'
import { componentOf, suggestName } from '../../lib/combos'
import {
  basisLabel, BASIS, itemTotal, previousOf, reviewOf, reviewTotals, ticked, toLog, updateItem, type AskItem, type Review,
} from '../../lib/ask'
import {
  continueThread, deleteThread, getThread, lastAnswer, photoUrl, updateThread, type Thread as ThreadT,
} from '../../lib/askapi'
import { imageSource } from '../../lib/connection'
import { getStore } from '../../lib/store'
import { closeAdd, useFlow } from '../add/flow'

/* ------------------------------------------------------------------ a row */

const PER_FIELDS = [['kcal', 'kcal'], ['protein', 'P'], ['carbs', 'C'], ['fat', 'F']] as const

/*
 * One per-portion number. It owns its text (kit's useOwnedNumber) so "1." is not
 * turned into 1 before the 5 arrives, which a controlled box would do.
 */
function PerBox({ value, label, onChange }: { value: number | undefined; label: string; onChange: (n: number) => void }) {
  const { text, commit, reset } = useOwnedNumber(value ?? 0, onChange, { min: 0, max: 99999 })
  return (
    <View style={{ flex: 1, alignItems: 'center', gap: 2 }}>
      <TextInput
        value={text}
        onChangeText={commit}
        onBlur={reset}
        keyboardType="decimal-pad"
        keyboardAppearance="dark"
        selectionColor={colors.accent}
        selectTextOnFocus
        accessibilityLabel={`${label} per one`}
        style={st.perInput}
      />
      <T size={11} muted>{label}</T>
    </View>
  )
}

function Item({ it, onChange }: { it: AskItem; onChange: (patch: Partial<AskItem>) => void }) {
  const [open, setOpen] = useState(false)
  const t = itemTotal(it)
  const guess = it.edited ? false : BASIS[it.basis || '']?.tone === 'guess'
  const setPer = (k: string, n: number) => onChange({ per: { ...it.per, [k]: Number.isFinite(n) && n >= 0 ? n : 0 } })
  const step = (d: number) => onChange({ qty: Math.max(0.5, round((Number(it.qty) || 1) + d, 2) ?? 1) })

  return (
    <View style={[st.item, it.on ? st.itemOn : st.itemOff]}>
      <View style={st.itemRow}>
        <Press
          onPress={() => { tap(); onChange({ on: !it.on }) }}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: it.on }}
          accessibilityLabel={it.on ? `Leave out ${it.name}` : `Include ${it.name}`}
          hitSlop={8}
          style={[st.check, it.on && st.checkOn]}
        >
          {it.on && <Check size={16} color={colors.onAccent} />}
        </Press>
        <Press onPress={() => setOpen(o => !o)} accessibilityRole="button" accessibilityState={{ expanded: open }} style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T size={15} weight={700} lineHeight={19}>{it.name}</T>
          <View style={st.sub}>
            <T size={12} muted>
              {Number(it.qty) !== 1 && <T size={12} weight={700}>{it.qty} × </T>}{it.portion}
            </T>
            <View style={[st.basis, guess && st.basisGuess]}>
              <T size={10} weight={700} caps color={guess ? colors.ai : colors.basisGood} lineHeight={13}>
                {basisLabel(it)}{guess && it.confidence === 'low' ? ' · rough' : ''}
              </T>
            </View>
          </View>
        </Press>
        <View style={{ alignItems: 'flex-end' }}>
          <T size={17} weight={700} tabular lineHeight={20}>{t.kcal}</T>
          <T size={10} muted lineHeight={12}>kcal</T>
        </View>
      </View>
      {open && (
        <View style={st.more}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <T size={13} muted style={{ marginRight: 'auto' }}>How many</T>
            <IconBtn icon={Minus} sm size={16} label="Fewer" onPress={() => step(-0.5)} />
            <T size={13} weight={700} tabular align="center" style={{ minWidth: 28 }}>{it.qty}</T>
            <IconBtn icon={Plus} sm size={16} label="More" onPress={() => step(0.5)} />
          </View>
          <View style={{ gap: 6 }}>
            <T size={12} muted>Each {it.portion}</T>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              {PER_FIELDS.map(([k, l]) => (
                <PerBox key={k} value={it.per[k]} label={l} onChange={(n) => setPer(k, n)} />
              ))}
            </View>
          </View>
          {(it.components?.length || 0) > 0 && (
            <T size={12} muted lineHeight={17}>{it.components!.map((c: any) => `${c.qty !== 1 ? `${c.qty}× ` : ''}${c.name}`).join(' · ')}</T>
          )}
          {it.note ? <T size={12} muted italic lineHeight={17}>{it.note}</T> : null}
        </View>
      )}
    </View>
  )
}

/* ------------------------------------------------------------ the screen */

const since = (iso?: string) => Math.max(0, Math.round((Date.now() - Date.parse(iso || '')) / 1000)) || 0

function Working({ from, photo }: { from?: string; photo: boolean }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const s = since(from)
  return (
    <View style={st.working}>
      <View style={{ marginTop: 2 }}><Spin size={22} color={colors.ai} /></View>
      <View style={{ flex: 1, gap: 4 }}>
        <T weight={700}>
          {photo ? (s < 12 ? 'Reading the photo' : s < 30 ? 'Matching your foods and the menus' : 'Looking up anything it does not know') : (s < 10 ? 'Reading what you had' : 'Matching your foods and the menus')}… <T muted>{s} s</T>
        </T>
        <T size={12} muted lineHeight={17}>You can leave this screen, or close the app — it keeps going, and it will be here.</T>
      </View>
    </View>
  )
}

function Bubble({ m, last }: { m: any; last: boolean }) {
  if (m.role === 'system') {
    return (
      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center' }}>
        <Globe size={12} color={colors.basisGood} />
        <T size={12} color={colors.basisGood} align="center" style={{ flexShrink: 1 }}>{m.text}</T>
      </View>
    )
  }
  if (m.role === 'you') {
    const src = imageSource(photoUrl(m.photo))
    return (
      <View style={[st.bubble, st.you]}>
        {src && <Image source={src} style={st.bubblePhoto} contentFit="cover" accessibilityLabel="What you sent" />}
        {m.text ? <T size={14} lineHeight={20}>{m.text}</T> : null}
      </View>
    )
  }
  const a = m.answer
  return (
    <View style={[st.bubble, st.ai]}>
      <Sparkles size={14} color={colors.ai} style={{ marginTop: 3 }} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T size={14} lineHeight={20}>{a?.reply}</T>
        {a?.learned?.length > 0 && (
          <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', marginTop: 6 }}>
            <Globe size={12} color={colors.basisGood} />
            <T size={12} color={colors.basisGood} style={{ flexShrink: 1 }}>
              Checked {a.learned.map((l: any) => `${l.items} ${l.chain} item${l.items === 1 ? '' : 's'}`).join(', ')} against their own nutrition page and kept {a.learned.length === 1 && a.learned[0].items === 1 ? 'it' : 'them'} in Krakatoa. Reading the rest of their menu now.
            </T>
          </View>
        )}
        {a?.question && last ? <T size={14} weight={700} lineHeight={20} style={{ marginTop: 4 }}>{a.question}</T> : null}
      </View>
    </View>
  )
}

/* One conversation: what he sent, what came back, and the list to review. */
export default function Thread() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { date } = useFlow()
  const [t, setT] = useState<ThreadT | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [change, setChange] = useState('')
  const [meal, setMeal] = useState(mealNow())
  const [saved, setSaved] = useState<'combo' | 'foods' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [skippedOpen, setSkippedOpen] = useState(false)
  const answer = lastAnswer(t)
  const answerAt: string | null = [...(t?.turns || [])].reverse().find(x => x.role === 'ai')?.at || null

  // Read the thread; again every 2 s while it is working.
  const load = useCallback(async () => {
    try { const d = await getThread(id); setT(d.thread); return d.thread as ThreadT } catch (e: any) { setError(String(e?.message || e)); return null }
  }, [id])
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const loop = async () => {
      const th = await load()
      if (alive && th?.status === 'working') timer = setTimeout(loop, 2000)
    }
    loop()
    // Back in the foreground: read it at once rather than waiting out a timer
    // the OS may have paused.
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') { clearTimeout(timer); loop() } })
    return () => { alive = false; clearTimeout(timer); sub.remove() }
  }, [load, t?.status])

  // The list: his saved draft of THIS answer if there is one, else the answer.
  useEffect(() => {
    if (!answer || !t) { setReview(null); return }
    if (t.draft && t.draft.answerAt === answerAt) {
      setReview({ ...answer, items: t.draft.items })
      if (t.draft.meal) setMeal(t.draft.meal)
    } else {
      setReview(reviewOf(answer))
    }
    setSaved(null)
    // Only when a NEW answer arrives — not on every poll of the same one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answerAt])

  useEffect(() => {
    if (t?.status === 'ready' && !t.seenAt) updateThread(id, { seen: true }).catch(() => {})
  }, [id, t?.status, t?.seenAt])

  // His ticks and edits, saved into the thread a moment after he makes them.
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const edit = (fn: (r: Review) => Review) => {
    setReview(r => {
      if (!r) return r
      const next = fn(r)
      clearTimeout(draftTimer.current)
      draftTimer.current = setTimeout(() => {
        updateThread(id, { draft: { answerAt, items: next.items, meal } }).catch(() => {})
      }, 700)
      return next
    })
    setSaved(null)
  }
  useEffect(() => () => clearTimeout(draftTimer.current), [])

  const revise = async () => {
    const message = change.trim()
    if (!message || !review) return
    setChange('')
    setError(null)
    try {
      const d = await continueThread(id, { message, previous: previousOf(review) })
      setT(d.thread)
    } catch (e: any) { setError(String(e?.message || e)) }
  }

  const retry = async () => {
    setError(null)
    try { setT((await updateThread(id, { retry: true })).thread) } catch (e: any) { setError(String(e?.message || e)) }
  }

  const remove = async () => {
    const ok = await confirm('Delete this conversation and its photo?', { message: 'Anything you logged from it stays logged.', confirmLabel: 'Delete' })
    if (!ok) return
    await deleteThread(id).catch(() => {})
    router.back()
  }

  const totals = useMemo(() => (review ? reviewTotals(review) : null), [review])
  const chosen = review ? ticked(review) : []
  const grocery = review?.kind === 'grocery'
  const working = t?.status === 'working'
  const lastYou = [...(t?.turns || [])].reverse().find(x => x.role === 'you')
  const firstPhoto = t?.turns?.find(x => x.role === 'you')?.photo

  const log = () => {
    if (!review) return
    updateThread(id, { logged: true }).catch(() => {})
    const store = getStore()
    for (const it of chosen) store.logFood({ ...toLog(it, review.place), meal, date })
    success()
    closeAdd()
  }
  const saveCombo = () => {
    if (!review) return
    const components = chosen.map(it => { const l = toLog(it, review.place); return componentOf(l.food, l.portion, l.qty) })
    getStore().saveCombo({ name: review.place && chosen.length > 1 ? `${review.place} usual` : suggestName(components), components })
    success()
    setSaved('combo')
  }
  const keepFoods = () => {
    if (!review) return
    const store = getStore()
    for (const it of chosen) store.starFood(toLog({ ...it, qty: 1 }, review.place).food)
    success()
    setSaved('foods')
  }

  if (!t) {
    return (
      <CenterPane>
        <Spin size={28} />
        {error && <T muted align="center">{error}</T>}
      </CenterPane>
    )
  }

  const foot = review && totals ? (
    <>
      <View style={st.total}>
        <T size={28} weight={700} tabular lineHeight={30}>{totals.kcal.toLocaleString()}</T>
        <T size={13} muted>kcal</T>
        <T size={13} muted style={{ marginLeft: 'auto' }}>
          <T size={13} weight={700} tabular>{Math.round(totals.protein)}</T>P · <T size={13} weight={700} tabular>{Math.round(totals.carbs)}</T>C · <T size={13} weight={700} tabular>{Math.round(totals.fat)}</T>F
        </T>
        {t.loggedAt ? (
          <T size={11} muted style={{ flexBasis: '100%' }}>
            Logged {new Date(t.loggedAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })} — logging again adds it again
          </T>
        ) : null}
      </View>
      <Chips style={{ justifyContent: 'center' }}>
        {MEALS.map(m => <Chip key={m.id} label={m.label} on={meal === m.id} onPress={() => setMeal(m.id)} />)}
      </Chips>
      <RowBtns>
        {grocery ? (
          <Btn flex icon={saved === 'foods' ? Check : Star} title={saved === 'foods' ? 'Kept' : 'Keep as my foods'} disabled={!chosen.length || saved === 'foods'} onPress={keepFoods} />
        ) : (
          <Btn flex icon={saved === 'combo' ? Check : BookMarked} title={saved === 'combo' ? 'Saved' : 'Save combo'} disabled={!chosen.length || saved === 'combo'} onPress={saveCombo} />
        )}
        <Btn flex kind="primary" disabled={!chosen.length || working} onPress={log}
          title={chosen.length ? `Log ${chosen.length} to ${mealLabel(meal)}` : 'Tick what you had'} />
      </RowBtns>
    </>
  ) : undefined

  const canChange = !working && !!review
  return (
    <Pane
      title={review?.place || t.title || (grocery ? 'Groceries' : 'Ask AI')}
      onBack={() => router.back()}
      right={<IconBtn icon={Trash2} size={18} label="Delete this conversation" onPress={remove} />}
      foot={foot}
    >
      <View style={{ gap: 8 }}>
        {t.turns.map((m, i) => <Bubble key={i} m={m} last={i === t.turns.length - 1} />)}
        {working && <Working from={lastYou?.at} photo={!!firstPhoto && t.turns.filter(x => x.role === 'ai').length === 0} />}
        {t.status === 'error' && (
          <View style={st.confirm}>
            <View style={{ flexDirection: 'row', gap: 6, alignItems: 'flex-start' }}>
              <CircleAlert size={14} color={colors.text} style={{ marginTop: 3 }} />
              <T size={13} style={{ flex: 1 }}>{t.error}</T>
            </View>
            <Btn icon={RotateCw} title="Try again" onPress={retry} />
          </View>
        )}
      </View>

      {review && (
        <>
          {grocery && (
            <T size={12} muted lineHeight={19}>A grocery receipt is what you bought, not what you ate — tick what you ate to log it, or keep them as your foods for later.</T>
          )}
          <View style={[{ gap: 8 }, working && { opacity: 0.5 }]} pointerEvents={working ? 'none' : 'auto'}>
            {review.items.map(it => (
              <Item key={it.key} it={it} onChange={(patch) => edit(r => updateItem(r, it.key, patch))} />
            ))}
          </View>
          {(review.skipped?.length || 0) > 0 && (
            <View>
              <Press onPress={() => setSkippedOpen(o => !o)} accessibilityRole="button" accessibilityState={{ expanded: skippedOpen }} style={st.summary}>
                <T size={13} muted style={{ flexShrink: 1 }}>
                  Left out {review.skipped!.length}: {review.skipped!.slice(0, 3).join(', ')}{review.skipped!.length > 3 ? '…' : ''}
                </T>
                <ChevronDown size={14} color={colors.muted} style={skippedOpen ? { transform: [{ rotate: '180deg' }] } : undefined} />
              </Press>
              {skippedOpen && <T size={13} muted style={{ marginBottom: 4 }}>{review.skipped!.join(' · ')}</T>}
            </View>
          )}
        </>
      )}

      {(review || t.status !== 'working') && (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Input
            value={change}
            onChangeText={setChange}
            editable={canChange}
            returnKeyType="send"
            onSubmitEditing={() => { void revise() }}
            placeholder={review?.question ? 'Answer it, or tell it what to change' : 'Tell it what to change — "I only had half the fries"'}
            boxStyle={{ flex: 1, minWidth: 0 }}
          />
          <IconBtn icon={Send} size={18} label="Send" disabled={!change.trim() || !canChange} onPress={() => { void revise() }} />
        </View>
      )}
      {error && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
          <CircleAlert size={14} color={colors.errorText} />
          <T size={13} color={colors.errorText} style={{ flexShrink: 1 }}>{error}</T>
        </View>
      )}
    </Pane>
  )
}

const st = StyleSheet.create({
  item: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.r, backgroundColor: colors.panel },
  itemOn: { borderColor: alpha(colors.accent, 0.5) },
  itemOff: { opacity: 0.6 },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingLeft: 10, paddingRight: 12, minHeight: 58 },
  check: { width: 28, height: 28, borderRadius: 8, borderWidth: 2, borderColor: colors.muted, alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  sub: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 4 },
  basis: { paddingVertical: 2, paddingHorizontal: 6, borderRadius: 6, backgroundColor: 'rgba(52, 211, 153, 0.12)' },
  basisGuess: { backgroundColor: alpha(colors.aiLine, 0.14) },
  more: { borderTopWidth: 1, borderTopColor: colors.line, paddingVertical: 10, paddingHorizontal: 12, gap: 10 },
  perInput: {
    alignSelf: 'stretch', minHeight: 36, paddingVertical: 6, paddingHorizontal: 4, textAlign: 'center',
    color: colors.text, fontSize: 16, fontVariant: ['tabular-nums'],
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: radius.r,
  },
  working: {
    flexDirection: 'row', gap: 12, alignItems: 'flex-start', padding: 12, borderRadius: radius.r,
    borderWidth: 1, borderStyle: 'dashed', borderColor: alpha(colors.aiLine, 0.5), backgroundColor: alpha(colors.aiLine, 0.06),
  },
  bubble: { paddingVertical: 10, paddingHorizontal: 12, borderRadius: radius.r, borderWidth: 1 },
  ai: { flexDirection: 'row', gap: 8, backgroundColor: alpha(colors.aiLine, 0.1), borderColor: alpha(colors.aiLine, 0.3) },
  you: { alignSelf: 'flex-end', alignItems: 'flex-end', gap: 8, maxWidth: '85%', backgroundColor: colors.panel2, borderColor: colors.line },
  bubblePhoto: { width: 160, height: 200, borderRadius: 10 },
  confirm: { gap: 8, padding: 12, borderRadius: radius.r, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.panel },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36 },
  total: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 8, rowGap: 4 },
})
