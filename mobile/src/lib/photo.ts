/*
 * Krakatoa — a photo, made small enough to send. Used by the label reader and by
 * Ask AI. Ported from app/src/lib/photo.js, which draws to a canvas; here
 * expo-image-manipulator does the same resize and JPEG.
 *
 * A phone photo is 3–12 MB. Labels and receipts are printed large enough that
 * 2000 px on the long side keeps every digit sharp, and at that size the upload
 * is a few hundred KB — which matters on a phone signal in a shop aisle.
 *
 * Where the web's <input type="file"> offers the camera and the library in one
 * sheet, the phone asks which (pickPhoto): the label he photographed in the shop
 * is in the library.
 */

import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'
import { showMenu } from '../ui/menu'

export interface Shrunk {
  /** The JPEG on disk, for an <Image> preview. */
  uri: string
  base64: string
  /** `data:image/jpeg;base64,…`, which /api/ask takes as `image`. */
  dataUrl: string
}

export async function shrink(uri: string, max = 2000): Promise<Shrunk> {
  const ctx = ImageManipulator.manipulate(uri)
  const original = await ctx.renderAsync()
  const k = Math.min(1, max / Math.max(original.width, original.height))
  const ref = k < 1
    ? await ImageManipulator.manipulate(uri).resize(original.width >= original.height ? { width: Math.round(original.width * k) } : { height: Math.round(original.height * k) }).renderAsync()
    : original
  const out = await ref.saveAsync({ format: SaveFormat.JPEG, compress: 0.88, base64: true })
  if (!out.base64) throw new Error('That file is not a photo this phone can open.')
  return { uri: out.uri, base64: out.base64, dataUrl: `data:image/jpeg;base64,${out.base64}` }
}

/** The JPEG's bytes, for /api/label, which takes the photo as the whole body. */
export function bytesOf(base64: string): Uint8Array {
  const bin = atob(base64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Take a photo or pick one: a system menu with both, then the system camera or
 * library. Resolves the picked file's uri, or null when he backs out. Throws with
 * a sentence when permission was refused.
 */
export function pickPhoto({ title }: { title?: string } = {}): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const run = async (from: 'camera' | 'library') => {
      try {
        if (from === 'camera') {
          const p = await ImagePicker.requestCameraPermissionsAsync()
          if (!p.granted) throw new Error('Camera permission was refused. Allow it in Settings → Krakatoa.')
        }
        const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1, allowsEditing: false, exif: false }
        const res = from === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options)
        resolve(res.canceled ? null : res.assets?.[0]?.uri || null)
      } catch (e) {
        reject(e)
      }
    }
    showMenu([
      { label: 'Take a photo', onPress: () => { void run('camera') } },
      { label: 'Choose from library', onPress: () => { void run('library') } },
    ], { title, onCancel: () => resolve(null) })
  })
}
