/*
 * Krakatoa — Ask AI. A receipt, a photo of the food, or just words, and a list to
 * review before anything is logged. Ported from app/src/ask.jsx (AskAI); the
 * conversation itself is ./Thread.tsx.
 *
 * Three screens: ASK (a photo and/or a sentence), WORKING (it takes 15–60 s, so the
 * screen says what it is doing), and REVIEW, where the rule of every other
 * AI-filled screen in this app holds: nothing it produced is logged until he
 * taps, every number says where it came from, and anything he changes is his.
 *
 * IN THE BACKGROUND. Every run is a THREAD the server works through by itself
 * (server/aithreads.js). This screen starts one and pushes it onto the add
 * sheet's stack; he can leave the moment he taps Send, and the answer is waiting
 * in the list — and on Today — when he comes back. On the web the thread was a
 * branch inside this component; here it is its own screen (/add/thread), so the
 * system back swipe returns to this list, which refreshes when it regains focus.
 *
 * What makes it trustworthy, in practice:
 *  - EXACT WHERE KRAKATOA KNOWS. His combos, the chain menus and the basics are
 *    matched and computed by the server; the model only guesses what nobody
 *    publishes, and those rows say "AI estimate" on them.
 *  - A CONVERSATION, NOT A VENDING MACHINE. "I only had half the fries" revises
 *    the list in place, keeping his ticks and his edits.
 *  - THE RIGHT ENDING. A restaurant receipt logs; a grocery receipt is things
 *    bought, not eaten; any list can be saved as a combo for next time.
 */

