import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = (path: string): string => readFileSync(join(import.meta.dir, '..', 'src', path), 'utf8')

describe('the Run page as a screen\'s surface', () => {
  const route = source('ui/routes/ControlSurfaceRoute.svelte')
  const markup = route.slice(route.indexOf('</script>'))

  test('one switch, read from the page\'s query, decides everything a surface page leaves out', () => {
    expect(route).toContain('const surfaceRoute = readSurfaceRoute(location.search)')
    expect(route).toContain("const surfaceMode = surfaceRoute.kind !== 'run'")
    // The focus opening and the planning guide's own opening never run on a surface page.
    expect(route).toContain('const routeFocus = surfaceMode ? null : objectIdSchema.safeParse(')
    expect(route).toMatch(/if \(surfaceMode \|\| routeFocus !== null \|\| planningGuideOpened /)
    // Neither the dock nor the scenario's guidance briefing is drawn.
    expect(markup).toMatch(/\{#if !surfaceMode\}\s*<RunViewControls\b/)
    expect(route).toContain('const mapGuidanceVisible = $derived(!surfaceMode && guidanceOverlayVisible')
    expect(markup).toMatch(/\{#if mapGuidanceVisible && scenarioState\?\.guidance\}\s*\{#key scenarioState\.guidance\.id\}\s*<ScenarioGuidance\b/)
  })

  test('a surface page neither reads nor writes the stored Run view preferences', () => {
    expect(route).toContain('const key = surfaceMode ? null : runViewPreferencesKey(workspaceId, route.simulationRunId)')
    expect(route).toContain('if (key !== null) try { preferences = readRunViewPreferences(sessionStorage, key) }')
    expect(route.match(/readRunViewPreferences\(/g)).toHaveLength(1)
    // The one writer runs only for the key the mount set, and a surface page sets none.
    expect(route.match(/writeRunViewPreferences\(/g)).toHaveLength(1)
    expect(route).toMatch(/const key = viewPreferencesKey\s*if \(key === null\) return\s*try \{ writeRunViewPreferences\(sessionStorage, key,/)
    expect(route).toContain('viewPreferencesKey = key')
  })

  test('the surface\'s window opens only once the Run is joined, and what the Run cannot show is said in the pane', () => {
    expect(route).toMatch(/const surfacePresentation = \$derived\(surfaceRoute\.kind === 'run' \|\| !startupDismissed \|\| !snapshotReady \|\| activePack === null \|\| simulationRunId === null\s*\? null\s*: presentSurface\(surfaceRoute,/)
    expect(route).toContain('requestDisplayWindow(presentation.target, false)')
    expect(markup).toMatch(/\{#if surfaceRefusal !== null\}\s*<div class="surface-refusal" role="alert"><p>\{surfaceRefusal\}<\/p><\/div>/)
    // The page asks surface-route.ts and decides nothing about surface strings itself.
    expect(route).not.toMatch(/['"`](display|procedures):/)
  })

  test('the display window fills the pane for good: no restore, no close, and the Host keeps its split', () => {
    const window = source('ui/process-display/DisplayWindow.svelte')
    expect(markup).toContain("asSurface={surfaceRoute.kind === 'surface' && surfaceRoute.surface.kind !== 'procedures'}")
    expect(window).toContain('let maximised = $state(untrack(() => asSurface))')
    expect(window).toContain('if (asSurface || maximised === next) return')
    expect(window).toContain('if (maximised && !asSurface) postToHost(displayWindowMaximiseMessage(false))')
    expect(window).toMatch(/\{#if !asSurface\}\s*<button[^>]*aria-label=\{maximised \? 'Restore the display window' : 'Maximise the display window'\}/)
    expect(window).toMatch(/\{#if !asSurface\}\s*<button[^>]*aria-label="Close the display window"/)
    expect(window).toMatch(/\{#if !asSurface\}\s*<button[^>]*onclick=\{\(\) => \{ popover = null; setMaximised\(!maximised\) \}\}/)
  })

  test('the surface\'s procedure window is the pane: it follows its size and neither moves, resizes nor closes', () => {
    const modal = source('ui/procedures/ProcedureSystemModal.svelte')
    expect(markup).toContain('asSurface={windowEntry.id === surfaceProcedureWindowId}')
    expect(modal).toContain('if (asSurface) return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }')
    // The same clamp sets the bounds on mount and on every resize of the pane.
    expect(modal).toContain('windowBounds = clampWindowBounds(defaultWindowBounds())')
    expect(modal).toContain('applyWindowBounds(clampWindowBounds(windowBounds))')
    expect(modal).toContain('if (event.button !== 0 || asSurface) return')
    expect(modal).toMatch(/\{#if !asSurface\}\s*<div\s+class="procedure-resize-handle north"/)
    expect(modal).toMatch(/\{#if !asSurface\}\s*<button type="button" title="Close procedures"/)
  })

  test('"Open on another screen…" is offered for a display with an address and for a unit\'s procedures, never on a surface page', () => {
    const window = source('ui/process-display/DisplayWindow.svelte')
    const modal = source('ui/procedures/ProcedureSystemModal.svelte')
    expect(markup).toContain('placeOnScreen={surfaceMode ? null : placeOnScreen}')
    expect(markup).toContain('placeOnScreen={surfaceMode ? undefined : () => placeOnScreen(procedureWindowSurface({ objectId: windowEntry.object.id, label: windowEntry.object.label }))}')
    expect(route).toContain('requestSurfacePlace({ workspaceId: activeWorkspaceId(), simulationRunId: displayWindowRunId }, placed, { parent: window.parent, origin: location.origin })')
    expect(window).toContain('const placeable = $derived(placeOnScreen === null || current === null ? null : deckEntrySurface(current))')
    // In the More menu where the header is narrow, and beside Pin where it is wide.
    const more = window.slice(window.indexOf("{:else if popover === 'more'}"))
    expect(more).toMatch(/\{#if placeable !== null\}[\s\S]*?<span>Open on another screen…<\/span>/)
    expect(window.slice(0, window.indexOf("{:else if popover === 'more'}"))).toMatch(/\{#if placeable !== null\}[\s\S]*?title="Open on another screen…"/)
    expect(modal).toMatch(/\{#if placeOnScreen\}\s*<button type="button" title="Open on another screen…"[^>]*onclick=\{placeOnScreen\}/)
  })
})
