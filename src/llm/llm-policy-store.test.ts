import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPolicyStore, loadPolicy } from './llm-policy-store.ts'
import { DEFAULT_MODEL_FALLBACK } from './models/catalog.ts'

const dirs: string[] = []
const tempPolicy = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'samsinn-policy-'))
  dirs.push(dir)
  return join(dir, 'llm-policy.json')
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('LLM policy defaults', () => {
  test('missing and legacy-empty files receive the capability-safe fallback chain', async () => {
    const missing = await tempPolicy()
    expect((await loadPolicy(missing)).data.defaults?.modelFallback).toEqual(DEFAULT_MODEL_FALLBACK)

    const legacy = await tempPolicy()
    await writeFile(legacy, JSON.stringify({ version: 1 }))
    expect((await loadPolicy(legacy)).data.defaults?.modelFallback).toEqual(DEFAULT_MODEL_FALLBACK)
  })

  test('explicit empty chain remains disabled across reload', async () => {
    const path = await tempPolicy()
    const { store } = await createPolicyStore({ path })
    await store.setModelFallback(undefined)
    expect(store.getModelFallback()).toEqual([])
    expect((await loadPolicy(path)).data.defaults?.modelFallback).toEqual([])
    const raw = JSON.parse(await readFile(path, 'utf8')) as { defaults?: { modelFallback?: string[] } }
    expect(raw.defaults?.modelFallback).toEqual([])
  })
})
