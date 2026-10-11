/*
 * Krakatoa — build an order at a chain: a bowl at Chipotle or Bibibop, a tray at
 * McDonald's or Culver's. Ported from app/src/bowl.jsx.
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

import React, { useEffect, useMemo, useState } from 'react'
import { View } from 'react-native'
import { router } from 'expo-router'
import { Pane, CenterPane } from '../../ui/Pane'
import { T } from '../../ui/Text'
import { Btn, IconBtn, ListHead, Press, RowBtns, RowNote, SearchBox, Seg } from '../../ui/kit'
import { success } from '../../ui/haptics'
import { alpha, colors, radius } from '../../theme'
import { BookMarked, Check, ChevronDown, FileText, Minus, Plus } from '../../lib/icons'
import {
  addToBowl, removeFromBowl, bowlTotals, bowlName, bowlComponents, bowlVessel, effectiveQty,
  stepSize, selKey, portionOf, defaultPortionId, picks,
  type Chain, type MenuItem, type Selection, type Size, type Step as MenuStep,
} from '../../lib/restaurants'
import { mealNow, round } from '../../lib/food'
import { getStore } from '../../lib/store'
import type { Food, Portion } from '../../lib/types'
import { addComponents, pick, useFlow } from './flow'

/** "½", "1½", "2" — how a quantity reads on a chip. */
function qtyLabel(q: number) {
  const whole = Math.floor(q)
  const half = Math.abs(q - whole - 0.5) < 0.01
  if (half) return whole ? `${whole}½` : '½'
  return String(round(q, 2))
}

/** "Regular · 22 fl oz" -> "Regular". The chip's own line carries the rest. */
const sizeName = (p: Portion) => p.label.split(' · ')[0]

/** The amber pill with a count in it (.step-count, .part-size b). */
function Badge({ n }: { n: string | number }) {
  return (
    <View style={{ minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: radius.pill, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }}>
      <T size={11} weight={700} color={colors.onAccent} lineHeight={14}>{n}</T>
    </View>
  )
}

function Part({ item, selection, size, onAdd, onRemove }: {
  item: MenuItem
  selection: Selection
  size: Size | null
  onAdd: (pid: string) => void
  onRemove: (pid: string) => void
}) {
  const [pid, setPid] = useState(defaultPortionId(item))
  const p = portionOf(item, pid) as Portion
  const qty = selection[selKey(item, p.id)] || 0
  const anyOn = item.portions.some(x => selection[selKey(item, x.id)] > 0)
  // The chip shows what THIS order gets of it: a bibiCup's rice is half.
  const eff = effectiveQty(item, qty > 0 ? qty : 1, size)
  const kcal = Math.round(p.kcal * eff)
  const protein = round((p.protein || 0) * eff, 1)

  return (
    <View style={{
      width: '48.8%', borderWidth: 1, borderRadius: radius.r, overflow: 'hidden',
      borderColor: anyOn ? colors.accent : colors.line,
      backgroundColor: anyOn ? alpha(colors.accent, 0.09) : colors.panel,
    }}
    >
      <Press
        haptic
        accessibilityRole="button"
        accessibilityLabel={`Add ${item.name}${item.portions.length > 1 ? `, ${sizeName(p)}` : ''}`}
        onPress={() => onAdd(p.id)}
        style={{ minHeight: 58, paddingVertical: 9, paddingHorizontal: 11, gap: 2, alignItems: 'flex-start' }}
      >
        <T size={14} weight={600} lineHeight={17}>{item.name}</T>
        <T size={12} muted lineHeight={16}>
          <T size={12} weight={700} tabular lineHeight={16}>{kcal}</T> kcal · {protein}P
        </T>
        <T size={10} muted lineHeight={13} style={{ opacity: 0.75 }}>{p.label}</T>
      </Press>
      {item.portions.length > 1 && (
        <View accessibilityRole="radiogroup" accessibilityLabel={`${item.name} size`} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, paddingHorizontal: 8, paddingBottom: 8 }}>
          {item.portions.map(x => {
            const n = selection[selKey(item, x.id)] || 0
            const on = x.id === p.id
            return (
              <Press
                key={x.id}
                haptic
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                onPress={() => setPid(x.id)}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 30, paddingHorizontal: 9,
                  borderWidth: 1, borderRadius: radius.pill, borderColor: on ? colors.accent : colors.line,
                }}
              >
                <T size={12} weight={600} color={on ? colors.text : colors.muted}>{sizeName(x)}</T>
                {n > 0 && <Badge n={qtyLabel(n)} />}
              </Press>
            )
          })}
        </View>
      )}
      {qty > 0 && (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4, paddingBottom: 4 }}>
          <IconBtn icon={Minus} sm size={14} label={`Less ${item.name}`} onPress={() => onRemove(p.id)} />
          <T size={14} weight={700} tabular>{qtyLabel(qty)}×</T>
          <IconBtn icon={Plus} sm size={14} label={`More ${item.name}`} onPress={() => onAdd(p.id)} />
        </View>
      )}
    </View>
  )
}

