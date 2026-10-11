// The add sheet: AddFlow (app/src/add.jsx) as a native stack inside one page
// sheet, so each of the web's views is a push with the system back swipe. What
// the views share lives in features/add/flow.ts.
//
// `anchor: 'index'` keeps the add screen under whatever the sheet opens on, so
// opening straight at a combo, a relog or a barcode still has "Add food" behind
// it, as the web's views go back to `home`.
import React, { useEffect } from 'react'
import { Stack, useNavigation } from 'expo-router'
import { registerClose } from '../../features/add/flow'
import { colors } from '../../theme'

export const unstable_settings = { anchor: 'index' }

export default function AddLayout() {
  // This layout's navigation is the root stack's view of the sheet; going back
  // there closes the whole sheet, from any depth.
  const navigation = useNavigation()
  useEffect(() => {
    registerClose(() => navigation.goBack())
    return () => registerClose(null)
  }, [navigation])
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
}
