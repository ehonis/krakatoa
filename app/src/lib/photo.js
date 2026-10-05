/*
 * Krakatoa — a photo, made small enough to send. Used by the label reader and by
 * Ask AI.
 *
 * A phone photo is 3–12 MB. Labels and receipts are printed large enough that
 * 2000 px on the long side keeps every digit sharp, and at that size the upload
 * is a few hundred KB — which matters on a phone signal in a shop aisle.
 */

export async function shrink(file, max = 2000) {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('That file is not a photo this phone can open.'))
      i.src = url
    })
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.naturalWidth * k)
    canvas.height = Math.round(img.naturalHeight * k)
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.88))
    return {
      blob,
      dataUrl: canvas.toDataURL('image/jpeg', 0.88),
      preview: canvas.toDataURL('image/jpeg', 0.5),
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}
