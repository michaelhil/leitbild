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
    expect(route).not.toMatch(/['"`]((display|procedures):|map:run)/)
  })

  test('only the map surface\'s startup depends on the base map: every other surface neither waits for it nor fails with it', () => {
    expect(route).toContain('const startupAwaitsMap = $derived(mapVisible && (!surfaceMode || mapSurface))')
    expect(route).toContain('const awaitedStartupSteps = $derived(startupStepsAwaited(startupSteps, { map: !surfaceMode || mapSurface }))')
    // Readiness and the step before it wait for the map only where startup awaits it; no bare wait is left in either.
    const completion = route.slice(route.indexOf('const completeReadyWhenReady'), route.indexOf('const loadSurfaceForScenario'))
    expect(completion.match(/startupAwaitsMap && !mapReady/g)).toHaveLength(3)
    expect(completion).not.toContain('mapVisible')
    expect(completion).toContain("startupSteps.find(step => step.id === 'objects')?.status !== 'done' || startupHasFailed(awaitedStartupSteps)")
    expect(completion).not.toContain('startupHasFailed(startupSteps)')
    // A failed map step does not bring the startup dialog back over the surface; the dialog still lists every step.
    expect(route).toMatch(/startupModalShouldShow\(\{\s*routeMode,\s*dismissed: startupDismissed,\s*steps: awaitedStartupSteps,\s*\}\)/)
    expect(markup).toMatch(/<StartupModal\s+steps=\{startupSteps\}/)
    // What a surface shows waits for the join, the snapshot and the Packs. Of the map it asks only whether the Run has one, never whether it is ready.
    const presentation = route.slice(route.indexOf('const surfacePresentation = $derived('), route.indexOf('const surfaceRefusal'))
    expect(presentation).not.toContain('mapReady')
    expect(presentation.match(/\bmap[A-Z]\w*/g)).toEqual(['mapVisible'])
    expect(presentation).toMatch(/\}, mapVisible\)\)\s*$/)
    expect(route).toContain('const mapVisible = $derived(mapConfig !== null)')
    // The map still mounts underneath: there is no map-less mode.
    expect(markup).toMatch(/\{#if effectiveMapConfig && OperationalMap\}\s*<OperationalMap\b/)
    expect(markup).not.toMatch(/\{#if [^}]*surfaceMode[^}]*\}\s*<OperationalMap\b/)
  })

  test('the display window fills the pane for good: no restore, no close, and the Host keeps its split', () => {
    const window = source('ui/process-display/DisplayWindow.svelte')
    // Its bounds are the pane's, following every resize, with no window edge; a maximised window keeps its margin.
    expect(window).toMatch(/const effectiveBounds = \$derived<ProcessDisplayWindowBounds>\(asSurface\s*\? \{ x: 0, y: 0, width: Math\.max\(1, viewport\.width\), height: Math\.max\(1, viewport\.height\) \}\s*: maximised\s*\? \{\s*x: windowConstraints\.margin,\s*y: windowConstraints\.margin,/)
    expect(window).toContain('class:as-surface={asSurface}')
    expect(source('ui/style.css').match(/\.display-window\.as-surface\s*\{[^}]*\}/)?.[0].replace(/\s+/g, ' ')).toBe('.display-window.as-surface { border: 0; border-radius: 0; box-shadow: none; }')
    expect(markup).toContain("asSurface={surfaceRoute.kind === 'surface' && (surfaceRoute.surface.kind === 'display' || surfaceRoute.surface.kind === 'dashboard')}")
    expect(window).toContain('let maximised = $state(untrack(() => asSurface))')
    expect(window).toContain('if (asSurface || maximised === next) return')
    expect(window).toContain('if (maximised && !asSurface) postToHost(displayWindowMaximiseMessage(false))')
    expect(window).toMatch(/\{#if !asSurface\}\s*<button[^>]*aria-label=\{maximised \? 'Restore the display window' : 'Maximise the display window'\}/)
    expect(window).toMatch(/\{#if !asSurface\}\s*<button[^>]*aria-label="Close the display window"/)
    expect(window).toMatch(/\{#if !asSurface\}\s*<button[^>]*onclick=\{\(\) => \{ popover = null; setMaximised\(!maximised\) \}\}/)
  })

  test('a surface opens each display fitted and neither reads nor writes the remembered zooms', () => {
    const window = source('ui/process-display/DisplayWindow.svelte')
    // A display new to the window is fitted before the one read of the store is reached.
    expect(window).toMatch(/if \(asSurface\) \{\s*setZoomState\(entry\.key, fittedDisplayZoom\(context\)\)\s*return\s*\}\s*let stored: StoredDisplayZoom \| null = null\s*try \{\s*stored = zoomStoreFor\(entry\)\.read\(zoomStorageKey\(entry\)\)/)
    expect(window.match(/zoomStoreFor\(entry\)\.read\(/g)).toHaveLength(1)
    // The one writer, which also forgets a zoom when Fit is chosen, runs only for a zoom change that asked to be remembered.
    expect(window).toContain('if (!asSurface) rememberZoom(entry, next)')
    expect(window.match(/rememberZoom\(/g)).toHaveLength(1)
    expect(window.match(/zoomStoreFor\(entry\)\.(write|forget)\(/g)).toHaveLength(2)
    expect(window.match(/flushZoomWrites/g)).toHaveLength(3)
    expect(window).toContain('zoomWriteTimer = setTimeout(flushZoomWrites, zoomWriteDelayMs)')
    expect(window).toMatch(/if \(zoomWriteTimer !== null\) \{\s*clearTimeout\(zoomWriteTimer\)\s*flushZoomWrites\(\)\s*\}/)
    // Until a display's first report fits it, the surface shows the window's own connecting message over it, and the
    // frame stays shown beneath so it draws and reports. The dashboard, drawn for its frame, is never held back.
    expect(window).toContain("const awaitingFit = $derived(asSurface && current !== null && current.source !== 'dashboard' && currentZoom !== null && awaitsFirstFit(currentZoom))")
    expect(window).toMatch(/const connecting = \$derived\(current !== null && currentDefault\?\.state !== 'failed' && currentRefusal === null\s*&& \(currentEnvelope === null \|\| !framesUp\.has\(current\.key\) \|\| awaitingFit\)\)/)
    expect(window.match(/awaitingFit/g)).toHaveLength(2)
    expect(window).toContain('shown={mounted.entry.key === current?.key}')
    expect(source('ui/style.css').match(/\.display-window-message\s*\{[^}]*\}/)?.[0]).toMatch(/inset: 0;[\s\S]*z-index: 1;[\s\S]*background: var\(--panel\);/)
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

  test('the map surface is the Run\'s map alone: no rail and no Pack panel, and the map, its status line and the role bar stay', () => {
    expect(route).toContain("const mapSurface = surfaceRoute.kind === 'surface' && surfaceRoute.surface.kind === 'map'")
    // It opens no window: the map is the surface.
    expect(route).toContain("if (presentation === null || presentation.kind === 'refused' || presentation.kind === 'map') return")
    // The rail is not drawn. Its configuration stays, because the display deck and the dashboard take their assets from it.
    expect(route).toContain('const railVisible = $derived(railConfig !== null && !mapSurface)')
    expect(markup).toMatch(/\{#if railVisible && railConfig\}\s*\{#if railLayout\.drawer\}[\s\S]*?<ControlRail\b/)
    expect(markup).not.toContain('{#if railConfig}')
    expect(markup.match(/<ControlRail\b/g)).toHaveLength(1)
    expect(route).toContain('const railConfig = $derived(startingView?.rail ?? null)')
    expect(route).toContain('categoryRowsForStartingView(allCategoryRows, railConfig)')
    // No Pack panel exists there: the one list every panel use reads is empty, so none is drawn, loaded or given keys, map targets or camera padding.
    expect(route).toContain('const surfacePanels = $derived(mapSurface ? [] : activePack?.surfacePanels ?? [])')
    expect(route.match(/activePack(\?)?\.surfacePanels/g)).toHaveLength(1)
    expect(markup).toContain('{#each surfacePanels as panel (panel.id)}')
    expect(markup.match(/class="presentation-panel-host"/g)).toHaveLength(1)
    // What stays is drawn for every page: the map with its own controls, the status line with the clock, and the role bar.
    expect(markup).not.toMatch(/\{#if [^}]*(surfaceMode|mapSurface)[^}]*\}\s*<(OperationalMap|WorldStatusLine|RoleBar)\b/)
    expect(markup).toMatch(/<WorldStatusLine \{clock\}/)
    expect(markup).toMatch(/\{#if runRoles && heldRoleIds\}\s*<RoleBar\b/)
  })

  test('on the map surface a click orders nothing and leaves nothing selected, and a display it opens is an ordinary window', () => {
    // One click context feeds every map-click decision; on the map surface it is the one that orders and selects nothing (map-target-routing.ts).
    expect(route).toMatch(/const mapClickContext = \$derived<MapClickContext>\(mapSurface\s*\? mapAloneClicks\(\{ context: targetContext, opensDisplay \}\)\s*: \{ controller: selectedControllerObject,/)
    expect(route.match(/routeObjectClick\(object, mapClickContext\)|routeGroundClick\(point, mapClickContext\)|previewObjectTarget\(object, mapClickContext\)/g)).toHaveLength(3)
    expect(route.match(/\b(routeObjectClick|routeGroundClick|previewObjectTarget)\(/g)).toHaveLength(3)
    expect(markup).toContain('targetPicking={targetPickingWanted(mapClickContext)}')
    expect(markup).toContain('onGroundSelected={groundClicksWanted(mapClickContext) ? selectGround : undefined}')
    expect(markup).toContain('targetPreviewFor={targetPreviewsWanted(mapClickContext) ? previewTarget : undefined}')
    expect(markup).toContain('isController={object => mapClickContext.targeting?.isController(object, targetContext) === true}')
    // No unit starts selected there either, at join or after a role switch: both ask the one rule.
    expect(route).toContain('mapSurface || !activePack ? null : startingControllerId(list, activePack, context, isSurfacePanelOpen)')
    expect(route.match(/\bstartingControllerId\(/g)).toHaveLength(1)
    expect(route).toContain('const startingId = startingSelection(perspective.snapshot.objects, perspectiveContext)')
    expect(route).toContain('startingControllerId: list => startingSelection(list, targetContextFor(list)),')
    expect(source('ui/app/control-surface-session.ts')).toContain('config.setSelectedControllerId(config.startingControllerId(snapshot.objects))')
    // The display a click opens is requested as from the Run page; only a display or dashboard surface fills the pane (pinned above).
    expect(route).toMatch(/if \(route\.kind === 'display'\) \{[^}]*if \(placementMode === null\) openDisplayFromPress\(route\.objectId\)/)
  })
})
