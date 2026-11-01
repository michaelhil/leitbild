import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseQualificationOptions, qualificationBilling, runQualification } from './agent-model-qualification.ts'

const args = ['--origin', 'https://leitbild.app', '--out', '/tmp/qualification', '--model', 'deepseek/deepseek-v4.1-flash-1017', '--case', 'single-value']
test('preparation is default; paid delegation and observer scope are explicit', () => {
  expect(parseQualificationOptions(args)).toMatchObject({ runModel: false, effort: null, patienceMs: 300_000, reviewUsd: 1 })
  expect(parseQualificationOptions([...args, '--run', '--effort', 'low', '--review-usd', '0.20'])).toMatchObject({ runModel: true, effort: 'low', reviewUsd: .2 })
  for (const extra of [['--run', '--run'], ['--review-usd', 'NaN'], ['--review-usd', '-1'], ['--patience-minutes', '0'], ['--migrate']]) expect(() => parseQualificationOptions([...args, ...extra])).toThrow()
  expect(() => parseQualificationOptions(args.map(value => value === 'https://leitbild.app' ? 'https://user:secret@example.test' : value))).toThrow('without credentials')
  expect(() => parseQualificationOptions(args.map(value => value === 'single-value' ? '__proto__' : value))).toThrow('Unknown qualification case')
})
test('reported zero cost is known; missing, invalid and failed unpriced calls stay unknown', () => {
  expect(qualificationBilling([
    { status: 'completed', metrics: { costUsd: 0 } }, { status: 'completed', metrics: { costUsd: .123 } },
    { status: 'failed' }, { status: 'completed', metrics: { costUsd: NaN } },
    { status: 'completed', metrics: { costUsd: -1 } }, { status: 'running' },
  ])).toEqual({ knownCostUsd: .123, unknownCalls: 3, runningCalls: 1 })
})
test('existing evidence is refused before any HTTP or model dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'model-qualification-'))
  const directory = join(root, 'prior'); await mkdir(directory)
  const prior = globalThis.fetch; let requests = 0
  globalThis.fetch = Object.assign(async (..._args: Parameters<typeof fetch>) => { requests++; throw Error('No network expected') }, { preconnect: prior.preconnect })
  try {
    await expect(runQualification({ ...parseQualificationOptions(args), directory })).rejects.toThrow('EEXIST')
    expect(requests).toBe(0)
  } finally { globalThis.fetch = prior; await rm(root, { recursive: true, force: true }) }
})
