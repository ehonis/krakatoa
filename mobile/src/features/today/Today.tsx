/*
 * Krakatoa — the day. Ported from app/src/today.jsx, with the shell around it
 * (App.jsx: the Ask AI pill, the overlays it opens).
 *
 * The only screen that matters. A number, how far through the target it is, what
 * filled it, and one button. Everything else in this app exists to put a row on
 * this list.
 *
 * On a phone the overlays are page sheets over this screen: Add food, one food,
 * Daily targets and Settings. What is native beyond that: pull down to sync now,
 * swipe sideways to go back or forward a day, and the camera opens straight from
 * the scan button, full screen, the way it does from the add sheet.
 */

import React, { useMemo, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { router, useIsFocused } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { LinearGradient } from 'expo-linear-gradient'
import Svg, { Circle } from 'react-native-svg'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import {
  BookMarked, ChevronLeft, ChevronRight, CircleAlert, CloudOff, Flame, Plus, RefreshCw, ScanBarcode,
  Settings, Sparkles, Target, TrendingDown, TrendingUp,
} from '../../lib/icons'
import { MEALS, dayLabel, isoDate, mealLabel, portionLabel, shiftDate, titleOf, totals } from '../../lib/food'
import { macroSplit, ringSegments } from '../../lib/macros'
import { componentsFromEntries } from '../../lib/combos'
import { balanceFor, useWhoop, type Balance as BalanceT, type Whoop } from '../../lib/whoop'
import { useThreads } from '../../lib/askapi'
import { useServerInfo, openSettings } from '../../lib/server'
import { syncNow, useStore } from '../../lib/store'
import { foodKey } from '../../lib/food'
import type { Item as ItemT, Totals } from '../../lib/types'
import { colors, alpha, radius, TAP } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, IconBtn, Link, ListHead, Panel, Press, Spin } from '../../ui/kit'
import Thumb from '../../ui/Thumb'
import { impact, tap } from '../../ui/haptics'
import { openAdd } from '../add/flow'
import ScannerModal from '../add/Scanner'
import Water from './Water'
import { setDay, useDay } from './day'

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
const TONE: Record<string, string> = { protein: colors.tone1, carbs: colors.tone2, fat: colors.tone3 }

function Ring({ value, target, totals: t }: { value: number; target: number | null; totals: Totals }) {
  const { segments, over } = ringSegments(t, target)
  const R = 54
  const C = 2 * Math.PI * R
  const plain = !segments.length

  return (
    <View style={{ width: 128, height: 128 }}>
      <Svg width={128} height={128} viewBox="0 0 128 128">
        <Circle cx={64} cy={64} r={R} fill="none" stroke={colors.panel2} strokeWidth={10} />
        {plain && target && target > 0 ? (
          <Circle
            cx={64} cy={64} r={R} fill="none"
            stroke={over ? colors.danger : colors.accent} strokeWidth={10} strokeLinecap="round"
            strokeDasharray={`${C * Math.min(1, value / target)} ${C}`}
            transform="rotate(-90 64 64)"
          />
        ) : null}
        {segments.map(seg => (
          <Circle
            key={seg.key}
            cx={64} cy={64} r={R} fill="none"
            stroke={TONE[seg.key]} strokeWidth={10}
            // A gap between segments would be drawn out of the arc itself and
            // would make the colours lie about their share, so they butt up and
            // the stroke's flat cap is the only separator.
            strokeLinecap="butt"
            strokeDasharray={`${(C * seg.length) / 100} ${C}`}
            strokeDashoffset={-(C * seg.offset) / 100}
            transform="rotate(-90 64 64)"
          />
        ))}
      </Svg>
      <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
        <T size={28} weight={700} tabular lineHeight={31}>{value.toLocaleString()}</T>
        <T size={11} muted align="center">{target ? `of ${target.toLocaleString()} kcal` : 'kcal'}</T>
      </View>
    </View>
  )
}

function MacroBar({ label, value, target, tone, share }: { label: string; value: number; target: number | null; tone: string; share: number | null }) {
  const pct = target ? Math.min(100, (value / target) * 100) : 0
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        {/* The dot ties this row to its slice of the ring above. Without it the
            ring is three anonymous colours and the reader has to guess. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: tone }} />
          <T size={13}>{label}</T>
        </View>
        <T size={13} tabular>
          {/* The share is the pie in words, which is what makes the ring
              readable to a number rather than only to an eye. */}
          {share != null ? <T size={13} muted tabular>{`${share}%   `}</T> : null}
          {Math.round(value)}<T size={13} muted>{target ? ` / ${target} g` : ' g'}</T>
        </T>
      </View>
      <View style={{ height: 6, backgroundColor: colors.panel2, borderRadius: 3, overflow: 'hidden' }}>
        <View style={{ height: '100%', width: `${pct}%`, backgroundColor: tone, borderRadius: 3 }} />
      </View>
    </View>
  )
}

