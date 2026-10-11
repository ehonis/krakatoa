/*
 * Krakatoa — one food, and every time he has had it. Ported from
 * app/src/foodview.jsx, plus the glue App.jsx wraps around it (which entry,
 * which history, what each button writes), since here it is its own page sheet.
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

import React, { useMemo, useRef, useState } from 'react'
import { View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { Pane } from '../../ui/Pane'
import { T } from '../../ui/Text'
import Thumb from '../../ui/Thumb'
import { Btn, Chip, Chips, Field, ListHead, Panel, Press, RowNote, StepBtn } from '../../ui/kit'
import { confirm } from '../../ui/menu'
import { alpha, colors, radius, TAP } from '../../theme'
import { CalendarDays, CircleCheck, Minus, Plus, Trash2, Utensils } from '../../lib/icons'
import {
  MEALS, amountFor, dayLabel, foodKey, isoDate, mealLabel, portionLabel, shiftDate, titleOf,
} from '../../lib/food'
import { useStore } from '../../lib/store'
import type { Food, Item, Portion } from '../../lib/types'
import { openAdd } from '../add/flow'
import { getDay, setDay } from '../today/day'

/** "3 times this week · 27 in all". What a history is actually worth saying. */
function statsFor(history: Item[], today: string) {
  if (!history.length) return null
  const weekAgo = shiftDate(today, -6)
  const thisWeek = history.filter(h => String(h.date) >= weekAgo).length
  const kcal = history.reduce((n, h) => n + (Number(h.kcal) || 0), 0)
  return {
    times: history.length,
    thisWeek,
    last: history[0]?.date,
    avgKcal: Math.round(kcal / history.length),
  }
}

/* --------------------------------------------------------- the edit panel */

function EntryEditor({ entry, portions, onEdit, onMove, onRemove }: {
  entry: Item
  portions: Portion[]
  onEdit: (patch: Record<string, any>) => void
  onMove: (to: string) => void
  onRemove: () => void
}) {
  const today = isoDate()
  const date = String(entry.date)

  // Derived from the entry every render, never copied into state — see the
  // header of lib/store.ts on why that rule exists.
  const portion = entry.portion
  const amount = amountFor(portion, entry.qty)

  // The web swaps this panel for an inline "Remove …?" panel; the phone asks
  // with the system alert, which is where a destructive confirm lives on iOS.
  const askRemove = async () => {
    const ok = await confirm(`Remove ${titleOf(entry)} from ${dayLabel(date, today)}?`, { confirmLabel: 'Remove', cancelLabel: 'Keep it' })
    if (ok) onRemove()
  }

  return (
    <Panel>
      <ListHead icon={CircleCheck} title={`This one — ${dayLabel(date, today)}`} />

      {/* The mis-click fix, first, because it is the reason this screen exists. */}
      <Field label="Meal">
        <Chips>
          {MEALS.map(m => (
            <Chip key={m.id} label={m.label} on={m.id === entry.meal} onPress={() => onEdit({ meal: m.id })} />
          ))}
        </Chips>
      </Field>

      {portions.length > 1 && (
        <Field label="Serving">
          <Chips>
            {portions.map(p => (
              <Chip key={p.id} label={p.label} sub={`${p.kcal} kcal`} on={p.id === portion?.id} onPress={() => onEdit({ portion: p })} />
            ))}
          </Chips>
        </Field>
      )}

      <Field label="How many">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <StepBtn label="Less" icon={Minus} onPress={() => onEdit({ qty: Math.max(0.25, (entry.qty || 1) - 0.25) })} />
          <View style={{ flex: 1, alignItems: 'center' }}>
            <T size={17} weight={700} align="center">{portionLabel(entry.qty, portion)}</T>
            <T size={12} muted align="center">{amount.kcal.toLocaleString()} kcal · {amount.protein}P {amount.carbs}C {amount.fat}F</T>
          </View>
          <StepBtn label="More" icon={Plus} onPress={() => onEdit({ qty: (entry.qty || 1) + 0.25 })} />
        </View>
      </Field>

      {/* The other everyday mistake: logging today what you ate yesterday. */}
      <Field label="Day">
        <Chips>
          <Chip icon={CalendarDays} label="Move back a day" onPress={() => onMove(shiftDate(date, -1))} />
          {date < today && (
            <Chip label="Move forward a day" onPress={() => onMove(shiftDate(date, 1))} />
          )}
        </Chips>
      </Field>

      <Btn kind="quiet" icon={Trash2} title="Remove this one" onPress={askRemove} />
    </Panel>
  )
}

/* ------------------------------------------------------------- the screen */

