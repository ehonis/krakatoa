/*
 * Krakatoa — build a food from its Nutrition Facts label. Ported from
 * app/src/labelfood.jsx.
 *
 * Two ways to enter what the back of the package says, on one screen:
 * the form is laid out the way the label is, and the camera button above it
 * fills the form from a photo. The photo only ever FILLS the boxes — it never
 * saves or logs anything — because a number read off a photo is a number to
 * check, and the boxes are where he checks it.
 *
 * Saving keeps the food: it is starred, so it is one tap away from then on, and
 * when he got here from a barcode that missed, it is remembered under that
 * barcode, so the next scan finds it. Then it goes to the ordinary detail
 * screen to be logged, like anything else.
 */

import React, { useMemo, useRef, useState } from 'react'
import { Pressable, View, type TextInput } from 'react-native'
import { router } from 'expo-router'
import { Image } from 'expo-image'
import { Pane } from '../../ui/Pane'
import { T } from '../../ui/Text'
import { BigAction, Btn, Field, FilledNote, Input, Link, Spin } from '../../ui/kit'
import { success } from '../../ui/haptics'
import { alpha, colors, radius } from '../../theme'
import { Camera, CircleAlert, RotateCw, Sparkles } from '../../lib/icons'
import { LABEL_FIELDS, checkLabel, emptyLabel, fromReading, labelFood, labelReady, numbersOf, type LabelForm } from '../../lib/label'
import { bytesOf, pickPhoto, shrink } from '../../lib/photo'
import { openSettings, useServerInfo } from '../../lib/server'
import { apiFetch } from '../../lib/connection'
import { getStore } from '../../lib/store'
import { pick, useFlow } from './flow'

const clean = (v: string, decimal = true) => v.replace(decimal ? /[^\d.,]/g : /[^\d]/g, '')

interface Read {
  status: 'idle' | 'reading' | 'done' | 'error'
  preview?: string
  error?: string
  notes?: string
  model?: string
  ms?: number
}

/* A box the photo filled, until he types in it: tinted, so read-from-photo
   never looks the same as typed-by-him. */
const filledBox = { borderColor: alpha(colors.accent, 0.55), backgroundColor: alpha(colors.accent, 0.08) }

/** `.lbl-input input`: a short right-aligned number box, with its unit after it. */
function NumBox({ value, onChange, label, unit, filled, big, inputRef }: {
  value: string
  onChange: (v: string) => void
  label: string
  unit?: string
  filled?: boolean
  big?: boolean
  inputRef?: React.Ref<TextInput>
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 }}>
      <Input
        ref={inputRef}
        value={value}
        onChangeText={v => onChange(clean(v))}
        keyboardType="decimal-pad"
        placeholder="–"
        accessibilityLabel={label}
        selectTextOnFocus
        boxStyle={[{ width: 84, minHeight: 36, paddingHorizontal: 10 }, filled && filledBox]}
        textStyle={[{ textAlign: 'right' }, big && { fontSize: 22, fontWeight: '800' }]}
      />
      {unit !== undefined ? <T size={12} muted style={{ minWidth: 20 }}>{unit}</T> : null}
    </View>
  )
}

/** One row of the label. Tapping the name focuses its box, as a <label> does. */
function Row({ field, value, onChange, filled }: { field: (typeof LABEL_FIELDS)[number]; value: string; onChange: (v: string) => void; filled: boolean }) {
  const ref = useRef<TextInput>(null)
  return (
    <Pressable
      onPress={() => ref.current?.focus()}
      style={{
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: 44,
        borderBottomWidth: field.big ? 4 : 1, borderBottomColor: field.big ? colors.text : colors.line,
      }}
    >
      <T
        size={field.big ? 22 : 15}
        weight={field.big ? 900 : field.indent ? 400 : 700}
        style={{ paddingLeft: field.indent ? 16 : 0, flexShrink: 1 }}
      >
        {field.label}
      </T>
      <NumBox inputRef={ref} value={value} onChange={onChange} label={field.label} unit={field.unit || undefined} filled={filled} big={field.big} />
    </Pressable>
  )
}

