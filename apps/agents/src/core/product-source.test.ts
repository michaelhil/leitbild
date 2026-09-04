import { describe, expect, test } from 'bun:test'
import { readProductSource } from './product-source.ts'

describe('product source reader', () => {
  test('reads an allowlisted product document with provenance', async () => {
    const source = await readProductSource('README.md')
    expect(source.path).toBe('README.md')
    expect(source.kind).toBe('documentation')
    expect(source.totalLines).toBeGreaterThan(1)
    expect(source.content).toContain('Leitbild')
  })

  test('rejects traversal and operational files', async () => {
    await expect(readProductSource('../package.json')).rejects.toThrow('not in the Leitbild product source corpus')
    await expect(readProductSource('deploy/Caddyfile')).rejects.toThrow('not in the Leitbild product source corpus')
  })
})
