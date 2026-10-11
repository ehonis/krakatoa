/*
 * Krakatoa — the little square beside a food. Ported from app/src/thumb.jsx.
 *
 * One component, used by the search results, the recents list and the day. At a
 * glance a photo is faster to recognise than a line of text, and the list he
 * re-logs from is mostly the same thirty things.
 *
 * Every food gets a square, photo or not. A list where some rows have a picture
 * and some rows have nothing does not line up, and a ragged left edge is harder
 * to scan than no pictures at all — so the fallback is a coloured letter tile
 * keyed to the name, which is stable enough to recognise on its own.
 *
 * The photo comes through the server's proxy with the session on the request
 * (connection.imageSource), and expo-image keeps it on disk, which is the phone's
 * stand-in for the web's service-worker cache.
 */

import React, { useState } from 'react'
import { Text, View } from 'react-native'
import { Image } from 'expo-image'
import { imageSource } from '../lib/connection'
import { imageUrl, tileHue, tileLetter, titleOf } from '../lib/food'
import { colors, tileColors } from '../theme'

export default function Thumb({ food, size = 44 }: { food: { name?: string | null; brand?: string | null; gtin?: string | null; image?: string | null; imageGtin?: string | null } | null | undefined; size?: number }) {
  // A combo or a logged dish borrows a component's photo, which loads by that
  // component's barcode.
  const src = imageUrl(food?.gtin ? food : food?.imageGtin ? { gtin: food.imageGtin, image: food.image } : null)
  // A photo that 404s — the product has none, or the CDN is unreachable — falls
  // back to the tile rather than leaving an empty square in the row.
  const [failed, setFailed] = useState(false)

  if (src && !failed) {
    return (
      <Image
        source={imageSource(src)}
        style={{ width: size, height: size, borderRadius: 10, backgroundColor: colors.panel2, opacity: 0.94 }}
        contentFit="cover"
        cachePolicy="disk"
        recyclingKey={src}
        transition={120}
        onError={() => setFailed(true)}
        accessibilityIgnoresInvertColors
      />
    )
  }

  /*
   * Both the colour and the letter come off the FULL title, brand included.
   * Taking the letter from the name alone rendered eight USDA yoghurts as eight
   * tiles reading "G", which is a placeholder that distinguishes nothing — the
   * brand is what tells them apart on screen and it is what tells them apart here.
   */
  const title = titleOf(food) || food?.name || ''
  const c = tileColors(tileHue(title))
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, borderRadius: 10, backgroundColor: c.background, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' }}
    >
      <Text style={{ color: c.color, fontWeight: '700', fontSize: Math.round(size * 0.42) }}>{tileLetter(title)}</Text>
    </View>
  )
}