/*
 * A logged row. The WHOLE row opens the food screen rather than carrying its own
 * delete button: a bin beside every row is four taps of destruction a thumb can
 * reach by accident mid-scroll, and the mistake that actually happens is a
 * mis-tap putting a snack in the wrong meal. Correcting that needs a screen, and
 * once there is one, removing belongs on it behind the same confirmation.
 */
function Item({ item, onOpen }: { item: ItemT; onOpen: (id: string) => void }) {
  return (
    <Press haptic style={st.item} onPress={() => onOpen(item.id)} accessibilityRole="button">
      <Thumb food={item} size={38} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T weight={600} numberOfLines={1}>{titleOf(item)}</T>
        <T size={12} muted numberOfLines={1}>
          {portionLabel(item.qty, item.portion)}
          {item.protein || item.carbs || item.fat
            ? ` · ${Math.round(item.protein)}P ${Math.round(item.carbs)}C ${Math.round(item.fat)}F`
            : ''}
        </T>
      </View>
      <T weight={700} tabular>{Math.round(item.kcal).toLocaleString()}</T>
      <ChevronRight size={18} color={colors.muted} />
    </Press>
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
function ago(iso?: string) {
  if (!iso) return null
  const mins = Math.floor((Date.now() - Date.parse(iso)) / 60000)
  if (!Number.isFinite(mins) || mins < 0) return null
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  return hrs < 24 ? `${hrs} h ago` : `${Math.round(hrs / 24)} d ago`
}

export function Balance({ balance, whoop, onRefresh, refreshing }: { balance: BalanceT | null; whoop: Whoop | null; onRefresh?: () => void; refreshing: boolean }) {
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
      <Panel style={st.balance}>
        <ListHead icon={Flame} title="Energy" right={<RefreshButton onRefresh={onRefresh} refreshing={refreshing} />} />
        <T size={13} muted align="center" lineHeight={19}>
          <CircleAlert size={13} color={colors.muted} /> {err}
        </T>
      </Panel>
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
   * about five per cent, and inflating that would make an ordinary day look like
   * a crisis. The notch is what makes a small offset legible without
   * exaggerating it.
   */
  const total = eaten + burned
  // Clamped off the very ends so a lopsided day still shows a sliver of the
  // losing colour — a bar that reads as one solid block has stopped being a
  // comparison.
  const eatenPct = total > 0 ? Math.min(97, Math.max(3, (eaten / total) * 100)) : 50

  return (
    <Panel style={st.balance}>
      <ListHead icon={Flame} title={`Energy${partial ? ' so far today' : ''}`} right={<RefreshButton onRefresh={onRefresh} refreshing={refreshing} at={whoop?.fetchedAt} />} />

      {/* An untracked day gets no bar at all. Drawing one would fill the whole
          track with burn and read as an enormous deficit, which is the exact
          lie the `untracked` flag exists to prevent — he did not eat nothing,
          he did not TELL us what he ate. */}
      {!untracked && (
        <>
          <View style={st.tug} accessible accessibilityRole="image" accessibilityLabel={`${eaten} kcal eaten against ${burned} kcal burned`}>
            <LinearGradient colors={[colors.accentDim, colors.accent]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ width: `${eatenPct}%` }} />
            <LinearGradient colors={[colors.tone2, colors.burned]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ width: `${100 - eatenPct}%` }} />
          </View>

          {/* The "even" reference sits BELOW the track, not in it. Inside, it
              landed on top of the join whenever the two numbers were close —
              which is most days — and two dark vertical lines a few pixels apart
              cannot be told from one another, so the reading lost its reference
              exactly when it needed it. */}
          <View style={{ height: 16, alignItems: 'center' }}>
            <View style={{ width: 1, height: 6, backgroundColor: colors.muted }} />
            <T size={10} caps muted lineHeight={12} style={{ letterSpacing: 0.8 }}>even</T>
          </View>

          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 }}>
            <View>
              <T size={20} weight={700} tabular lineHeight={24}>{eaten.toLocaleString()}</T>
              <T size={12} muted>eaten</T>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <T size={20} weight={700} tabular lineHeight={24}>{burned.toLocaleString()}</T>
              <T size={12} muted>burned{partial ? ' so far' : ''}</T>
            </View>
          </View>
        </>
      )}

      {untracked ? (
        <T size={13} muted align="center" lineHeight={19}>Nothing logged that day, so there is no balance to read.</T>
      ) : partial && typical ? (
        /* The heading already says "so far today" and the label under the bar
           says "burned so far"; what is left is the only thing the screen does
           not already say — the average COMPLETE day, which is what a partial
           number is read against. */
        <T size={13} muted align="center" lineHeight={19}>
          You usually finish around <T size={13} weight={700}>{typical.toLocaleString()}</T>.
        </T>
      ) : partial ? null : (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          {under ? <TrendingDown size={16} color={colors.tone2} /> : <TrendingUp size={16} color={colors.accent} />}
          <T size={15} weight={700} color={under ? colors.tone2 : colors.accent}>{Math.abs(net).toLocaleString()} kcal {under ? 'under' : 'over'}</T>
        </View>
      )}

      {/* A failed pull leaves the previous cache in place and carries its reason
          alongside — so the numbers above are still real and this says why they
          did not move. Bushido's wording (WHOOP's, passed on) travels verbatim because it names
          the fix ("reconnect WHOOP", "authorized without read:workout"). */}
      {err ? (
        <T size={13} muted align="center" lineHeight={19}><CircleAlert size={12} color={colors.muted} /> {err}</T>
      ) : null}

      <T size={11} muted align="center" style={{ opacity: 0.75 }}>WHOOP's estimate from heart rate, not a measurement.</T>
    </Panel>
  )
}

