/*
 * node server/label.test.js
 *
 * The photo reader, without a model: a stand-in `claude` records the arguments
 * it was started with and answers with a canned reading. What this pins is the
 * boundary — only Read, only the photo's own directory, the photo gone after —
 * and that whatever the model says is made safe before it reaches a form.
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { readLabel, normalizeLabel } = require('./label.js')

let passed = 0
const pending = []
const test = (name, fn) => pending.push(async () => {
  try { await fn(); passed++ } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`)
    process.exitCode = 1
  }
})

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krakatoa-fake-claude-'))
const argsFile = path.join(dir, 'args.json')
const bin = path.join(dir, 'claude')
function fake(answer, exit = 0) {
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs')
const input = fs.readFileSync(0, 'utf8')
const args = process.argv.slice(2)
const dirArg = args[args.indexOf('--add-dir') + 1]
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ args, input, files: fs.readdirSync(dirArg) }))
${exit ? `process.stderr.write('Error: not signed in\\n'); process.exit(${exit})` : `process.stdout.write(JSON.stringify(${JSON.stringify(answer)}))`}
`, { mode: 0o755 })
}

const IMAGE = Buffer.alloc(2048, 7)

test('the reader may read the photo and nothing else', async () => {
  fake({ structured_output: { isLabel: true, kcal: 230, protein: 3 }, model: 'claude-sonnet-5' })
  const out = await readLabel({ bin, model: 'claude-sonnet-5', image: IMAGE })
  const { args, input, files } = JSON.parse(fs.readFileSync(argsFile, 'utf8'))
  const flag = (f) => args[args.indexOf(f) + 1]
  assert.equal(flag('--allowedTools'), 'Read')
  for (const t of ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Task']) {
    assert.ok(flag('--disallowedTools').split(',').includes(t), `${t} is denied by flag`)
  }
  const granted = flag('--add-dir')
  assert.ok(granted.startsWith(path.join(os.tmpdir(), 'krakatoa-label-')), 'its own temp directory')
  assert.deepEqual(files, ['label.jpg'], 'the directory holds the photo and only the photo')
  assert.ok(input.includes(path.join(granted, 'label.jpg')), 'the prompt names the photo')
  assert.ok(!fs.existsSync(granted), 'and the photo is deleted afterwards')
  assert.equal(out.label.kcal, 230)
  assert.equal(out.label.fat, null, 'what the model left out is null, not zero')
})

test('a failed run is a sentence, and still cleans up', async () => {
  fake(null, 1)
  await assert.rejects(readLabel({ bin, model: 'm', image: IMAGE }), /not signed in/)
  const { args } = JSON.parse(fs.readFileSync(argsFile, 'utf8'))
  assert.ok(!fs.existsSync(args[args.indexOf('--add-dir') + 1]))
})

test('what the model says is made safe before it reaches a form', async () => {
  const v = normalizeLabel({ kcal: '190', fat: -3, carbs: 'lots', protein: 10, name: '  Bar  ', notes: 'x'.repeat(900) })
  assert.equal(v.kcal, 190)
  assert.equal(v.fat, null, 'nothing negative')
  assert.equal(v.carbs, null, 'nothing that is not a number')
  assert.equal(v.name, 'Bar')
  assert.ok(v.notes.length <= 280)
  assert.equal(v.isLabel, true)
  assert.equal(normalizeLabel({ isLabel: false }).isLabel, false)
  assert.equal(normalizeLabel(null).kcal, null)
})

;(async () => {
  for (const t of pending) await t()
  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`label reader: ${passed} passed`)
})()