import React, { useCallback, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { Image } from 'expo-image'
import { router, useFocusEffect } from 'expo-router'
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable'
import { Pane } from '../../ui/Pane'
import { T } from '../../ui/Text'
import { BigAction, Btn, Chip, Chips, IconBtn, Input, ListHead, Press, Spin } from '../../ui/kit'
import { confirm } from '../../ui/menu'
import { colors, radius, alpha } from '../../theme'
import { Camera, ChevronRight, CircleAlert, ScanText, Sparkles, Trash2, X } from '../../lib/icons'
import { pickPhoto, shrink, type Shrunk } from '../../lib/photo'
import { openSettings, useServerInfo } from '../../lib/server'
import { imageSource } from '../../lib/connection'
import { deleteThread, photoUrl, startThread, useThreads, type ThreadSummary } from '../../lib/askapi'
import { openLabel } from '../add/flow'

const EXAMPLES = [
  '3 carne asada tacos and a large horchata from the taqueria',
  'my protein shake and a glazed donut',
  'a slice of pepperoni pizza and a can of Coke',
]

function StatusLine({ s }: { s: ThreadSummary }) {
  const color = s.status === 'error' ? colors.errorText : colors.muted
  let body: React.ReactNode
  if (s.status === 'working') {
    body = <><Spin size={12} /><T size={12} color={color}>Working…</T></>
  } else if (s.status === 'error') {
    body = <><CircleAlert size={12} color={color} /><T size={12} color={color}>Did not finish — open to try again</T></>
  } else {
    const what = s.items ? `${s.items} item${s.items === 1 ? '' : 's'} · ${(s.kcal || 0).toLocaleString()} kcal` : 'Nothing found'
    body = s.loggedAt
      ? <T size={12} color={color} numberOfLines={1}>Logged · {what}</T>
      : <>{!s.seenAt && <View style={st.dot} />}<T size={12} color={color} numberOfLines={1}>{what}</T></>
  }
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>{body}</View>
}

const when = (iso: string) => {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

const openThread = (id: string) => router.push({ pathname: '/add/thread', params: { id } })

/* One earlier conversation. Swiping left offers Delete — the phone's way to tidy a list. */
function ThreadRow({ s, onDeleted }: { s: ThreadSummary; onDeleted: () => void }) {
  const swipe = useRef<SwipeableMethods>(null)
  const remove = async () => {
    const ok = await confirm('Delete this conversation and its photo?', { message: 'Anything you logged from it stays logged.', confirmLabel: 'Delete' })
    if (!ok) { swipe.current?.close(); return }
    await deleteThread(s.id).catch(() => {})
    onDeleted()
  }
  const src = imageSource(photoUrl(s.photo))
  return (
    <ReanimatedSwipeable
      ref={swipe}
      friction={1.6}
      rightThreshold={48}
      renderRightActions={() => (
        <Press style={st.deleteAction} onPress={remove} accessibilityRole="button" accessibilityLabel={`Delete ${s.title}`}>
          <Trash2 size={20} color={colors.onDanger} />
          <T size={12} weight={600} color={colors.onDanger}>Delete</T>
        </Press>
      )}
    >
      <Press haptic style={st.row} onPress={() => openThread(s.id)} accessibilityRole="button">
        {src ? <Image source={src} style={st.rowPhoto} contentFit="cover" /> : <View style={[st.rowPhoto, st.rowIcon]}><Sparkles size={18} color={colors.ai} /></View>}
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T weight={700} numberOfLines={1}>{s.title}</T>
          <StatusLine s={s} />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <T size={12} muted>{when(s.updatedAt)}</T>
          <ChevronRight size={16} color={colors.muted} />
        </View>
      </Press>
    </ReanimatedSwipeable>
  )
}

/* Ask AI: something new at the top, every earlier conversation below it. */
export default function AskAI() {
  const [text, setText] = useState('')
  const [photo, setPhoto] = useState<Shrunk | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  // The preview keeps the photo's shape, as the web's <img> does under max-height.
  const [aspect, setAspect] = useState(3 / 4)
  const { threads, refresh } = useThreads()
  const info = useServerInfo()
  // Known to be off, not merely unknown: offline, the compose box still shows.
  const aiOff = info?.features && !info.features.ai

  // Back from a thread (deleted, logged, or still working): the list catches up.
  useFocusEffect(useCallback(() => { void refresh() }, [refresh]))

  const onPhoto = async () => {
    setError(null)
    try {
      const uri = await pickPhoto({ title: 'Add a photo' })
      if (uri) setPhoto(await shrink(uri))
    } catch (e: any) { setError(String(e?.message || e)) }
  }

  const send = async () => {
    setSending(true)
    setError(null)
    try {
      const d = await startThread({ text: text.trim(), image: photo?.dataUrl || null })
      setText('')
      setPhoto(null)
      openThread(d.thread.id)
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setSending(false)
    }
  }

  const ready = !!(text.trim() || photo)
  return (
    <Pane title="Ask AI" onBack={() => router.back()}>
      {aiOff ? (
        <View style={st.aiSetup}>
          <T size={14} muted lineHeight={21}><T size={14} weight={700}>AI is not set up on this server yet.</T> Ask AI reads a receipt, a plate or a sentence with the Claude Code CLI running on the server.</T>
          <Btn kind="primary" icon={Sparkles} title="Set up AI in Settings" onPress={() => openSettings('ai')} style={{ alignSelf: 'flex-start' }} />
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          {photo ? (
            <View style={{ alignSelf: 'center' }}>
              <Image
                source={{ uri: photo.uri }}
                style={[st.photo, { aspectRatio: aspect }]}
                contentFit="cover"
                accessibilityLabel="Your photo"
                onLoad={(e) => { if (e.source.width && e.source.height) setAspect(e.source.width / e.source.height) }}
              />
              <IconBtn icon={X} size={18} label="Remove the photo" onPress={() => setPhoto(null)} background="rgba(0, 0, 0, 0.6)" style={{ position: 'absolute', top: 6, right: 6 }} />
            </View>
          ) : (
            <BigAction icon={Camera} title="Add a photo" sub="A receipt, your plate, or a menu" onPress={onPhoto} />
          )}
          <Input
            multiline
            value={text}
            onChangeText={setText}
            placeholder={photo ? 'Anything to add — "I only had the burrito"' : `Or say what you had — "${EXAMPLES[0]}"`}
            textStyle={{ lineHeight: 22 }}
          />
          {!photo && !text && (
            <Chips>
              {EXAMPLES.slice(1).map(x => <Chip key={x} label={x} onPress={() => setText(x)} />)}
            </Chips>
          )}
          {error && (
            <View style={st.error}><CircleAlert size={14} color={colors.errorText} /><T size={13} color={colors.errorText} style={{ flexShrink: 1 }}>{error}</T></View>
          )}
          <Btn kind="primary" icon={Sparkles} loading={sending} disabled={!ready} title="Send" onPress={send} />
          <T size={12} muted lineHeight={19}>
            It works in the background — send it and go. Your combos, the chain menus and USDA foods are matched exactly; anything else is an estimate and says so; nothing is logged until you check it.
          </T>
        </View>
      )}

      {threads.length > 0 && (
        <View style={{ gap: 6 }}>
          <ListHead icon={Sparkles} title="Earlier" style={{ marginVertical: 4 }} />
          {threads.map(s => <ThreadRow key={s.id} s={s} onDeleted={() => { void refresh() }} />)}
        </View>
      )}

      <Press haptic onPress={() => openLabel(null)} accessibilityRole="button" style={st.labelLink}>
        <ScanText size={14} color={colors.muted} />
        <T size={13} weight={500} muted style={{ flexShrink: 1 }}>A nutrition label? The label form saves it with every number</T>
      </Press>
    </Pane>
  )
}

const st = StyleSheet.create({
  aiSetup: { alignItems: 'flex-start', gap: 8, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: radius.r, padding: 14 },
  photo: { height: 260, maxWidth: '100%', borderRadius: radius.r, borderWidth: 1, borderColor: colors.line },
  error: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingVertical: 10, paddingHorizontal: 14,
    borderWidth: 1, borderColor: colors.line, borderRadius: radius.r, backgroundColor: colors.panel,
  },
  rowPhoto: { width: 44, height: 44, borderRadius: 10 },
  rowIcon: { alignItems: 'center', justifyContent: 'center', backgroundColor: alpha(colors.aiLine, 0.14) },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.aiLine },
  deleteAction: { width: 84, marginLeft: 8, borderRadius: radius.r, backgroundColor: colors.danger, alignItems: 'center', justifyContent: 'center', gap: 2 },
  labelLink: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8 },
})
