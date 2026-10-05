// The old-hostname handoff: only a configured old host moves, and it keeps its place.
import assert from 'node:assert/strict'
import { handoffTarget, parseLegacyHosts } from './src/lib/handoff.js'

const moved = parseLegacyHosts('old.example.com=new.example.com, junk, =x.example, a.example=a.example')
assert.deepEqual(moved, { 'old.example.com': 'new.example.com' })
assert.equal(handoffTarget({ hostname: 'new.example.com', pathname: '/' }, moved), null)
assert.equal(handoffTarget({ hostname: '192.0.2.10', pathname: '/' }, moved), null)
assert.equal(handoffTarget({ hostname: 'localhost', pathname: '/' }, moved), null)
assert.equal(handoffTarget({ hostname: 'old.example.com', pathname: '/', search: '', hash: '' }, moved), 'https://new.example.com/')
assert.equal(handoffTarget({ hostname: 'OLD.example.com', pathname: '/day', search: '?d=2026-10-01', hash: '#x' }, moved), 'https://new.example.com/day?d=2026-10-01#x')
assert.equal(handoffTarget(undefined, moved), null)
// Unconfigured (the default build): nothing ever moves.
assert.equal(handoffTarget({ hostname: 'old.example.com', pathname: '/' }), null)
assert.deepEqual(parseLegacyHosts(undefined), {})
console.log('handoff: 9 passed')
