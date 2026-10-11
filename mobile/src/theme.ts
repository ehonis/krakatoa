// The web app's design tokens (app/src/styles.css :root), as one object.
// Keep the names the CSS uses so a value can be looked up in either direction:
// `--panel-2` is `colors.panel2`, `--tone-1` is `colors.tone1`.
import { StyleSheet } from 'react-native'

export const colors = {
  bg: '#0d0f12',
  panel: '#16191f',
  panel2: '#1e222a',
  line: '#2a2f39',
  text: '#f2f4f7',
  muted: '#98a2b3',

  accent: '#f59e0b', // krakatoa
  accentDim: '#78500a',
  tone1: '#5b8cff', // protein
  tone2: '#2dd4bf', // carbs
  tone3: '#f59e0b', // fat
  danger: '#f0506e',

  // Not tokens on the web, but repeated there as literals.
  onAccent: '#1a1204', // text on the amber fill (.btn-primary, .chip.on)
  onDanger: '#1a0409',
  water: '#2a93c9',
  waterDeep: '#1d5f8a',
  waterMet: '#2dd4bf',
  waterMetDeep: '#128a7d',
  burned: '#1c9e8f',
  ai: '#c4b5fd', // Ask AI's violet glyphs
  aiLine: '#a78bfa',
  errorText: '#fca5a5',
  warnText: '#fcd34d',
  basisGood: '#6ee7b7',
  // Toast fills (ToastHost.tsx): white text clears 5.4:1 on each.
  toastError: '#c42d4c',
  toastSuccess: '#1f7a34',
  toastInfo: '#3463d6',
  white: '#ffffff',
  black: '#000000',
} as const

/** Any hex colour at an alpha, for the CSS's rgba() tints. */
export function alpha(hex: string, a: number) {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

/** `--r` is 14px; panels use 18. */
export const radius = { r: 14, panel: 18, pill: 999 } as const

/** `--tap`: 44px minimum on anything tappable. */
export const TAP = 44

export const hairline = StyleSheet.hairlineWidth

/** The tile behind a food with no photo: `hsl(var(--tile-hue) …)` from .thumb-tile. */
export function tileColors(hue: number) {
  return {
    color: `hsl(${hue}, 70%, 88%)`,
    background: `hsl(${hue}, 45%, 22%)`,
    border: `hsl(${hue}, 45%, 30%)`,
  }
}
