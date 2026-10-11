/*
 * Krakatoa — what a scan produced. ScanResult and the `lookup` from AddFlow in
 * app/src/add.jsx.
 *
 * The three outcomes are deliberately different screens, because "not in the
 * database", "the databases are down" and "that is not a barcode" have three
 * different fixes and one of them is just pressing retry. A hit goes straight on
 * to the detail screen, in this one's place.
 */

import React, { useCallback, useEffect, useState } from 'react'
import { View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { CircleAlert, RotateCw, ScanText } from '../../lib/icons'
import { apiFetch } from '../../lib/connection'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Spin } from '../../ui/kit'
import { CenterPane, Pane } from '../../ui/Pane'
import { warn } from '../../ui/haptics'
import { openLabel, pick } from './flow'

export default function ScanResult() {
  const { code = '' } = useLocalSearchParams<{ code: string }>()
  const [scan, setScan] = useState<{ status: 'looking' | 'done'; reason: string | null }>({ status: 'looking', reason: null })

  const lookup = useCallback(async () => {
    setScan({ status: 'looking', reason: null })
    try {
      const res = await apiFetch(`/api/lookup?code=${encodeURIComponent(code)}`)
      const body = await res.json()
      if (body.food) {
        pick(body.food, null, { replace: true })
      } else {
        warn()
        setScan({ status: 'done', reason: body.reason || 'not-found' })
      }
    } catch {
      setScan({ status: 'done', reason: 'sources-down' })
    }
  }, [code])

  useEffect(() => { void lookup() }, [lookup])

  if (scan.status === 'looking') {
    return (
      <CenterPane>
        <Spin size={32} color={colors.text} />
        <T>Looking up {code}…</T>
      </CenterPane>
    )
  }

  const reason = scan.reason
  const copy = reason === 'sources-down'
    ? { head: 'The food databases did not answer', body: 'Could be them, could be the network. The barcode is fine.', retry: true, label: false }
    : reason === 'not-a-barcode'
      ? { head: 'That is not a valid barcode', body: 'The check digit does not match, so it was misread or mistyped.', retry: false, label: false }
      : { head: 'Not in either database', body: 'Open Food Facts and USDA have both never heard of it. Photograph the nutrition label on the back and it fills itself in — and the next time you scan this barcode, it is there.', retry: false, label: true }

  return (
    <Pane title={code} onBack={() => router.back()} center>
      <CircleAlert size={32} color={colors.muted} />
      <T size={18} weight={700} align="center" style={{ marginTop: 4 }}>{copy.head}</T>
      <T muted align="center" style={{ maxWidth: 320 }}>{copy.body}</T>
      <View style={{ gap: 10, alignSelf: 'stretch', marginTop: 16 }}>
        {copy.retry ? <Btn icon={RotateCw} title="Try again" onPress={lookup} /> : null}
        {copy.label ? (
          <>
            <Btn kind="primary" icon={ScanText} title="Read the label" onPress={() => openLabel(code)} />
            <Btn title="Just the calories" onPress={() => router.push('/add/manual')} />
          </>
        ) : (
          <Btn kind="primary" title="Add it by hand" onPress={() => router.push('/add/manual')} />
        )}
      </View>
    </Pane>
  )
}