function Step({ chain, step, items, selection, size, searching, stacked, onAdd, onRemove }: {
  chain: Chain
  step: MenuStep
  items: MenuItem[]
  selection: Selection
  size: Size | null
  searching: boolean
  /** Straight after another fold: the folds stack as one ruled list. */
  stacked: boolean
  onAdd: (item: MenuItem, pid: string) => void
  onRemove: (item: MenuItem, pid: string) => void
}) {
  const inIt = picks(chain, selection).filter(x => x.item.step === step.id).length
  // A folded step opens itself once something in it is picked, and stays open.
  const [open, setOpen] = useState(inIt > 0)
  useEffect(() => { if (inIt > 0) setOpen(true) }, [inIt])

  // Within a step, grouped by the chain's own table: hot and cold toppings are
  // one step and two headings.
  const cats = [...new Set(items.map(i => i.category))]
  const hint = step.hint && !step.collapsed
    ? step.hint
    : !step.hint && stepSize(chain, step.id) === 0.5 ? 'in halves' : null
  const headBits = (
    <>
      {inIt > 0 && <Badge n={inIt} />}
      {hint ? <T size={11} weight={500} muted style={{ marginLeft: 'auto' }}>{hint}</T> : null}
    </>
  )
  const body = cats.map(cat => (
    <View key={cat} style={{ gap: 6 }}>
      {cats.length > 1 && <T size={11} weight={600} caps muted style={{ marginTop: 6, marginHorizontal: 2, opacity: 0.8 }}>{cat}</T>}
      {/* Two columns, top-aligned, not stretched: a chosen part grows a stepper,
          and stretching would give its neighbour the same empty band. */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', rowGap: 8 }}>
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
      </View>
    </View>
  ))

  // A folded step is still IN the page — the web's <details>, here a header that
  // toggles — so nothing on the menu is ever more than one tap from the screen.
  // It opens itself while he is searching (rendered as an ordinary step then).
  if (step.collapsed && !searching) {
    return (
      <View style={{ borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.line, marginTop: stacked ? -19 : 0, paddingBottom: open ? 14 : 0, gap: 8 }}>
        <Press
          haptic
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(o => !o)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 }}
        >
          <ListHead title={step.label} style={{ flex: 1 }}>
            {headBits}
            <T size={11} weight={500} muted style={{ marginLeft: hint ? 0 : 'auto' }}>{items.length}</T>
          </ListHead>
          <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}>
            <ChevronDown size={16} color={colors.muted} />
          </View>
        </Press>
        {open ? body : null}
      </View>
    )
  }
  return (
    <View style={{ gap: 8 }}>
      <ListHead title={step.label} style={{ marginVertical: 4 }}>{headBits}</ListHead>
      {body}
    </View>
  )
}

function matches(item: MenuItem, words: string[]) {
  const hay = `${item.name} ${item.category}`.toLowerCase()
  return words.every(w => hay.includes(w))
}

const longDate = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/** The route: the chain the restaurant screen opened (flow.chain). */
export default function BowlBuilder() {
  const { chain, mode } = useFlow()
  if (!chain) {
    return <CenterPane><T muted>That menu is no longer open.</T><Btn title="Back" onPress={() => router.back()} /></CenterPane>
  }
  return <Bowl chain={chain} mode={mode} />
}

