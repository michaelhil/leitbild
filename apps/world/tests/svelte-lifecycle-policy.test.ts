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
    expect(mapRuntime).toContain('maplibre-gl/dist/maplibre-gl-worker.mjs?url')
    expect(mapRuntime).toContain('setWorkerUrl')
  })

  test('process-display child modals opt back into pointer events', () => {
    const css = readFileSync(join(uiRoot, 'style.css'), 'utf8')
    const processLayer = css.match(/\.process-display-window-layer\s*\{[^}]*\}/)?.[0] ?? ''
    const artifactBackdrop = css.match(/\.process-artifact-backdrop\s*\{[^}]*\}/)?.[0] ?? ''
    const procedureBackdrop = css.match(/\.procedure-backdrop\s*\{[^}]*\}/)?.[0] ?? ''

    expect(processLayer).toContain('pointer-events: none')
    expect(artifactBackdrop).toContain('pointer-events: auto')
    expect(procedureBackdrop).toContain('pointer-events: auto')
  })

  test('process display loader stays independent from live object telemetry and window geometry', () => {
    const source = readFileSync(join(uiRoot, 'process-display', 'ProcessDisplayModal.svelte'), 'utf8')
    const mountStart = source.indexOf('runOnMount(() => {')
    const mount = source.slice(mountStart, source.indexOf('</script>', mountStart))

    // Startup is deliberately non-reactive. Live telemetry and dragging must
    // never restart discovery, blank the renderer, or install another poller.
    expect(source).not.toContain('$effect(')
    expect(source).toContain('untrack(() => plantIdFor(object))')
    expect(source).toContain('untrack(() => simulationRunId)')
    expect(mount).toContain('void loadDisplay()')
    expect(mount).toContain('disposed = true')
    expect(mount).toContain('session.close()')
  })

  test('floating window drag guards ignore icon clicks inside buttons', () => {
    const procedureSource = readFileSync(join(uiRoot, 'procedures', 'ProcedureSystemModal.svelte'), 'utf8')
    const processDisplaySource = readFileSync(join(uiRoot, 'process-display', 'ProcessDisplayModal.svelte'), 'utf8')

    expect(procedureSource).toContain('target instanceof Element && target.closest')
    expect(processDisplaySource).toContain('target instanceof Element && target.closest')
    expect(procedureSource).not.toContain('target instanceof HTMLElement && target.closest')
    expect(processDisplaySource).not.toContain('target instanceof HTMLElement && target.closest')
  })
})