function RefreshButton({ onRefresh, refreshing, at }: { onRefresh?: () => void; refreshing: boolean; at?: string }) {
  if (!onRefresh) return null
  const when = ago(at)
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
      {when ? <T size={10} muted>{when}</T> : null}
      {refreshing
        ? <View style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center', opacity: 0.5 }}><Spin size={15} color={colors.text} /></View>
        : <IconBtn icon={RefreshCw} sm size={15} label="Refresh from WHOOP" onPress={onRefresh} />}
    </View>
  )
}

/* ------------------------------------------------------------------ ask pill */

/*
 * Ask AI works in the background, so it has to be able to say so from the day:
 * a pill while something is working, and one that opens the answer when it
 * lands and he has not looked yet. Gone once he opens it or logs it.
 */
function AskPill({ onOpen, bottom }: { onOpen: (id: string) => void; bottom: number }) {
  const focused = useIsFocused()
  const { threads } = useThreads({ enabled: focused })
  if (!focused) return null
  const working = threads.filter(t => t.status === 'working')
  const fresh = threads.find(t => (t.status === 'ready' || t.status === 'error') && !t.seenAt && !t.loggedAt)
  if (fresh) {
    return (
      <Press haptic style={[st.pill, st.pillReady, { bottom }]} onPress={() => onOpen(fresh.id)}>
        <Sparkles size={15} color={colors.ai} />
        <T size={13} numberOfLines={1} style={{ flexShrink: 1 }}>
          <T size={13} weight={700}>{fresh.title}</T> {fresh.status === 'error' ? 'did not finish' : `is ready · ${fresh.kcal.toLocaleString()} kcal`}
        </T>
      </Press>
    )
  }
  if (working.length) {
    return (
      <Press haptic style={[st.pill, { bottom }]} onPress={() => onOpen(working[0].id)}>
        <Spin size={15} color={colors.ai} />
        <T size={13} numberOfLines={1}>Ask AI is working{working.length > 1 ? ` on ${working.length}` : ''}…</T>
      </Press>
    )
  }
  return null
}

/* --------------------------------------------------------------------- day */

