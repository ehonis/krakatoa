/*
 * Leaving an old hostname without leaving anything behind.
 *
 * localStorage belongs to an ORIGIN, so a phone that logged offline under an old
 * hostname holds those entries where only a page running on that hostname can
 * read them. An edge redirect would never run that page again and they would be
 * stranded. So the old hostname keeps serving the app, and the app hands off:
 * push the whole local log (the server merges newest-wins, so pushing everything
 * is safe), then move to the new hostname. Offline, it stays put and works as
 * normal until the next push succeeds.
 *
 * Off unless configured at BUILD time:
 *   VITE_KRAKATOA_LEGACY_HOSTS="old.example.com=new.example.com,other.example=new.example.com"
 * (in app/.env.local, or the environment of `npm run build`).
 */

/** "a=b, c=d" -> { a: 'b', c: 'd' }. Anything malformed is ignored. */
export function parseLegacyHosts(spec) {
  const out = {}
  for (const pair of String(spec || '').split(',')) {
    const [from, to] = pair.split('=').map(x => (x || '').trim().toLowerCase())
    if (from && to && /^[a-z0-9.-]+$/.test(from) && /^[a-z0-9.-]+$/.test(to) && from !== to) out[from] = to
  }
  return out
}

const MOVED = parseLegacyHosts(import.meta.env?.VITE_KRAKATOA_LEGACY_HOSTS)

/** Where this page should move to after its push, or null when it is already home. */
export function handoffTarget(loc, moved = MOVED) {
  const to = moved[String(loc?.hostname || '').toLowerCase()]
  return to ? `https://${to}${loc.pathname || '/'}${loc.search || ''}${loc.hash || ''}` : null
}
