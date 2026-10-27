import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'

// Compare independently built real-product Canvas captures, not two calls to
// the candidate painter. The raw rows are decoded Canvas RGBA, not PNG bytes.
const folder = process.argv[2] && resolve(process.argv[2])
if (!folder) throw Error('Capture-pair folder required')
const cases = []
for (const ratio of [1, 2]) {
  const before = join(folder, `baseline-dpr${ratio}`), after = join(folder, `candidate-dpr${ratio}`)
  const left = JSON.parse(await readFile(join(before, 'receipt.json'), 'utf8')), right = JSON.parse(await readFile(join(after, 'receipt.json'), 'utf8'))
  if (!left.passed || !right.passed || left.url !== right.url || left.runnerSha256 !== right.runnerSha256) throw Error('Different or failed capture protocol')
  for (const name of ['site-live-off', 'operating-live-off']) {
    const a = JSON.parse(await readFile(join(before, `${name}.json`), 'utf8')), b = JSON.parse(await readFile(join(after, `${name}.json`), 'utf8'))
    const bytesA = await readFile(join(before, `${name}.rgba`)), bytesB = await readFile(join(after, `${name}.rgba`))
    if (a.width !== b.width || a.height !== b.height || bytesA.length !== bytesB.length || bytesA.length !== a.width * a.height * 4) throw Error('Different pixel extents')
    let differingBytes = 0
    for (let index = 0; index < bytesA.length; index++) if (bytesA[index] !== bytesB[index]) differingBytes++
    const sameTransforms = JSON.stringify(a.transforms) === JSON.stringify(b.transforms), sameTexts = JSON.stringify(a.texts) === JSON.stringify(b.texts)
    cases.push({ name, ratio, before: left.appCommit, after: right.appCommit, width: a.width, height: a.height, comparedBytes: bytesA.length, differingBytes, sameTransforms, sameTexts, sameScope: a.scope === b.scope, sameLevel: a.level === b.level, rgbaSha256: [bytesA, bytesB].map(value => createHash('sha256').update(value).digest('hex')), runnerSha256: left.runnerSha256 })
  }
}
const passed = cases.every(value => value.differingBytes === 0 && value.sameTransforms && value.sameTexts && value.sameScope && value.sameLevel)
const result = { passed, cases, limits: ['Real built old and candidate apps on one retained paused local R5 Run, matched viewport and public Home, same settled fonts and all observed Canvas transforms.', 'Live is off for exact immutable drawing comparison. Dynamic status/flow and moving-camera performance are separate functional and measurement gates.', 'RGBA is byte compared independently. No pixel, native path, AA or content tolerance is used. These four settled views do not certify every possible camera or lifecycle.'] }
await writeFile(join(folder, 'comparison.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); if (!passed) process.exitCode = 1