export default function FoodView() {
  const params = useLocalSearchParams<{ entry?: string; key?: string }>()
  const store = useStore()
  const today = isoDate()
  // Which logged entry the editor points at. Starts at the one he tapped; a row
  // in the history moves it.
  const [entryId, setEntryId] = useState<string | null>(params.entry || null)

  // Everything below is DERIVED every render, never held as a copy. Bushido
  // shipped that bug twice — a sheet rendering an entry as it was when it opened
  // — and it renders perfectly while being wrong, so no test catches it.
  const entry = entryId ? store.entryById(entryId) : null
  const key = params.key || (entry ? foodKey(entry) : '')
  const history = useMemo(() => (key ? store.historyFor(key) : []), [store, key])
  const food: Item | undefined = entry || history[0]
  const subject = entry || food

  // While the sheet slides away after a remove, keep showing what was there
  // rather than flashing "Gone" on the way out.
  const leaving = useRef(false)
  const last = useRef<Item | undefined>(undefined)
  if (subject) last.current = subject
  const shown = subject || (leaving.current ? last.current : undefined)

  const stats = useMemo(() => statsFor(history, today), [history, today])

  /*
   * Every portion this food is known to have: the catalogue's, plus whatever
   * portion each past entry was actually logged against. The second half is what
   * lets a serving picked months ago still be re-selectable today, even for a
   * hand-typed food that never had a portion list at all.
   */
  const portions = useMemo(() => {
    const seen = new Map<string, Portion>()
    for (const p of (food as Partial<Food> | undefined)?.portions || []) seen.set(p.id, p)
    for (const h of history) if (h.portion && !seen.has(h.portion.id)) seen.set(h.portion.id, h.portion)
    if (entry?.portion && !seen.has(entry.portion.id)) seen.set(entry.portion.id, entry.portion)
    return [...seen.values()]
  }, [food, history, entry])

  const close = () => router.back()

  if (!shown) {
    // The entry was removed while this screen was open — from another device, or
    // by the confirm above. Saying so beats rendering a blank pane.
    return (
      <Pane title="Gone" onBack={close} center>
        <T muted>That food is no longer in the log.</T>
      </Pane>
    )
  }

  const onEdit = (patch: Record<string, any>) => { if (entry) store.editFood(entry.id, patch) }
  const onMove = (to: string) => {
    if (!entry) return
    store.moveEntry(entry.id, to)
    // Follow the food to the day it moved to, so the screen behind is not
    // showing a day the entry has just left.
    setDay(to)
  }
  const onRemove = () => {
    leaving.current = true
    if (entry) store.removeFood(entry.id)
    close()
  }
  const onLogAgain = () => {
    const relog = { ...shown, portions } as unknown as Food
    close()
    // One sheet at a time: the add sheet opens once this one has gone.
    setTimeout(() => openAdd(getDay(), { relog }), 350)
  }

  return (
    <Pane title={titleOf(shown)} onBack={close}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: radius.panel, padding: 14 }}>
        <Thumb food={shown} size={84} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T size={17} weight={700}>{titleOf(shown)}</T>
          {stats && (
            <T size={13} muted>
              {stats.times === 1 ? 'Eaten once' : `Eaten ${stats.times} times`}
              {stats.thisWeek > 0 && ` · ${stats.thisWeek} in the last 7 days`}
            </T>
          )}
          {shown.source === 'ai' && <T size={13} muted>Estimated by AI — nobody publishes this one</T>}
          {(shown.components?.length || 0) > 0 && (
            <T size={13} muted>{shown.components!.map(c => c.name).join(', ')}</T>
          )}
        </View>
      </View>

      {entry && (
        <EntryEditor
          entry={entry}
          portions={portions}
          onEdit={onEdit}
          onMove={onMove}
          onRemove={onRemove}
        />
      )}

      <Btn kind="primary" icon={Plus} title="Log it again" onPress={onLogAgain} />

      <View style={{ gap: 8 }}>
        <ListHead icon={Utensils} title="Every time you have had this" style={{ marginVertical: 4 }} />
        {history.length === 0 && <RowNote>Not logged yet.</RowNote>}
        {history.map(h => {
          const on = entry?.id === h.id
          return (
            <Press
              key={h.id}
              haptic
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              onPress={() => setEntryId(h.id)}
              // Which row the editor above is pointed at. Without it, tapping a
              // history row changes a panel further up with nothing to say it did.
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: TAP,
                paddingVertical: 8, paddingHorizontal: 14, borderWidth: 1, borderRadius: radius.r,
                borderColor: on ? colors.accent : colors.line,
                backgroundColor: on ? alpha(colors.accent, 0.08) : colors.panel,
              }}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <T weight={700}>{dayLabel(String(h.date), today)}</T>
                <T size={12} muted>{mealLabel(h.meal)} · {portionLabel(h.qty, h.portion)}</T>
              </View>
              <T weight={700} tabular>{Math.round(h.kcal).toLocaleString()}</T>
            </Press>
          )
        })}
      </View>
    </Pane>
  )
}