export default function Today() {
  const insets = useSafeAreaInsets()
  const store = useStore()
  const info = useServerInfo()
  const { whoop, refresh: refreshWhoop, refreshing: whoopRefreshing } = useWhoop()
  const date = useDay()
  const [scanning, setScanning] = useState(false)
  const [pulling, setPulling] = useState(false)
  const today = isoDate()

  // Everything below is DERIVED every render, never held as a copy. Bushido shipped
  // that bug twice — a sheet rendering an entry as it was when it opened — and it
  // renders perfectly while being wrong, so no test catches it. See lib/store.ts.
  const items = store.dayItems(date)
  const targets = store.targets
  const total = useMemo(() => totals(items), [items])
  const split = useMemo(() => macroSplit(total), [total])
  const shareOf = (key: string) => (split.fromMacros > 0 ? split.parts.find(p => p.key === key)!.pct : null)
  const balance = balanceFor(whoop, date, total.kcal, today)
  // Only when a burn source is configured. Without one there is nothing to
  // compare against, and an empty panel would read as a broken one.
  const energy = !!info?.features?.whoop

  const byMeal = useMemo(() => {
    const map = new Map<string, ItemT[]>(MEALS.map(m => [m.id, []]))
    for (const it of items) {
      const key = map.has(it.meal || '') ? it.meal! : 'snack'
      map.get(key)!.push(it)
    }
    return [...map.entries()].filter(([, list]) => list.length)
  }, [items])

  const onAdd = () => openAdd(date)
  const onScan = () => { impact(); setScanning(true) }
  const openEntry = (id: string) => {
    const e = store.entryById(id)
    if (e) router.push({ pathname: '/food', params: { entry: id, key: foodKey(e) } })
  }
  const go = (d: string) => { tap(); setDay(d) }

  // Sideways through the days: right for the day before, left for the next one,
  // stopping at today as the arrows do. Horizontal only, so the list still scrolls.
  const swipe = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetX([-40, 40])
    .failOffsetY([-14, 14])
    .onEnd((e) => {
      if (e.translationX > 70) go(shiftDate(date, -1))
      else if (e.translationX < -70 && date < today) go(shiftDate(date, 1))
    })

  const fabBottom = Math.max(insets.bottom, 0) + 18

  return (
    <View style={[st.screen, { paddingTop: insets.top }]}>
      <View style={st.head}>
        <IconBtn icon={ChevronLeft} label="Previous day" onPress={() => go(shiftDate(date, -1))} />
        <Press style={st.title} onPress={() => go(today)} accessibilityRole="button" accessibilityLabel="Go to today">
          <T size={19} weight={700}>{dayLabel(date, today)}</T>
          {date !== today ? <T size={12} muted lineHeight={15}>tap for today</T> : null}
        </Press>
        {/* Tomorrow has not happened. Nothing stops him looking, but the arrow
            stopping at today is the honest edge of the log. */}
        <IconBtn icon={ChevronRight} label="Next day" onPress={() => go(shiftDate(date, 1))} disabled={date >= today} />
      </View>
      <LinearGradient pointerEvents="none" colors={[colors.bg, alpha(colors.bg, 0)]} style={[st.fade, { top: insets.top + 60 }]} />

      <GestureDetector gesture={swipe}>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: insets.bottom + 110 }}
          refreshControl={<RefreshControl refreshing={pulling} tintColor={colors.muted} onRefresh={async () => { setPulling(true); await syncNow(); setPulling(false) }} />}
        >
          <Panel style={st.summary}>
            <Ring value={total.kcal} target={targets.kcal} totals={total} />
            <View style={{ flex: 1, minWidth: 0, gap: 10 }}>
              <MacroBar label="Protein" value={total.protein} target={targets.protein} tone={colors.tone1} share={shareOf('protein')} />
              <MacroBar label="Carbs" value={total.carbs} target={targets.carbs} tone={colors.tone2} share={shareOf('carbs')} />
              <MacroBar label="Fat" value={total.fat} target={targets.fat} tone={colors.tone3} share={shareOf('fat')} />
              {targets.kcal != null ? (
                <T size={13} muted style={{ marginTop: 2 }}>
                  {total.kcal <= targets.kcal
                    ? `${(targets.kcal - total.kcal).toLocaleString()} kcal left`
                    : `${(total.kcal - targets.kcal).toLocaleString()} kcal over`}
                </T>
              ) : null}
            </View>
          </Panel>

          {energy ? <Balance balance={balance} whoop={whoop} onRefresh={refreshWhoop} refreshing={whoopRefreshing} /> : null}
          <Water oz={store.waterOn(date)} target={targets.water} onAdd={(oz) => store.addWater(date, oz)} />

          {items.length === 0 ? (
            <View style={{ alignItems: 'center', paddingVertical: 40, gap: 14 }}>
              <T muted>Nothing logged{date === today ? ' yet today' : ' that day'}.</T>
              <Btn icon={Plus} title="Add the first thing" onPress={onAdd} />
            </View>
          ) : (
            byMeal.map(([meal, list]) => (
              <View key={meal} style={{ marginBottom: 18 }}>
                <View style={st.mealHead}>
                  <T size={13} caps muted>{mealLabel(meal)}</T>
                  <T size={13} caps muted tabular>{totals(list).kcal.toLocaleString()} kcal</T>
                </View>
                <View style={{ gap: 6 }}>
                  {list.map(it => <Item key={it.id} item={it} onOpen={openEntry} />)}
                </View>
                {/*
                  The path that actually gets used for saving a meal. Nobody writes
                  a recipe before they have cooked it — he logs the eggs, the butter
                  and the milk the ordinary way, and THEN says that was a meal. Only
                  offered where there is something to combine.
                */}
                {list.length > 1 ? (
                  <Press haptic style={st.saveMeal} onPress={() => openAdd(date, { seedComponents: componentsFromEntries(list) })}>
                    <BookMarked size={14} color={colors.muted} />
                    <T size={13} muted>Save this {mealLabel(meal).toLowerCase()} as a combo</T>
                  </Press>
                ) : null}
              </View>
            ))
          )}

          <View style={{ alignItems: 'center', gap: 4, marginTop: 8 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', columnGap: 18 }}>
              <Link icon={Target} title="Daily targets" onPress={() => router.push('/targets')} />
              {/* The phone's way in; the web's desktop header has a gear as well. */}
              <Link icon={Settings} title="Settings" onPress={() => openSettings()} />
            </View>
            {store.sync.state === 'offline' ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <CloudOff size={14} color={colors.muted} />
                <T size={12} muted>Saved on this device, not synced yet</T>
              </View>
            ) : null}
          </View>
        </ScrollView>
      </GestureDetector>

      <AskPill bottom={fabBottom + 78} onOpen={(id) => openAdd(date, { askThread: id })} />

      {/*
        Scanning is the single commonest way food gets into this app and it was
        three taps deep — the + , then the big scan button, then the camera. As
        its own control beside the + it is one. Deliberately the SMALLER of the
        two and second in reading order: it is the fast path, not the main one,
        because plenty of food has no barcode on it at all.
      */}
      <Press accessibilityRole="button" accessibilityLabel="Scan a barcode" onPress={onScan} style={[st.fab, st.fabScan, { bottom: fabBottom + 6 }]}>
        <ScanBarcode size={22} color={colors.text} />
      </Press>
      <Press accessibilityRole="button" accessibilityLabel="Add food" onPress={() => { impact(); onAdd() }} style={[st.fab, { bottom: fabBottom }]}>
        <Plus size={28} color={colors.onAccent} />
      </Press>

      {/* Backing out of the camera returns to the day: opened from here, landing
          him on the add screen he never asked for would make the shortcut cost
          a tap instead of saving two. A barcode opens the add sheet at its
          result. */}
      <ScannerModal
        visible={scanning}
        onClose={() => setScanning(false)}
        onCode={(code) => { setScanning(false); setTimeout(() => openAdd(date, { code }), 350) }}
        onManual={() => { setScanning(false); setTimeout(() => openAdd(date, { manual: true }), 350) }}
      />
    </View>
  )
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8, backgroundColor: colors.bg, zIndex: 2 },
  fade: { position: 'absolute', left: 0, right: 0, height: 14, zIndex: 2 },
  title: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: TAP },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 18, paddingVertical: 18, paddingHorizontal: 16, marginBottom: 20 },
  balance: { gap: 10, paddingHorizontal: 16, marginBottom: 20 },
  tug: { flexDirection: 'row', height: 26, borderRadius: 13, backgroundColor: colors.panel2, overflow: 'hidden' },
  mealHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginHorizontal: 4, marginBottom: 8 },
  item: {
    flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: TAP,
    paddingVertical: 10, paddingLeft: 14, paddingRight: 8,
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: radius.r,
  },
  saveMeal: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, marginLeft: 4, paddingVertical: 6, alignSelf: 'flex-start' },
  fab: {
    position: 'absolute', right: 18, width: 60, height: 60, borderRadius: 30,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent,
    shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 12, shadowOffset: { width: 0, height: 8 }, zIndex: 5,
  },
  fabScan: { right: 90, width: 48, height: 48, borderRadius: 24, backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line },
  pill: {
    position: 'absolute', left: 16, maxWidth: '78%', zIndex: 30,
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 14,
    borderRadius: radius.pill, borderWidth: 1, borderColor: alpha(colors.aiLine, 0.5), backgroundColor: '#1d1830',
    shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 12, shadowOffset: { width: 0, height: 8 },
  },
  pillReady: { backgroundColor: '#2a1f4a', borderColor: colors.aiLine },
})
