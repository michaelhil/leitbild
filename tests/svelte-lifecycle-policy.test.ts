import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const uiRoot = join(import.meta.dir, '..', 'src', 'ui')

const svelteFiles = (dir: string): readonly string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) return svelteFiles(path)
    return path.endsWith('.svelte') ? [path] : []
  })

const effectSnippets = (source: string): readonly string[] => {
  const snippets: string[] = []
  let index = 0
  while (index >= 0) {
    index = source.indexOf('$effect(', index)
    if (index < 0) break
    snippets.push(source.slice(index, index + 800))
    index += '$effect('.length
  }
  return snippets
}

describe('Svelte lifecycle policy', () => {
  test('uses runOnMount for mount-only external lifecycle effects', () => {
    const forbiddenMountOnlyCalls = [
      'addEventListener',
      'setInterval',
      'new MapLibre',
    ]
    const violations = svelteFiles(uiRoot).flatMap((file) => {
      const source = readFileSync(file, 'utf8')
      return effectSnippets(source)
        .filter(snippet => forbiddenMountOnlyCalls.some(call => snippet.includes(call)))
        .map(snippet => `${file}: ${snippet.split('\n')[0]}`)
    })

    expect(violations).toEqual([])
  })

  test('keeps MapLibre lifecycle and resize ownership inside MapRuntime', () => {
    const operationalMap = readFileSync(join(uiRoot, 'OperationalMap.svelte'), 'utf8')
    const mapRuntime = readFileSync(join(uiRoot, 'map-runtime', 'map-runtime.ts'), 'utf8')

    expect(operationalMap).not.toContain('new MapLibre')
    expect(operationalMap).not.toContain('ResizeObserver')
    expect(operationalMap).not.toContain('PmtilesProtocol')
    expect(operationalMap).toContain('createMapRuntime')
    expect(mapRuntime).toContain('new MapLibre')
    expect(mapRuntime).toContain('ResizeObserver')
    expect(mapRuntime).not.toContain('PmtilesProtocol')
  })
})
