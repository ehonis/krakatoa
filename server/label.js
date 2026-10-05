/*
 * Krakatoa — read a photo of a Nutrition Facts label into numbers.
 *
 * The barcode databases miss plenty — a
 * local bakery's cookies, a gym's protein bar, anything new — and every one of
 * those still has the label on the back.
 *
 * HOW. One headless `claude` run, exactly as Bushido's planner makes one: the CLI
 * is already installed and signed in on this box, so there is no API key to hold
 * and nothing new to pay for. The photo is written to its own temporary
 * directory and the run may READ THAT DIRECTORY AND NOTHING ELSE — `Read` is the
 * only tool, `--add-dir` is the photo's folder, and everything that could write,
 * run or fetch is denied by flag. A prompt is a request; a flag is a rule.
 *
 * WHAT COMES BACK is filled into the form, never logged. The label numbers are
 * the model reading print, which it does well and not perfectly, so the screen
 * says the fields were read from a photo and asks him to check them, and
 * `checkLabel` in app/src/lib/label.js flags the ways a misread shows itself —
 * calories that disagree with their own macros, a part bigger than its whole —
 * on the client, where it runs on what he types as well.
 */

const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

/* What the label prints, per serving. Null when the label does not show it. */
const LABEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['isLabel', 'rows', 'name', 'servingLabel', 'servingGrams', 'servingsPerContainer', 'kcal', 'fat', 'satFat', 'cholesterol', 'sodium', 'carbs', 'fiber', 'sugar', 'protein', 'notes'],
  properties: {
    isLabel: { type: 'boolean', description: 'false if the photo is not a nutrition facts panel' },
    // Written FIRST, before any number is chosen. On a tilted or blurred panel
    // the failure is reading a value off the row above or below its name
    // ("Total Sugars" taking fibre's "<1g"); copying each row out as one line of
    // text ties every figure to its own name before the fields are filled.
    rows: {
      type: 'array',
      items: { type: 'string' },
      description: 'every row of the panel as printed, top to bottom, name and per-serving amount together, e.g. "Total Sugars 13g"',
    },
    name: { type: ['string', 'null'], description: 'product name if visible anywhere in the photo, else null' },
    servingLabel: { type: ['string', 'null'], description: 'the household serving as printed, e.g. "2/3 cup", "1 bar", "8 crackers"' },
    servingGrams: { type: ['number', 'null'], description: 'grams (or mL) per serving as printed in brackets' },
    servingsPerContainer: { type: ['number', 'null'] },
    kcal: { type: ['number', 'null'] },
    fat: { type: ['number', 'null'], description: 'total fat, g' },
    satFat: { type: ['number', 'null'], description: 'saturated fat, g' },
    cholesterol: { type: ['number', 'null'], description: 'mg' },
    sodium: { type: ['number', 'null'], description: 'mg' },
    carbs: { type: ['number', 'null'], description: 'total carbohydrate, g' },
    fiber: { type: ['number', 'null'], description: 'dietary fiber, g' },
    sugar: { type: ['number', 'null'], description: 'total sugars, g' },
    protein: { type: ['number', 'null'], description: 'g' },
    notes: { type: ['string', 'null'], description: 'one short sentence if anything was hard to read or ambiguous, else null' },
  },
}