function Bowl({ chain, mode }: { chain: Chain; mode: 'log' | 'component' }) {
  const [sizeId, setSizeId] = useState<string | null>(chain.sizes?.[0]?.id || null)
  const [selection, setSelection] = useState<Selection>({})
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

  const add = (item: MenuItem, pid: string) => { setSelection(s => addToBowl(s, item, chain, pid)); setSaved(false) }
  const remove = (item: MenuItem, pid: string) => { setSelection(s => removeFromBowl(s, item, chain, pid)); setSaved(false) }

  /* The order as an ordinary food: one portion carrying the whole total, plus
     its parts — so it goes through the same detail screen and the same log
     writer as everything else, and the food screen can list what was in it. */
  const asFood = (): Food => {
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

  const foot = (
    <>
      {/* The running total lives at the thumb, so it moves under the finger that
          is changing it. */}
      <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 8, rowGap: 4 }}>
        <T size={28} weight={700} tabular lineHeight={32}>{total.kcal.toLocaleString()}</T>
        <T size={13} muted>kcal</T>
        <T size={13} muted style={{ marginLeft: 'auto' }}>
          <T size={13} weight={700} tabular>{Math.round(total.protein)}</T>P · <T size={13} weight={700} tabular>{Math.round(total.carbs)}</T>C · <T size={13} weight={700} tabular>{Math.round(total.fat)}</T>F
        </T>
        {total.sodium > 0 && (
          <T size={11} muted style={{ flexBasis: '100%' }}>{name.replace(`${chain.short} · `, '')} · {total.sodium.toLocaleString()} mg sodium</T>
        )}
      </View>

      {forMeal ? (
        // Building a combo: the bowl's PARTS go in, not the bowl — combos do not
        // nest, so a combo's total can never depend on another one.
        <Btn kind="primary" disabled={empty} title="Add these to the combo"
          onPress={() => addComponents(bowlComponents(chain, selection, size))} />
      ) : (
        <RowBtns>
          <Btn
            flex
            disabled={empty || saved}
            icon={saved ? Check : BookMarked}
            title={saved ? 'Saved' : 'Save combo'}
            onPress={() => {
              getStore().saveCombo({ name, components: bowlComponents(chain, selection, size) })
              success()
              setSaved(true)
            }}
          />
          {/* Logging goes through the ordinary detail screen, so the meal and the
              quantity are asked the same way as for anything else — half a bowl
              eaten is 0.5 there, not a special case here. */}
          <Btn flex kind="primary" disabled={empty} title="Log it" onPress={() => pick(asFood(), { qty: 1, meal: mealNow() })} />
        </RowBtns>
      )}
    </>
  )

  return (
    <Pane title={chain.name} onBack={() => router.back()} foot={foot} bodyStyle={{ paddingBottom: 24 }}>
      {(chain.sizes?.length || 0) > 1 && (
        // Bowl / bibiCup. A segmented control, because it is one choice of two
        // that changes every number on the screen, and it should look like that.
        <Seg
          options={chain.sizes!.map(s => ({ value: s.id, label: s.label }))}
          value={sizeId || ''}
          onChange={setSizeId}
        />
      )}

      {searchable && (
        <SearchBox value={q} onChangeText={setQ} placeholder={`Search ${chain.short}…`} label={`Search the ${chain.short} menu`} />
      )}

      {shown.map(({ step, items }, n) => (
        <Step
          key={step.id}
          chain={chain}
          step={step}
          items={items}
          selection={selection}
          size={size}
          searching={words.length > 0}
          stacked={n > 0 && !!shown[n - 1].step.collapsed && !!step.collapsed && !words.length}
          onAdd={add}
          onRemove={remove}
        />
      ))}
      {words.length > 0 && !shown.length && <RowNote>{`Nothing on the ${chain.short} menu matches “${q.trim()}”.`}</RowNote>}

      {/* The receipt. Every number on this screen came from this source. */}
      <View style={{ flexDirection: 'row', gap: 4, marginTop: 4 }}>
        <FileText size={12} color={colors.muted} style={{ marginTop: 3 }} />
        <T size={11} muted lineHeight={16} style={{ flex: 1 }}>
          From {src.what || `${chain.short}'s nutrition data`}
          {src.published ? `, ${src.dateWord || 'updated'} ${longDate(src.published)}` : ''}
          {src.from && src.from !== src.published ? ` (oldest item ${longDate(src.from)})` : ''}.
          {' '}{chain.note}
        </T>
      </View>
    </Pane>
  )
}
