// Cloudflare Access sessions end (24 hours by default). When Access starts
// answering instead of the server, offer to sign in again rather than letting
// every screen fail; the login page usually remembers the owner, so it is a tap.
// From Totem's app (mobile/src/shell/accessReauth.ts there).
import { useEffect, useRef } from 'react'
import { getConnection, saveAccessToken, useConnection } from '../lib/connection'
import { accessTokenExpiry, probeAccess, signInWithAccess } from '../lib/cfAccess'
import { pushToast, pushError, dismissToast } from '../lib/toast'
import { loadServerInfo } from '../lib/server'

let signingIn = false

export async function reauthAccess() {
  if (signingIn) return
  signingIn = true
  try {
    const { baseUrl } = getConnection()
    const guard = await probeAccess(baseUrl)
    if (!guard.protected) return
    const token = await signInWithAccess(baseUrl, guard.aud)
    if (!token) return
    await saveAccessToken(token)
    // The store pulls on its next beat; what the server says about itself is asked now.
    void loadServerInfo({ force: true })
  } catch (e: any) {
    pushError(`Cloudflare sign-in failed: ${e?.message || e}`)
  } finally {
    signingIn = false
  }
}

/** Mounted once in the signed-in app. */
export function useAccessReauth() {
  const { accessNeeded, accessToken } = useConnection()
  const toastId = useRef<number | null>(null)

  useEffect(() => {
    if (!accessNeeded) {
      if (toastId.current) { dismissToast(toastId.current); toastId.current = null }
      return
    }
    if (toastId.current) return
    toastId.current = pushToast('Cloudflare Access needs you to sign in again.', 'info', {
      duration: 0,
      action: { label: 'Sign in', icon: null, onClick: () => { toastId.current = null; void reauthAccess() } },
    })
  }, [accessNeeded])

  // A token that has already lapsed: ask now rather than after the first failure.
  useEffect(() => {
    if (accessToken && accessTokenExpiry(accessToken) && accessTokenExpiry(accessToken) < Date.now()) void reauthAccess()
  }, [accessToken])
}