const PROMPT = (file) => [
  `Read the image at ${file}. It should be a photo of a US Nutrition Facts label.`,
  '',
  'First copy every row of the panel into `rows`, top to bottom, each as its name and',
  'its per-serving amount on one line exactly as printed ("Dietary Fiber <1g").',
  'Follow each row across carefully — on a tilted photo the amount can sit slightly',
  'above or below its name. Then fill the fields FROM those rows.',
  '',
  'Return exactly what the label PRINTS for ONE serving:',
  '- Use the per-serving column. If the label has two columns (per serving and per',
  '  container, or as packaged and as prepared), use the first per-serving one, and',
  '  say which in `notes`.',
  '- Grams and milligrams as the numbers printed, not the % Daily Value.',
  '- "less than 1g" / "<1g" is 0.5. "0g" is 0.',
  '- Anything the label does not show, or that you cannot read, is null. Never',
  '  estimate a number that is not printed, and never compute one from the others.',
  '- servingLabel is the household measure only ("2/3 cup", "1 bar"), without the',
  '  grams; servingGrams is the number in brackets.',
  '- name: the product name only if it is visible in the photo; do not guess it',
  '  from the numbers.',
  '- If the photo is not a nutrition facts label, set isLabel false and everything',
  '  else null.',
].join('\n')

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Number(v))

/** The model's answer, made safe to put in a form: numbers or null, strings trimmed. */
function normalizeLabel(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const str = (s, max = 80) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, max) : null)
  return {
    isLabel: r.isLabel !== false,
    name: str(r.name),
    servingLabel: str(r.servingLabel, 40),
    servingGrams: num(r.servingGrams),
    servingsPerContainer: num(r.servingsPerContainer),
    kcal: num(r.kcal),
    fat: num(r.fat),
    satFat: num(r.satFat),
    cholesterol: num(r.cholesterol),
    sodium: num(r.sodium),
    carbs: num(r.carbs),
    fiber: num(r.fiber),
    sugar: num(r.sugar),
    protein: num(r.protein),
    notes: str(r.notes, 280),
  }
}

/**
 * One reading. `image` is a Buffer (JPEG or PNG). Resolves to
 * `{ label, model, ms, cost }`; rejects with a sentence fit for the screen.
 */
function readLabel({ bin, model, effort = 'low', timeoutMs = 90000, image, type = 'image/jpeg', env }) {
  return new Promise((resolve, reject) => {
    // Its own directory, so --add-dir grants exactly this photo and nothing else.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krakatoa-label-'))
    const file = path.join(dir, type === 'image/png' ? 'label.png' : 'label.jpg')
    fs.writeFileSync(file, image)
    // Synchronous on purpose: by the time the answer goes back, the photo is gone.
    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* already gone */ } }
    const started = Date.now()

    const child = spawn(bin, [
      '--print',
      '--model', model,
      '--effort', effort,
      '--output-format', 'json',
      '--no-session-persistence',
      '--add-dir', dir,
      '--allowedTools', 'Read',
      '--disallowedTools', ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Task', 'WebSearch', 'WebFetch', 'Glob', 'Grep'].join(','),
      '--json-schema', JSON.stringify(LABEL_SCHEMA),
    ], { cwd: dir, env: env || process.env, stdio: ['pipe', 'pipe', 'pipe'] })

    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      cleanup()
      reject(new Error('Reading the label took too long — try again, or type it in.'))
    }, timeoutMs)

    child.stdout.on('data', c => { out += c })
    child.stderr.on('data', c => { err += c })
    child.on('error', (e) => { clearTimeout(timer); cleanup(); reject(new Error(`cannot run ${bin}: ${e.message}`)) })
    child.on('close', (code) => {
      clearTimeout(timer)
      cleanup()
      if (code !== 0) return reject(new Error(err.trim().split('\n').pop() || `claude exited ${code}`))
      let doc
      try { doc = JSON.parse(out) } catch { return reject(new Error('The label reader did not answer properly — try again.')) }
      let raw = doc.structured_output
      if (!raw) { try { raw = JSON.parse(String(doc.result)) } catch { raw = null } }
      if (!raw) return reject(new Error('The label reader returned nothing usable — try again.'))
      const label = normalizeLabel(raw)
      resolve({
        label,
        model: doc.model || model,
        ms: Date.now() - started,
        cost: doc.total_cost_usd ?? null,
      })
    })
    child.stdin.end(PROMPT(file))
  })
}

module.exports = { LABEL_SCHEMA, readLabel, normalizeLabel, PROMPT }
