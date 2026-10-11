/*
 * Krakatoa — chain menus: Chipotle, and the rest. RestaurantSearch from
 * app/src/add.jsx.
 *
 * A separate screen from the main search because the Nutritionix source costs a
 * METERED API call: folding it into the debounced grocery search would spend a
 * day's free quota on a morning of typing.
 *
 * A row arrives with calories only (`partial`), because Nutritionix gives macros
 * one item at a time. Tapping fetches the full one, which is also when it gets
 * cached — so a bowl he eats weekly costs one call ever.
 */

import React, { useEffect, useState } from 'react'
import { View } from 'react-native'
import { router } from 'expo-router'
import { BookMarked, CircleAlert, UtensilsCrossed } from '../../lib/icons'
import { useRestaurants, type Chain } from '../../lib/restaurants'
import { apiFetch } from '../../lib/connection'
import type { Food } from '../../lib/types'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { BigAction, Btn, Field, FilledNote, ListHead, RowNote, SearchBox } from '../../ui/kit'
import { Pane } from '../../ui/Pane'
import FoodRow from './FoodRow'
import { buildCombo, pick, setFlow } from './flow'

/** Inline `code` in a muted note, as the web's .small-note code. */
const Code = ({ children }: { children: string }) => (
  <T size={11} color={colors.text} style={{ fontFamily: 'Menlo', backgroundColor: colors.panel2 }}>{` ${children} `}</T>
)

export default function RestaurantSearch() {
  const { chains } = useRestaurants()
  const [q, setQ] = useState('')
  // `configured: null` means NOT YET KNOWN. Starting it at `true` showed a search
  // box to someone with no key, who would then type, get nothing back, and have
  // no idea why — the setup steps have to be the first thing on the screen, not
  // the consolation prize after a failed search.
  const [state, setState] = useState<{ status: string; foods: Food[]; configured: boolean | null; error: string | null }>({ status: 'idle', foods: [], configured: null, error: null })
  const [loading, setLoading] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    // Costs no API call: the server answers this from the presence of a key.
    apiFetch('/api/restaurant?q=')
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
        const res = await apiFetch(`/api/restaurant?q=${encodeURIComponent(query)}`)
        const body = await res.json()
        setState({ status: 'done', foods: body.foods || [], configured: body.configured, error: body.error || null })
      } catch (e: any) {
        setState({ status: 'done', foods: [], configured: true, error: String(e?.message || e) })
      }
    }, 400)
    return () => clearTimeout(t)
  }, [q])

  /* A partial row cannot be logged — fetch the macros before going on. */
  const take = async (food: Food) => {
    if (!food.partial) { pick(food); return }
    setLoading(food.nixItemId)
    try {
      const res = await apiFetch(`/api/restaurant/item?id=${encodeURIComponent(food.nixItemId)}`)
      const body = await res.json()
      if (body.food) pick(body.food)
    } catch { /* leave him on the list rather than opening an empty food */ } finally {
      setLoading(null)
    }
  }

  const openChain = (c: Chain) => { setFlow({ chain: c }); router.push('/add/bowl') }

  return (
    <Pane title="Restaurant menus" onBack={() => router.back()} scrollProps={{ keyboardDismissMode: 'on-drag' }}>
      {/*
        Chains with a menu here, first. These are generated from each chain's
        own nutrition data (scripts/restaurants.build.mjs), need no key, and work
        offline — which is why they lead, above everything that does not.
      */}
      {chains.length === 0 ? (
        <T size={12} muted lineHeight={19}>
          No chain menus are built on this server. They are optional; the server's
          owner can generate them (see Restaurant menus in docs/self-hosting.md).
          Ask AI can still learn a chain from its own nutrition page.
        </T>
      ) : null}
      {chains.length > 0 ? (
        <View style={{ gap: 6 }}>
          <ListHead icon={UtensilsCrossed} title="Menus" style={{ marginVertical: 4 }} />
          {chains.map(c => (
            <BigAction
              key={c.id}
              icon={UtensilsCrossed}
              title={c.name}
              sub={`${c.kind === 'order' ? 'Build an order' : 'Build a bowl'} · ${c.items.length} items, from ${c.source?.what || 'their own nutrition data'}`}
              onPress={() => openChain(c)}
            />
          ))}
        </View>
      ) : null}

      <ListHead title="Other chains" style={{ marginVertical: 4, marginBottom: -10 }} />
      {state.configured === null ? (
        <RowNote spin>Checking…</RowNote>
      ) : state.configured === false ? (
        /*
         * Nutritionix CLOSED its free tier on 2026-09-22 — "Free public trials
         * for the Nutritionix API are no longer available", business accounts
         * only. So this screen no longer sends anyone to a signup that will
         * turn them away; it names the one thing that does work today and is one tap
         * from here. The integration itself is kept: it lights up the moment
         * credentials exist, and nothing else in the app depends on it.
         */
        <Field>
          <FilledNote icon={CircleAlert}>
            <T size={13} weight={700} color={colors.text}>There is no free database of chain menus any more.</T> Nutritionix
            closed its free tier, and MenuStat, Open Food Facts and USDA were
            all checked — none carry restaurant chains. A chain gets a menu
            here by having its own nutrition PDF read in, which is how
            Bibibop is above.
          </FilledNote>

          <T muted>
            What works: get the numbers once from the chain's own nutrition
            page, build it here as a combo, and it is one tap forever after. A
            Chipotle bowl is the same bowl every time.
          </T>

          <Btn kind="primary" icon={BookMarked} title="Build it as a combo" onPress={() => buildCombo()} />

          <T size={12} muted lineHeight={19}>
            If you ever get Nutritionix business credentials, put
            <Code>nutritionixId</Code>and<Code>nutritionixKey</Code>in
            <Code>data/config.json</Code>and this screen becomes a search.
          </T>
        </Field>
      ) : (
        <>
          <SearchBox value={q} onChangeText={setQ} autoFocus placeholder="chipotle chicken bowl, big mac…" label="Search restaurant menus" />

          {state.error ? <RowNote icon={CircleAlert}>{state.error}</RowNote> : null}
          {state.status === 'searching' ? <RowNote spin>Searching…</RowNote> : null}
          {state.status === 'done' && !state.foods.length && !state.error ? <RowNote>Nothing on the menus matches that.</RowNote> : null}

          <View style={{ gap: 6 }}>
            {state.foods.map(f => (
              <FoodRow
                key={f.nixItemId}
                food={f}
                sub={loading === f.nixItemId ? 'Getting the macros…' : f.portions[0]?.label}
                right={`${f.portions[0]?.kcal} kcal`}
                onPress={() => take(f)}
              />
            ))}
          </View>
        </>
      )}
    </Pane>
  )
}