export default function LabelFood() {
  const { labelGtin, query } = useFlow()
  const gtin = labelGtin
  const initialName = labelGtin ? '' : query.trim()
  const info = useServerInfo()
  const aiOff = info?.features && !info.features.ai
  const [form, setForm] = useState<LabelForm>(() => emptyLabel({ name: initialName }))
  const [read, setRead] = useState<Read>({ status: 'idle' })
  const [filled, setFilled] = useState<Set<string>>(() => new Set())
  const servingsRef = useRef<TextInput>(null)

  const set = (key: string) => (v: string) => {
    setForm(f => ({ ...f, [key]: v }))
    // A box he has typed in is his, not the photo's.
    setFilled(s => { if (!s.has(key)) return s; const n = new Set(s); n.delete(key); return n })
  }
  const warnings = useMemo(() => checkLabel(numbersOf(form)), [form])
  const ready = labelReady(form)

  // The web's <input type="file"> offers the camera and the library in one sheet;
  // pickPhoto asks which, because the label he photographed in the shop is in
  // the library.
  const onPhoto = async () => {
    let uri: string | null
    try {
      uri = await pickPhoto({ title: 'Photograph the label' })
    } catch (e: any) {
      setRead(r => ({ status: 'error', preview: r.preview, error: String(e?.message || e) }))
      return
    }
    if (!uri) return
    setRead({ status: 'reading' })
    try {
      const shot = await shrink(uri)
      const preview = shot.uri
      setRead({ status: 'reading', preview })
      const res = await apiFetch('/api/label', { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: bytesOf(shot.base64) as any })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `The label reader answered ${res.status}.`)
      if (!body.label?.isLabel) {
        setRead({ status: 'error', preview, error: 'That does not look like a nutrition label. Try again closer, straight on, with the whole panel in the frame.' })
        return
      }
      setForm(f => fromReading(body.label, f))
      setFilled(new Set(Object.entries(body.label as Record<string, unknown>).filter(([k, v]) => v != null && k in form && k !== 'name').map(([k]) => k)))
      success()
      setRead({ status: 'done', preview, notes: body.label.notes, model: body.model, ms: body.ms })
    } catch (e: any) {
      setRead(r => ({ status: 'error', preview: r.preview, error: String(e?.message || e) }))
    }
  }

  const save = () => {
    const food = labelFood(form, { gtin })
    // Kept, not just logged once: starred so it is one tap away from now on, and
    // remembered under its barcode so the scan that missed today finds it
    // tomorrow. Neither may stop it being logged.
    getStore().starFood(food)
    if (food.gtin) {
      apiFetch('/api/food', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ food }) })
        .catch(() => {})
    }
    success()
    pick(food, null, { replace: true })
  }

  const reading = read.status === 'reading'

  return (
    <Pane
      title="From the label"
      onBack={() => router.back()}
      foot={(
        <Btn kind="primary" disabled={!ready} onPress={save}
          title={ready ? 'Save and log it' : form.name.trim() ? 'Calories are needed' : 'Name it first'} />
      )}
    >
      {aiOff ? (
        <View style={{ alignItems: 'flex-start', gap: 8, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: radius.r, padding: 14 }}>
          <T size={14} muted lineHeight={21}>
            <T size={14} weight={700} lineHeight={21}>Reading a label from a photo needs AI</T>, which is not set up on this server yet. The form below works without it.
          </T>
          <Btn icon={Sparkles} title="Set up AI in Settings" onPress={() => openSettings('ai')} />
        </View>
      ) : (
        <BigAction
          disabled={reading}
          onPress={onPhoto}
          icon={Camera}
          iconNode={reading ? <Spin size={26} color={colors.text} /> : <Camera size={26} color={colors.text} />}
          title={reading ? 'Reading the label…' : read.status === 'idle' ? 'Photograph the label' : 'Photograph it again'}
          sub={reading ? 'About ten seconds' : 'The numbers fill in below. You check them.'}
        />
      )}

      {read.preview ? (
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
          <Image
            source={{ uri: read.preview }}
            style={{ width: 72, height: 96, borderRadius: 10, borderWidth: 1, borderColor: colors.line }}
            contentFit="cover"
            accessibilityLabel="The label you photographed"
          />
          <View style={{ flex: 1, minWidth: 0 }}>
            {read.status === 'done' && (
              <FilledNote icon={Sparkles}>
                Read from your photo — <T size={13} weight={700} lineHeight={19}>check each number against the label</T>.
                {read.notes ? ` ${read.notes}` : ''}
              </FilledNote>
            )}
            {read.status === 'error' && (
              <View style={{ gap: 2 }}>
                <View style={{ flexDirection: 'row', gap: 6, alignItems: 'flex-start' }}>
                  <CircleAlert size={14} color={colors.errorText} style={{ marginTop: 2 }} />
                  <T size={13} color={colors.errorText} lineHeight={18} style={{ flex: 1 }}>{read.error}</T>
                </View>
                <Link title="Try again" icon={RotateCw} onPress={onPhoto} />
              </View>
            )}
          </View>
        </View>
      ) : null}

      <Field label="What is it">
        <Input value={form.name} onChangeText={set('name')} placeholder="Peanut butter protein bar" accessibilityLabel="What is it" />
        <Input value={form.brand} onChangeText={set('brand')} placeholder="Brand (optional)" accessibilityLabel="Brand" />
      </Field>

      {/* The form is laid out like the label it is copied from — the same rows,
          in the same order, with the same thick rules — so reading across from
          the package to the screen is one line at a time. */}
      <View style={{ borderWidth: 1, borderColor: colors.line, borderRadius: radius.r, backgroundColor: colors.panel, paddingTop: 10, paddingHorizontal: 12, paddingBottom: 12 }}>
        <T size={24} weight={900} style={{ letterSpacing: -0.24, paddingBottom: 4, borderBottomWidth: 1, borderBottomColor: colors.line }}>Nutrition Facts</T>
        <Pressable
          onPress={() => servingsRef.current?.focus()}
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: 40, borderBottomWidth: 1, borderBottomColor: colors.line }}
        >
          <T size={15} weight={700} style={{ flexShrink: 1 }}>Servings per container</T>
          <NumBox inputRef={servingsRef} value={form.servingsPerContainer} onChange={set('servingsPerContainer')}
            label="Servings per container" filled={filled.has('servingsPerContainer')} />
        </Pressable>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: 44 }}>
          <T size={15} weight={700}>Serving size</T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, justifyContent: 'flex-end' }}>
            <Input
              value={form.servingLabel}
              onChangeText={set('servingLabel')}
              placeholder="2/3 cup"
              accessibilityLabel="Serving size"
              boxStyle={[{ flex: 1, minWidth: 0, maxWidth: 160, minHeight: 36, paddingHorizontal: 10 }, (filled.has('servingLabel') || filled.has('servingGrams')) && filledBox]}
              textStyle={{ textAlign: 'right' }}
            />
            <NumBox value={form.servingGrams} onChange={set('servingGrams')} label="Serving size in grams" unit="g"
              filled={filled.has('servingLabel') || filled.has('servingGrams')} />
          </View>
        </View>
        <T size={12} weight={800} style={{ paddingTop: 6, paddingBottom: 2, borderTopWidth: 6, borderTopColor: colors.text, marginTop: 2 }}>Amount per serving</T>
        {LABEL_FIELDS.map(f => (
          <Row key={f.key} field={f} value={form[f.key]} onChange={set(f.key)} filled={filled.has(f.key)} />
        ))}
      </View>

      {warnings.length > 0 && (
        <View style={{ gap: 6 }}>
          {warnings.map(w => (
            <View key={w} style={{ flexDirection: 'row', gap: 6, alignItems: 'flex-start' }}>
              <CircleAlert size={14} color={colors.warnText} style={{ marginTop: 2 }} />
              <T size={13} color={colors.warnText} lineHeight={18} style={{ flex: 1 }}>{w}</T>
            </View>
          ))}
        </View>
      )}
      {gtin ? <T size={12} muted lineHeight={19}>Saved under barcode {gtin}, so scanning it next time finds this.</T> : null}
    </Pane>
  )
}
