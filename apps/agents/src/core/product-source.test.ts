import { describe, expect, test } from 'bun:test'
import { readProductSource } from '@leitbild/knowledge/source'
import { resolve } from 'node:path'
const root = resolve(import.meta.dir, '../../../..')

describe('product source reader', () => {
  test('reads an allowlisted product document with provenance', async () => {
    const source = await readProductSource('README.md', root)
    expect(source.path).toBe('README.md')
    expect(source.kind).toBe('documentation')
    expect(source.totalLines).toBeGreaterThan(1)
    expect(source.content).toContain('Leitbild')

    const runtimeSource = await readProductSource('apps/world/src/packs/process-plant/runtime/physics.ts', root)
    expect(runtimeSource.kind).toBe('source')
    expect(runtimeSource.authority).toBe('implementation')
    expect(runtimeSource.content.length).toBeGreaterThan(0)

    const uniqueBasename = await readProductSource('halden-dispatch.scenario.json', root)
    expect(uniqueBasename.path).toBe('apps/world/src/scenarios/halden-dispatch.scenario.json')
  })

  test('rejects traversal and operational files', async () => {
    await expect(readProductSource('../package.json', root)).rejects.toThrow('not in the Leitbild product source corpus')
    await expect(readProductSource('deploy/Caddyfile', root)).rejects.toThrow('not in the Leitbild product source corpus')
    await expect(readProductSource('docs/not-present.md', root)).rejects.toThrow('unavailable in this deployed revision')
    await expect(readProductSource('index.ts', root)).rejects.toThrow('filename is ambiguous')
  })
})
