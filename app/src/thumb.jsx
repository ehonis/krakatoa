/*
 * Krakatoa — the little square beside a food.
 *
 * One component, used by the search results, the recents list and the day. It is
 * the whole answer to "next time it's easy to see what food for quick adding":
 * at a glance a photo is faster to recognise than a line of text, and the list
 * he re-logs from is mostly the same thirty things.
 *
 * Every food gets a square, photo or not. A list where some rows have a picture
 * and some rows have nothing does not line up, and a ragged left edge is harder
 * to scan than no pictures at all — so the fallback is a coloured letter tile
 * keyed to the name, which is stable enough to recognise on its own.
 */

import { useState } from 'react'
import { imageUrl, tileHue, tileLetter, titleOf } from './lib/food.js'

export default function Thumb({ food, size = 44 }) {
  const src = imageUrl(food)
  // A photo that 404s — the product has none, or the CDN is unreachable — falls
  // back to the tile rather than leaving a broken-image glyph in the row.
  const [failed, setFailed] = useState(false)
  const style = { width: size, height: size }

  if (src && !failed) {
    return (
      <img
        className="thumb"
        style={style}
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
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
  return (
    <span
      className="thumb thumb-tile"
      style={{ ...style, '--tile-hue': tileHue(title), fontSize: Math.round(size * 0.42) }}
      aria-hidden="true"
    >
      {tileLetter(title)}
    </span>
  )
}
