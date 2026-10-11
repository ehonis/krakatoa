// The web app's icons (lucide-react, app/src/*.jsx), from lucide-react-native: the
// same glyphs under the same names, drawn with react-native-svg. Each is imported
// per icon (`lucide-react-native/icons/<name>`, the package's own subpath, one
// file and a default export) so the 3,700-icon package never lands in the bundle
// whole. A name the web uses that lucide has since renamed points at the new file
// (BookMarked is book-bookmark now, Loader2 is loader-circle).
//
// To add one: confirm the file exists
//   ls node_modules/lucide-react-native/dist/esm/icons | grep -i <term>
// then add a line here under the web's name.
import type { ComponentType } from 'react'
import type { ColorValue, StyleProp, ViewStyle } from 'react-native'

import BookMarked from 'lucide-react-native/icons/book-bookmark'
import CalendarDays from 'lucide-react-native/icons/calendar-days'
import Camera from 'lucide-react-native/icons/camera'
import Carrot from 'lucide-react-native/icons/carrot'
import Check from 'lucide-react-native/icons/check'
import ChevronDown from 'lucide-react-native/icons/chevron-down'
import ChevronLeft from 'lucide-react-native/icons/chevron-left'
import ChevronRight from 'lucide-react-native/icons/chevron-right'
import CircleAlert from 'lucide-react-native/icons/circle-alert'
import CircleCheck from 'lucide-react-native/icons/circle-check'
import CloudOff from 'lucide-react-native/icons/cloud-off'
import Copy from 'lucide-react-native/icons/copy'
import Droplet from 'lucide-react-native/icons/droplet'
import Ellipsis from 'lucide-react-native/icons/ellipsis'
import FileText from 'lucide-react-native/icons/file-text'
import Flame from 'lucide-react-native/icons/flame'
import Globe from 'lucide-react-native/icons/globe'
import History from 'lucide-react-native/icons/rotate-ccw-clock'
import Images from 'lucide-react-native/icons/images'
import KeyRound from 'lucide-react-native/icons/key-round'
import Keyboard from 'lucide-react-native/icons/keyboard'
import Loader2 from 'lucide-react-native/icons/loader-circle'
import LogOut from 'lucide-react-native/icons/log-out'
import Minus from 'lucide-react-native/icons/minus'
import PencilLine from 'lucide-react-native/icons/pencil-line'
import Plug from 'lucide-react-native/icons/plug'
import Plus from 'lucide-react-native/icons/plus'
import RefreshCw from 'lucide-react-native/icons/refresh-cw'
import RotateCw from 'lucide-react-native/icons/rotate-cw'
import ScanBarcode from 'lucide-react-native/icons/scan-barcode'
import ScanText from 'lucide-react-native/icons/scan-text'
import Search from 'lucide-react-native/icons/search'
import Send from 'lucide-react-native/icons/send'
import Server from 'lucide-react-native/icons/server'
import Settings from 'lucide-react-native/icons/settings'
import ShieldCheck from 'lucide-react-native/icons/shield-check'
import Sparkles from 'lucide-react-native/icons/sparkles'
import Star from 'lucide-react-native/icons/star'
import Target from 'lucide-react-native/icons/target'
import Trash2 from 'lucide-react-native/icons/trash'
import TrendingDown from 'lucide-react-native/icons/trending-down'
import TrendingUp from 'lucide-react-native/icons/trending-up'
import Undo2 from 'lucide-react-native/icons/undo-2'
import Utensils from 'lucide-react-native/icons/utensils'
import UtensilsCrossed from 'lucide-react-native/icons/utensils-crossed'
import Wheat from 'lucide-react-native/icons/wheat'
import X from 'lucide-react-native/icons/x'
import Zap from 'lucide-react-native/icons/zap'
import ZapOff from 'lucide-react-native/icons/zap-off'

export type IconType = ComponentType<{ size?: number; color?: ColorValue; strokeWidth?: number; fill?: ColorValue; style?: StyleProp<ViewStyle> }>

export {
  BookMarked,
  CalendarDays,
  Camera,
  Carrot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CloudOff,
  Copy,
  Droplet,
  Ellipsis,
  FileText,
  Flame,
  Globe,
  History,
  Images,
  KeyRound,
  Keyboard,
  Loader2,
  LogOut,
  Minus,
  PencilLine,
  Plug,
  Plus,
  RefreshCw,
  RotateCw,
  ScanBarcode,
  ScanText,
  Search,
  Send,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  Target,
  Trash2,
  TrendingDown,
  TrendingUp,
  Undo2,
  Utensils,
  UtensilsCrossed,
  Wheat,
  X,
  Zap,
  ZapOff,
}
