// The "…" menus and confirms, as the platform's own sheets: iOS action sheet,
// Alert elsewhere. Use these instead of drawing popovers, so a menu looks and
// dismisses the way every other app's does.
import { ActionSheetIOS, Alert, Platform } from 'react-native'
import { tap, warn } from './haptics'

export interface MenuItem {
  label: string
  onPress: () => void
  destructive?: boolean
}

/** Show a list of actions. A Cancel row is added; `onCancel` hears it. */
export function showMenu(items: MenuItem[], { title, message, onCancel }: { title?: string; message?: string; onCancel?: () => void } = {}) {
  tap()
  if (Platform.OS === 'ios') {
    const options = [...items.map((i) => i.label), 'Cancel']
    const destructiveButtonIndex = items.map((i, n) => (i.destructive ? n : -1)).filter((n) => n >= 0)
    ActionSheetIOS.showActionSheetWithOptions(
      { options, cancelButtonIndex: items.length, destructiveButtonIndex, title, message, userInterfaceStyle: 'dark' },
      (n) => { if (n < items.length) items[n].onPress(); else onCancel?.() },
    )
    return
  }
  Alert.alert(title || '', message, [
    ...items.map((i) => ({ text: i.label, onPress: i.onPress, style: i.destructive ? ('destructive' as const) : ('default' as const) })),
    { text: 'Cancel', style: 'cancel' as const, onPress: onCancel },
  ], { cancelable: true, onDismiss: onCancel })
}

/** "Delete this?" with a red confirm. Resolves true when confirmed. */
export function confirm(title: string, { message, confirmLabel = 'Delete', cancelLabel = 'Cancel', destructive = true }: { message?: string; confirmLabel?: string; cancelLabel?: string; destructive?: boolean } = {}): Promise<boolean> {
  if (destructive) warn()
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: cancelLabel, style: 'cancel', onPress: () => resolve(false) },
      { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false), userInterfaceStyle: 'dark' })
  })
}

/** A one-line text prompt (a barcode typed in). iOS only natively; elsewhere resolves null. */
export function prompt(title: string, { message, defaultValue = '', okLabel = 'Save', keyboardType }: { message?: string; defaultValue?: string; okLabel?: string; keyboardType?: 'default' | 'number-pad' } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    if (Platform.OS !== 'ios') { resolve(null); return }
    Alert.prompt(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
      { text: okLabel, onPress: (v?: string) => resolve((v ?? '').trim() || null) },
    ], 'plain-text', defaultValue, keyboardType, { userInterfaceStyle: 'dark' } as any)
  })
}
