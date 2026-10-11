// Text in the system face, as the web uses (-apple-system). Defaults match the
// web body (16px/1.45, --text); pass `muted` for --muted, `tabular` for the
// `font-variant-numeric: tabular-nums` every number on the web carries, and
// `caps` for the small uppercase headings (.list-head, .meal-head, .panel-head).
import React from 'react'
import { Text as RNText, type TextProps, type TextStyle } from 'react-native'
import { colors } from '../theme'

export interface TProps extends TextProps {
  size?: number
  weight?: 400 | 500 | 600 | 700 | 800 | 900
  color?: string
  muted?: boolean
  tabular?: boolean
  caps?: boolean
  italic?: boolean
  align?: TextStyle['textAlign']
  lineHeight?: number
}

export function T({ size = 16, weight, color, muted, tabular, caps, italic, align, lineHeight, style, ...rest }: TProps) {
  return (
    <RNText
      {...rest}
      style={[
        {
          fontSize: size,
          lineHeight: lineHeight ?? Math.round(size * 1.4),
          color: color || (muted ? colors.muted : colors.text),
          textAlign: align,
          fontWeight: weight ? (String(weight) as TextStyle['fontWeight']) : undefined,
          fontVariant: tabular ? ['tabular-nums'] : undefined,
          fontStyle: italic ? 'italic' : undefined,
        },
        caps ? { textTransform: 'uppercase', letterSpacing: size * 0.06 } : null,
        style,
      ]}
    />
  )
}
