/*
 * Krakatoa — the thing an overlay becomes on a desktop.
 *
 * On a phone this is a full-screen takeover and the only way out is the control
 * inside it, which is right: there is nowhere else to tap. On a desktop the same
 * markup is a dialog floating on a scrim, and a dialog that ignores Escape and
 * swallows a click on the backdrop is a dialog that feels broken — those two
 * gestures are how every other window on the machine closes.
 *
 * Both are wired unconditionally rather than behind a media query. A phone has
 * no Escape key and no backdrop to hit, so the cost of always having them is
 * nothing, and a `matchMedia` branch would be a second definition of "desktop"
 * that could drift from the stylesheet's.
 */

import { useEffect, useRef } from 'react'

export default function Overlay({ onClose, children }) {
  const scrim = useRef(null)

  useEffect(() => {
    if (!onClose) return undefined
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="overlay"
      ref={scrim}
      onMouseDown={(e) => {
        // Only a press that STARTS on the scrim closes it. Without that, a drag
        // that begins on a text selection inside the dialog and happens to end
        // outside it would throw away whatever he was typing.
        if (onClose && e.target === scrim.current) onClose()
      }}
    >
      {children}
    </div>
  )
}
