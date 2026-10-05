/*
 * Krakatoa — Ask AI threads: the work happens here, not on his phone.
 *
 * The run used to live in the phone's request: back out and iOS drops the request, and the answer, fifty
 * seconds of it, went nowhere. So a request now CREATES A THREAD and returns at
 * once; the server runs it; the phone reads the thread whenever it is open.
 *
 * A thread is one file, data/ai/threads/<id>.json, holding what he sent (words,
 * a photo kept in data/ai/photos/), every answer, and his review draft — the
 * ticks, quantities and numbers he changed — so opening it again next week is
 * the list exactly as he left it. Threads are not log entries: nothing in one
 * counts toward a day until he taps Log, which writes ordinary entries.
 *
 * Crash-safe: a thread still "working" when the server starts is run again from
 * what it stored. Writes go through a temp file and a rename, as state.json's do.
 */

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')

function makeStore(dataDir) {
  const dir = path.join(dataDir, 'ai', 'threads')
  const photos = path.join(dataDir, 'ai', 'photos')
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(photos, { recursive: true })

  const file = (id) => path.join(dir, `${id.replace(/[^a-z0-9-]/gi, '')}.json`)

  async function read(id) {
    try { return JSON.parse(await fsp.readFile(file(id), 'utf8')) } catch { return null }
  }

  async function write(thread) {
    thread.updatedAt = new Date().toISOString()
    const f = file(thread.id)
    await fsp.writeFile(`${f}.tmp`, JSON.stringify(thread, null, 1))
    await fsp.rename(`${f}.tmp`, f)
    return thread
  }

  async function list() {
    const names = (await fsp.readdir(dir).catch(() => [])).filter(n => n.endsWith('.json'))
    const out = []
    for (const n of names) {
      try { out.push(JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8'))) } catch { /* a half-written file is skipped, not fatal */ }
    }
    return out.filter(t => !t.deleted).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async function savePhoto(threadId, buf) {
    const name = `${threadId}-${crypto.randomBytes(3).toString('hex')}.jpg`
    await fsp.writeFile(path.join(photos, name), buf)
    return name
  }

  const photoPath = (name) => path.join(photos, String(name).replace(/[^a-z0-9.-]/gi, ''))

  async function remove(id) {
    const t = await read(id)
    if (!t) return false
    for (const turn of t.turns || []) {
      if (turn.photo) await fsp.rm(photoPath(turn.photo), { force: true })
    }
    await fsp.rm(file(id), { force: true })
    return true
  }

  return { read, write, list, savePhoto, photoPath, remove }
}

const newId = () => `ask-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`

/** What the thread list shows: small, and enough to decide whether to open it. */
function summaryOf(t) {
  const last = [...(t.turns || [])].reverse().find(x => x.role === 'ai' && x.answer)
  const items = t.draft?.items || last?.answer?.items || []
  const on = items.filter(i => (i.on ?? i.eaten) !== false)
  const kcal = Math.round(on.reduce((n, i) => n + (i.per?.kcal || 0) * (Number(i.qty) || 0), 0))
  const firstYou = (t.turns || []).find(x => x.role === 'you')
  return {
    id: t.id,
    title: t.title || last?.answer?.place || firstYou?.text?.slice(0, 60) || (firstYou?.photo ? 'A photo' : 'Ask AI'),
    status: t.status,
    error: t.error || null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    kind: last?.answer?.kind || null,
    place: last?.answer?.place || null,
    items: on.length,
    kcal,
    photo: firstYou?.photo || null,
    loggedAt: t.loggedAt || null,
    seenAt: t.seenAt || null,
  }
}

/**
 * The runner: one queue, two at a time, in the server process. `run(thread,
 * turn)` is whatever produces an answer (server.js passes ai.askMeal wired to
 * the food table); this owns the bookkeeping around it — status, errors, the
 * restart recovery — so a thread's file always says what is happening to it.
 */
function makeRunner({ store, run, concurrency = 2, log = console.log }) {
  const queue = []
  let active = 0

  function pump() {
    while (active < concurrency && queue.length) {
      const id = queue.shift()
      active++
      work(id).finally(() => { active--; pump() })
    }
  }

  async function work(id) {
    const t = await store.read(id)
    if (!t || t.status !== 'working') return
    const turn = [...t.turns].reverse().find(x => x.role === 'you')
    const started = Date.now()
    try {
      const answer = await run(t, turn)
      const fresh = (await store.read(id)) || t
      if (fresh.deleted) return
      fresh.turns.push({ role: 'ai', at: new Date().toISOString(), answer })
      fresh.status = 'ready'
      fresh.error = null
      // A fresh answer replaces the draft: his edits went up WITH the request as
      // `previous`, so the answer already carries them.
      fresh.draft = null
      fresh.seenAt = null
      if (!fresh.title && answer.place) fresh.title = answer.place
      await store.write(fresh)
      log(`[krakatoa] ask ${id}: ${answer.kind}, ${answer.items?.length ?? 0} items in ${Date.now() - started} ms`)
    } catch (e) {
      const fresh = (await store.read(id)) || t
      fresh.status = 'error'
      fresh.error = String(e.message || e)
      await store.write(fresh)
      log(`[krakatoa] ask ${id} failed: ${fresh.error}`)
    }
  }

  return {
    enqueue(id) { if (!queue.includes(id)) queue.push(id); pump() },
    /* Anything left "working" by a restart is run again from what it stored. */
    async recover() {
      const stuck = (await store.list()).filter(t => t.status === 'working')
      for (const t of stuck) this.enqueue(t.id)
      return stuck.length
    },
    get busy() { return active + queue.length },
  }
}

module.exports = { makeStore, makeRunner, newId, summaryOf }
