import { describe, expect, test } from 'bun:test'
import { readProductSource } from './product-source.ts'

describe('product source reader', () => {
  test('reads an allowlisted product document with provenance', async () => {
    const source = await readProductSource('README.md')
    expect(source.path).toBe('README.md')
    expect(source.kind).toBe('documentation')
    expect(source.totalLines).toBeGreaterThan(1)
    expect(source.content).toContain('Leitbild')

    const runtimeSource = await readProductSource('apps/world/src/packs/process-plant/runtime/physics.ts')
    expect(runtimeSource.kind).toBe('source')
    expect(runtimeSource.authority).toBe('implementation')
    expect(runtimeSource.content.length).toBeGreaterThan(0)

    const uniqueBasename = await readProductSource('halden-dispatch.scenario.json')
    expect(uniqueBasename.path).toBe('apps/world/src/scenarios/halden-dispatch.scenario.json')
  })

  test('rejects traversal and operational files', async () => {
    await expect(readProductSource('../package.json')).rejects.toThrow('not in the Leitbild product source corpus')
    await expect(readProductSource('deploy/Caddyfile')).rejects.toThrow('not in the Leitbild product source corpus')
    await expect(readProductSource('docs/not-present.md')).rejects.toThrow('unavailable in this deployed revision')
    await expect(readProductSource('index.ts')).rejects.toThrow('filename is ambiguous')
  })
})
