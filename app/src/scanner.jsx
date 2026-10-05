/*
 * Krakatoa — the camera.
 *
 * Two decoders, in order of what the device has:
 *
 *   1. `BarcodeDetector`, the native one. Chrome and Android have it; Safari does
 *      NOT, and this app's main device is an installed PWA on iOS — so the native
 *      path is the bonus, never the plan.
 *   2. zxing-wasm, which is the plan. The .wasm is imported through Vite with
 *      `?url` so it is served from this origin and cached by the service worker;
 *      left to itself the library fetches it from a CDN, which would make the
 *      scanner the one screen that needs the public internet.
 *
 * Worth knowing when it does not work: `getUserMedia` requires a SECURE context.
 * An https address is fine and so is localhost, but reaching the server by a bare
 * IP over plain http gives you a camera that silently never starts.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader'
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'
import { X, Zap, ZapOff, Keyboard } from 'lucide-react'

prepareZXingModule({
  overrides: { locateFile: (file, prefix) => (file.endsWith('.wasm') ? wasmUrl : `${prefix}${file}`) },
})

/* The formats on food. Asking for QR and the rest as well costs frame rate and
 * finds marketing URLs, which are never the thing being scanned here. */
const FORMATS = ['EAN-13', 'EAN-8', 'UPC-A', 'UPC-E', 'ITF', 'DataBar', 'DataBarExpanded']

/** The native decoder, if this browser has one and supports our formats. */
async function nativeDetector() {
  if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return null
  try {
    const supported = await window.BarcodeDetector.getSupportedFormats()
    const want = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf'].filter(f => supported.includes(f))
    return want.length ? new window.BarcodeDetector({ formats: want }) : null
  } catch {
    return null
  }
}

export default function Scanner({ onCode, onClose, onManual }) {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const doneRef = useRef(false)
  const [error, setError] = useState(null)
  const [ready, setReady] = useState(false)
  const [torch, setTorch] = useState(null) // null = the device has no torch

  const stop = useCallback(() => {
    doneRef.current = true
    for (const track of streamRef.current?.getTracks() || []) track.stop()
    streamRef.current = null
  }, [])

  const hit = useCallback((raw) => {
    if (doneRef.current) return
    doneRef.current = true
    // A short buzz, where the hardware does it. The scan succeeding is the one
    // moment in this app worth feeling rather than reading.
    try { navigator.vibrate?.(40) } catch { /* not everywhere, never important */ }
    stop()
    onCode(String(raw).trim())
  }, [onCode, stop])

  useEffect(() => {
    let raf = 0
    let detector = null

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError(window.isSecureContext === false
          ? 'The camera needs a secure connection. Open the app over https rather than by IP address.'
          : 'This browser will not give the page a camera.')
        return
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        })
        streamRef.current = stream
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        // iOS will not autoplay an inline video without both of these set.
        video.setAttribute('playsinline', 'true')
        video.muted = true
        await video.play()
        setReady(true)

        const track = stream.getVideoTracks()[0]
        if (track?.getCapabilities?.().torch) setTorch(false)

        detector = await nativeDetector()
        tick()
      } catch (e) {
        setError(e?.name === 'NotAllowedError'
          ? 'Camera permission was refused. Allow it in the browser settings and reopen.'
          : `Could not start the camera — ${e?.message || e}`)
      }
    }

    async function tick() {
      if (doneRef.current) return
      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas || video.readyState < 2) {
        raf = requestAnimationFrame(tick)
        return
      }
      try {
        if (detector) {
          const found = await detector.detect(video)
          if (found?.length) return hit(found[0].rawValue)
        } else {
          /*
           * The middle band only. A barcode is held across the centre of the
           * frame, and handing the decoder a 1080p still every frame is what
           * makes a wasm scanner feel slow — this is about a fifth of the pixels
           * and it is where the barcode is.
           */
          const w = video.videoWidth
          const h = video.videoHeight
          if (!w || !h) { raf = requestAnimationFrame(tick); return }
          const bandH = Math.floor(h * 0.4)
          const y = Math.floor((h - bandH) / 2)
          canvas.width = w
          canvas.height = bandH
          const ctx = canvas.getContext('2d', { willReadFrequently: true })
          ctx.drawImage(video, 0, y, w, bandH, 0, 0, w, bandH)
          const image = ctx.getImageData(0, 0, w, bandH)
          const results = await readBarcodes(image, {
            formats: FORMATS,
            tryHarder: true,
            // A barcode held sideways is the normal way a bottle is scanned.
            tryRotate: true,
            tryInvert: false,
            maxNumberOfSymbols: 1,
          })
          const good = results?.find(r => r.isValid !== false && r.text)
          if (good) return hit(good.text)
        }
      } catch { /* a bad frame is not an error, it is the next frame */ }
      if (!doneRef.current) raf = requestAnimationFrame(tick)
    }

    start()
    return () => { cancelAnimationFrame(raf); stop() }
  }, [hit, stop])

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks?.()[0]
    if (!track) return
    const next = !torch
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] })
      setTorch(next)
    } catch { /* the capability lied; leave the button where it was */ }
  }

  return (
    <div className="scan">
      <video ref={videoRef} className="scan-video" playsInline muted />
      <canvas ref={canvasRef} hidden />

      <div className="scan-mask">
        <div className="scan-window">
          <span className="scan-line" />
        </div>
        <p className="scan-hint">
          {error ? '' : ready ? 'Point at the barcode' : 'Starting the camera…'}
        </p>
      </div>

      {error && (
        <div className="scan-error">
          <p>{error}</p>
          <button className="btn" onClick={onManual}>Type the barcode instead</button>
        </div>
      )}

      <div className="scan-bar">
        <button className="icon-btn" onClick={() => { stop(); onClose() }} aria-label="Close">
          <X size={24} />
        </button>
        {/* A supermarket aisle is bright; a kitchen cupboard at 10pm is not. */}
        {torch !== null && (
          <button className="icon-btn" onClick={toggleTorch} aria-label="Torch">
            {torch ? <Zap size={24} /> : <ZapOff size={24} />}
          </button>
        )}
        <button className="icon-btn" onClick={onManual} aria-label="Type it in">
          <Keyboard size={24} />
        </button>
      </div>
    </div>
  )
}
