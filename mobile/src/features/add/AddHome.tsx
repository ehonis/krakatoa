/*
 * Krakatoa — putting food on the day. The `home` view of AddFlow in
 * app/src/add.jsx; the other views are their own screens in the add sheet's
 * stack, sharing features/add/flow.ts.
 *
 * ONE screen with every door on it, rather than a menu that asks how he would
 * like to answer before letting him answer. Recents and saved meals lead because
 * they are the honest majority of eating: nobody scans the same oats every
 * morning for a month, and a tracker that makes him is one he stops opening.
 *
 * Every door lands on the detail screen, which is the only place a quantity is
 * chosen — so the scan, the search, the recent, the basic, the saved meal and
 * the hand-typed food all end at the same two questions (how much, which meal)
 * and produce the same entry.
 *
 * The one variation is MODE. Opened normally it logs; opened from the combo
 * builder (`building`, the /add/ingredient route) it hands a component back
 * instead. Same screens, one branch at the end.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { View } from 'react-native'
import { router } from 'expo-router'
import {
  BookMarked, Carrot, CircleAlert, History, PencilLine, ScanBarcode, ScanText, Sparkles, Star, UtensilsCrossed,
} from '../../lib/icons'
import { comboAsFood } from '../../lib/combos'
import { amountFor, mealNow, portionLabel } from '../../lib/food'
import { searchBasics, useBasics } from '../../lib/basics'
import { portionOf, searchMenus, useRestaurants } from '../../lib/restaurants'
import { apiFetch } from '../../lib/connection'
import { useStore } from '../../lib/store'
import type { Food } from '../../lib/types'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { BigAction, Link, ListHead, RowNote, SearchBox } from '../../ui/kit'
import { Pane } from '../../ui/Pane'
import FoodRow from './FoodRow'
import { MealRow } from './MealBuilder'
import ScannerModal from './Scanner'
import { buildCombo, closeAdd, openLabel, pick, setFlow, stopPicking, useFlow } from './flow'

export default function AddHome({ building = false }: { building?: boolean }) {
  const store = useStore()
  const flow = useFlow()
  const [query, setQuery] = useState(flow.query)
  const [results, setResults] = useState<Food[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [scanning, setScanning] = useState(false)
  const basics = useBasics()
  const restaurants = useRestaurants()

  // The label and by-hand screens start from what was typed here.
  useEffect(() => { setFlow({ query }) }, [query])
  // Swiping back out of ingredient-picking is leaving it, the same as the cross.
  useEffect(() => (building ? () => setFlow({ mode: 'log' }) : undefined), [building])

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
  const [tried, setTried] = useState<{ source: string; error?: string }[]>([])
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setResults(null); setTried([]); setSearching(false); return undefined }
    setSearching(true)
    const ctl = new AbortController()
    const t = setTimeout(async () => {
      try {
        const res = await apiFetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctl.signal })
        const body = await res.json()
        setResults(body.foods || [])
        setTried(body.tried || [])
      } catch (e: any) {
        if (e?.name === 'AbortError' || ctl.signal.aborted) return
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

  const localHits = useMemo(() => searchBasics(basics.foods, query, 8), [basics.foods, query])
  // Menu items are on the device too, so "steak" or "bibibop" answers instantly
  // alongside the basics, before either database has been asked.
  const menuHits = useMemo(() => searchMenus(restaurants.chains, query, 6), [restaurants.chains, query])

  const searchingNow = query.trim().length >= 2

  return (
    <Pane
      title={building ? 'Add an ingredient' : 'Add food'}
      onClose={() => (building ? stopPicking() : closeAdd())}
      scrollProps={{ keyboardDismissMode: 'on-drag' }}
    >
      {/* The two doors that need no typing, side by side: a barcode, and
          everything else — a receipt, a plate, a sentence. */}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <BigAction compact icon={ScanBarcode} title="Scan a barcode" sub="Packaged food" onPress={() => setScanning(true)} style={{ flex: 1 }} />
        {!building ? (
          <BigAction compact kind="ai" icon={Sparkles} title="Ask AI" sub="A receipt, a plate, or words" onPress={() => router.push('/add/ask')} style={{ flex: 1 }} />
        ) : null}
      </View>

      <SearchBox value={query} onChangeText={setQuery} placeholder="Search — egg, butter, burrito…" label="Search for a food" />

      {searchingNow ? (
        <View style={{ gap: 6 }}>
          {/* Basics first and instantly: they are on the device, so "egg"
              answers before the databases have been asked. */}
          {localHits.map(f => (
            <FoodRow key={f.id} food={f} sub={f.portions[0]?.label} right={`${f.portions[0]?.kcal} kcal`} badge="basic" onPress={() => pick(f)} />
          ))}
          {menuHits.map(f => {
            const p = portionOf(f, f.defaultPortion)
            return (
              <FoodRow key={f.id} food={f as Food} sub={`${f.brand} · ${p?.label}${f.portions.length > 1 ? ` · ${f.portions.length} sizes` : ''}`}
                right={`${p?.kcal} kcal`} badge="restaurant" onPress={() => pick(f as Food)} />
            )
          })}
          {searching ? <RowNote spin>Searching…</RowNote> : null}
          {!searching && allDown ? (
            <RowNote icon={CircleAlert} color={colors.warnText}>
              <T size={15} color={colors.warnText}>The food databases did not answer.</T>
              <Link title="Try again" onPress={() => setRetry(n => n + 1)} />
            </RowNote>
          ) : null}
          {!searching && !allDown && tried.some(x => x.error && x.source === 'off') ? (
            <RowNote>
              <T size={12} muted lineHeight={19}>Open Food Facts did not answer, so some results may be missing.</T>
              <Link title="Try again" onPress={() => setRetry(n => n + 1)} />
            </RowNote>
          ) : null}
          {!searching && !allDown && results?.length === 0 && localHits.length === 0 && menuHits.length === 0 ? (
            <RowNote>
              <T size={15} muted>Nothing found.</T>
              <Link title="From the label" onPress={() => openLabel(null)} />
              <T size={15} muted>or</T>
              <Link title="add it by hand" onPress={() => router.push('/add/manual')} />
            </RowNote>
          ) : null}
          {results?.map((food, i) => (
            <FoodRow
              key={`${food.gtin || food.name}-${i}`}
              food={food}
              sub={food.portions[0]?.label}
              right={`${food.portions[0]?.kcal} kcal`}
              badge={food.source}
              onPress={() => pick(food)}
            />
          ))}
        </View>
      ) : (
        <>
          {/* A saved meal cannot be an ingredient of another meal — one level
              deep is a feature, not a limitation, and nesting would make a
              combo's totals depend on something that can change underneath it. */}
          {!building && store.combos.length > 0 ? (
            <View style={{ gap: 6 }}>
              <ListHead icon={BookMarked} title="Your combos" style={{ marginVertical: 4 }} />
              {store.combos.map(c => (
                <MealRow
                  key={c.id}
                  combo={c}
                  onPress={() => pick(comboAsFood(c), { qty: 1, meal: c.meal || mealNow() })}
                  onEdit={() => buildCombo({ id: c.id, name: c.name, components: c.components, meal: c.meal })}
                />
              ))}
            </View>
          ) : null}

          {store.starred.length > 0 ? (
            <View style={{ gap: 6 }}>
              <ListHead icon={Star} title="Starred" style={{ marginVertical: 4 }} />
              {store.starred.map(f => (
                <FoodRow
                  key={f.key}
                  food={f}
                  sub={f.portions?.[0]?.label}
                  right={f.portions?.[0] ? `${f.portions[0].kcal} kcal` : null}
                  onPress={() => pick(f)}
                />
              ))}
            </View>
          ) : null}

          {store.recent.length > 0 ? (
            <View style={{ gap: 6 }}>
              <ListHead icon={History} title="Recently eaten" style={{ marginVertical: 4 }} />
              {store.recent.slice(0, 20).map(r => (
                <FoodRow
                  key={r.key}
                  food={r.food}
                  sub={portionLabel(r.qty, r.portion)}
                  right={`${amountFor(r.portion, r.qty).kcal} kcal`}
                  onPress={() => pick(
                    { ...r.food, portions: r.portion ? [r.portion] : [] },
                    { portion: r.portion, qty: r.qty, meal: mealNow() },
                  )}
                />
              ))}
            </View>
          ) : null}

          <BigAction
            kind="subtle"
            icon={UtensilsCrossed}
            title="Restaurant menus"
            // Read off the catalog, so it never again names one chain when there are five.
            sub={restaurants.chains.map(c => c.short).join(', ') || 'No chain menus on this server yet'}
            onPress={() => router.push('/add/restaurant')}
          />

          <BigAction
            kind="subtle"
            icon={Carrot}
            title="Basic foods"
            sub={`${basics.foods.length || 150} generic foods — eggs, rice, a donut, a cheeseburger`}
            onPress={() => router.push('/add/basics')}
          />

          {!building ? (
            <BigAction
              kind="subtle"
              icon={BookMarked}
              title="Build a combo"
              sub="Your iced latte, your shake, your eggs — saved, one tap next time"
              onPress={() => buildCombo()}
            />
          ) : null}

          <BigAction
            kind="subtle"
            icon={ScanText}
            title="From a nutrition label"
            sub="Photograph the back of the package, or type what it says"
            onPress={() => openLabel(null)}
          />

          <BigAction
            kind="subtle"
            icon={PencilLine}
            title="Add it by hand"
            sub="No barcode, or something you made yourself"
            onPress={() => router.push('/add/manual')}
          />
        </>
      )}

      {/* The camera, full screen over the sheet. Backing out returns here. */}
      <ScannerModal
        visible={scanning}
        onClose={() => setScanning(false)}
        onCode={(code) => { setScanning(false); setTimeout(() => router.push({ pathname: '/add/result', params: { code } }), 350) }}
        onManual={() => { setScanning(false); setTimeout(() => router.push('/add/manual'), 350) }}
      />
    </Pane>
  )
}
