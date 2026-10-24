import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from 'svelte/compiler'
import { embeddedViewListingSchema, type EmbeddedViewEnvelope, type WorkspaceId } from '@leitbild/contracts'
import type { ObjectId, SimulationRunId } from '../src/core/model/index.ts'
import { alertStateSchema } from '../src/core/model/alerts.ts'
import { fitLines, listLines } from '../src/features/displays/alerts/list.ts'
import type { AlertRow } from '../src/features/displays/alerts/rows.ts'
import { FRAME_ROWS, vignetteStateSchema } from '../src/features/displays/compose/model.ts'
import { createBoardVisibility, FRAME_TITLE, frameAlertRows, frameEnvelope, isPhone, leadObjectOf, PHONE_SCALE, sectionKey, sectionsShown } from '../src/ui/embed/dashboard/board.ts'
import { dashboardEnvelope, dashboardStateSchema, pinToRunDashboard, staleText, type DashboardSection } from '../src/ui/embed/dashboard/dashboard.ts'
import { parseDisplayFrameMessage } from '../src/ui/embed/display-frame-protocol.ts'
import { openedListing } from '../src/ui/embed/opened-display.ts'
import { VIGNETTE_ROW_PX } from '../src/ui/embed/vignette/grid.ts'
import { answerDeckEntry, assetDeckKey, buildWindowDeck, dashboardDeckEntry, deckEntryAsset, steppedDeckEntry, type DeckAsset } from '../src/ui/process-display/display-deck.ts'
import { DASHBOARD_VIEW_TYPE, listingRefusal } from '../src/ui/process-display/display-window-messages.ts'
import { configureActiveWorkspace } from '../src/ui/workspace-context.ts'

// The dashboard in the display window (plan v5 R4 B4): its deck entry beside
// the assets' defaults (D-H), the run frame (W2's counts and tiles, sampled
// live) within 30 % of the screen (T17), its sections and the refused one,
// pin and unpin naming a revision (a stale one read again and said), the
// phone's frame and one section (D9).

const src = join(import.meta.dir, '../src')
const read = (path: string): string => readFileSync(join(src, path), 'utf8')
const workspaceId = '61ae04b5-ce61-40d6-b7d3-44c0bdf30753'
const runId = 'run-1'
const assets: ReadonlyArray<DeckAsset> = [
  { objectId: 'plant:u1' as ObjectId, packId: 'process-plant', label: 'Unit 1' },
  { objectId: 'plant:u2' as ObjectId, packId: 'process-plant', label: 'Unit 2' },
]
const collections = [{ category: 'units', label: 'Units', count: 2 }]
const dashboard = (): EmbeddedViewEnvelope => dashboardEnvelope({ workspaceId, simulationRunId: runId, title: 'Dashboard', state: { scope: 'run', collections } })

describe('the deck entry (D-H)', () => {
  test('the whole Run\'s dashboard stands first, beside the assets\' defaults, which it does not replace', () => {
    const entry = dashboardDeckEntry(runId, dashboard())
    const deck = buildWindowDeck({ simulationRunId: runId, assets, listings: [], shown: null, dashboard: entry })
    expect(deck.map(candidate => candidate.key)).toEqual([`dashboard:${runId}`, assetDeckKey(runId, 'plant:u1'), assetDeckKey(runId, 'plant:u2')])
    expect(deck[0]).toMatchObject({ source: 'dashboard', title: 'Dashboard', caption: 'Whole Run', kind: 'generated' })
    expect(steppedDeckEntry(deck, assetDeckKey(runId, 'plant:u1'), 'previous')?.key).toBe(`dashboard:${runId}`)
    // It is about the whole Run: no asset's tools or procedures act on it, and the window says why.
    expect(deckEntryAsset(deck[0]!, assets, { state: 'joined' })).toEqual({ ok: false, reason: 'The dashboard is about the whole Run' })
  })

  test('its view is the dashboard view type on the Run, its state the scope and the collections it offers', () => {
    const envelope = dashboard()
    expect(envelope).toMatchObject({ moduleId: 'world', viewType: DASHBOARD_VIEW_TYPE, subject: { type: 'world.simulation-run', id: runId } })
    expect(dashboardStateSchema.parse(JSON.parse(envelope.state))).toEqual({ scope: 'run', collections })
    expect(listingRefusal(envelope)).toBeNull()
    // Only the whole Run's offers collections; a scope is the Run, one object or a category.
    expect(dashboardStateSchema.safeParse({ scope: { subject: 'plant:u1' }, collections }).success).toBe(false)
    expect(dashboardStateSchema.safeParse({ scope: { of: { category: 'units' } } }).success).toBe(true)
    expect(dashboardStateSchema.safeParse({ scope: 'everything' }).success).toBe(false)
  })

  test('a unit\'s and a collection\'s dashboard open after it: the open message names the view type, and the window draws the opened one as a dashboard', () => {
    const envelope = dashboard()
    const state = JSON.stringify({ scope: { of: { category: 'units' } } })
    expect(parseDisplayFrameMessage({ type: 'world:display-open', state, title: 'Units · dashboard', viewType: DASHBOARD_VIEW_TYPE }))
      .toEqual({ type: 'world:display-open', state, title: 'Units · dashboard', viewType: DASHBOARD_VIEW_TYPE })
    const opened = openedListing({ key: `dashboard:${runId}`, title: 'Dashboard', envelope }, { state, title: 'Units · dashboard', viewType: DASHBOARD_VIEW_TYPE })
    expect(opened.envelope).toMatchObject({ viewType: DASHBOARD_VIEW_TYPE, state, title: 'Units · dashboard' })
    expect(answerDeckEntry(runId, opened)).toMatchObject({ kind: 'generated', refusal: null, caption: 'From Dashboard' })
    // A section's vignette opened from a dashboard is a vignette again: the request says so, not the frame it came from.
    const element = JSON.stringify({ title: 'SG A', at: { at: '2026-07-12T04:00:00.000Z', clock: 'simulation' }, views: [{ kind: 'values', refs: ['plant:u1#sgA.levelPercent'], rows: 1 }] })
    expect(openedListing({ key: `dashboard:${runId}`, title: 'Dashboard', envelope }, { state: element, title: 'SG A', viewType: 'display.vignette' }).envelope.viewType as string).toBe('display.vignette')
  })

  test('the window offers it from the rail\'s categories, and pins the shown vignette in one press', () => {
    const window = read('ui/process-display/DisplayWindow.svelte')
    const route = read('ui/routes/ControlSurfaceRoute.svelte')
    expect(route).toContain('collections={dashboardCollections}')
    expect(window).toContain('const deck = $derived(buildWindowDeck({ simulationRunId: runId, assets, listings, shown, dashboard }))')
    expect(window).toContain('notice = pinSaid = await pinToRunDashboard(runId, { state: view.state, title })')
    expect(window).toContain("{ id: 'dashboard', label: 'Dashboard', entries: deck.filter(entry => entry.source === 'dashboard') },")
    // Only a vignette of this Run pins; a dashboard's sections pin one by one.
    expect(window).toContain("const pinnable = $derived(currentEnvelope?.viewType === VIGNETTE_VIEW_TYPE && currentEnvelope.subject.id === String(runId) ? currentEnvelope : null)")
  })
})

describe('the run frame: W2\'s counts and tiles, sampled live, within 30 % of the screen (T17)', () => {
  const framePx = (screen: number, page: number, zoom = 1): number => (frameAlertRows({ screen, page, zoom }, VIGNETTE_ROW_PX) + FRAME_ROWS) * VIGNETTE_ROW_PX * zoom
  test.each([[1920, 1080], [1440, 900], [1280, 800]])('at %i × %i the frame takes at most 30 %% of the screen\'s height', (_width, height) => {
    // The window's body: the screen less the Host's bar, the window's margins and header.
    const page = height - 42 - 24 - 44
    expect(framePx(height, page)).toBeLessThanOrEqual(0.3 * height)
    expect(framePx(height, page)).toBeGreaterThanOrEqual(0.3 * height - VIGNETTE_ROW_PX)
    // Zoomed in, it keeps to its share on screen.
    expect(framePx(height, page / 1.25, 1.25)).toBeLessThanOrEqual(0.3 * height)
  })

  test('a small window keeps half its page for the sections; the list always keeps its head, a line and "+N more"', () => {
    expect((frameAlertRows({ screen: 1080, page: 400, zoom: 1 }, VIGNETTE_ROW_PX) + FRAME_ROWS) * VIGNETTE_ROW_PX).toBeLessThanOrEqual(200)
    expect(frameAlertRows({ screen: 200, page: 200, zoom: 1 }, VIGNETTE_ROW_PX)).toBe(3)
  })

  test('under its tiles the frame\'s list may keep one line: it says "+N more" alone, no row cut beside it', () => {
    const at = '2026-07-12T04:00:00.000Z'
    const row = (id: string, expected: boolean): AlertRow => ({
      key: `u|${id}`, objectId: 'u' as ObjectId, objectLabel: 'U', packId: 'p', categoryId: 'c', group: { objectId: 'u' as ObjectId }, priority: 'alarm', state: 'active-unack', raised: { at: at as never, clock: 'simulation' },
      alert: alertStateSchema.parse({ id, kind: 'test', severity: 'critical', message: id, raisedAt: at, acknowledged: false, clock: 'simulation', priority: 'alarm' }),
      ...(expected ? { expected: { after: 'TRIP' } } : {}),
    })
    // Its counts say what the aggregate folds ("2 expected"), so the aggregate gives way to rows; one line is "+N more".
    const lines = listLines([row('a', false), row('b', false), row('c', true), row('d', true)], new Set())
    const fit = fitLines(lines, 1, true)
    expect(fit.shown).toEqual([])
    expect(fit.hidden.map(hidden => hidden.alert.id)).toEqual(['a', 'b'])
    expect(fitLines(lines, 2, true).shown.map(line => line.kind)).toEqual(['row', 'row'])
  })

  test('the frame is a vignette of the whole Run\'s alerts, composed now and sampled live like any other', () => {
    const frame = frameEnvelope(dashboard(), 10, '2026-07-12T04:00:00.000Z')
    expect(frame.viewType as string).toBe('display.vignette')
    expect(vignetteStateSchema.parse(JSON.parse(frame.state))).toEqual({ title: FRAME_TITLE, at: { at: '2026-07-12T04:00:00.000Z', clock: 'wall' }, views: [{ kind: 'alerts', objectIds: 'run', rows: 10 }] })
  })

  test('one implementation: the frame is drawn by the vignette renderer, whose alerts section heads with AlertCounts and AlertTiles, the tiles standing in the frame', () => {
    const page = read('ui/embed/dashboard/Dashboard.svelte')
    const vignette = read('ui/embed/vignette/Vignette.svelte')
    const sections = read('ui/embed/vignette/Sections.svelte')
    const alerts = read('ui/embed/vignette/AlertsSection.svelte')
    expect(page).toContain('<Vignette envelope={frameEnvelope(envelope, rows, composedAt)} board={{ visible: visibility.subscribe(\'frame\'), frame: true }} />')
    expect(vignette).toContain('frame={board?.frame === true}')
    expect(sections).toContain('room={rows ?? section.rows} {frame} />')
    expect(alerts).toContain('<AlertCounts {census} {filter} onfilter={narrow} />')
    expect(alerts).toContain('<AlertTiles {tiles} {layout} {filter} onfilter={narrow} />')
    // In the frame the tiles stand while they leave the list a line ("+N more"); they give way, never cut, where they do not.
    expect(alerts).toContain('Math.min(listLines(own, open).length, frame ? 1 : LINES_BESIDE_TILES) * VIGNETTE_ROW_PX)')
    // The worst chip on its title row is the Run-wide worst priority: the Vignette's own, over the whole Run's alerts.
    expect(vignette).toContain('worstChip(latest.observations, latest.alerts)')
    // No second drawing of counts, tiles or the census in the dashboard.
    for (const file of ['ui/embed/dashboard/Dashboard.svelte', 'ui/embed/dashboard/board.ts', 'ui/embed/dashboard/dashboard.ts']) {
      expect(read(file)).not.toMatch(/obc-alert|alertCensus|alertTiles|AlertCounts|AlertTiles/)
    }
  })

  test('on a dashboard a vignette is hosted by its page: it neither hosts the frame nor asks the window for its height', () => {
    const vignette = read('ui/embed/vignette/Vignette.svelte')
    expect(vignette).toContain('const unhost = board !== undefined ? board.visible(visible => session.setVisible(visible)) : hostDisplayFrame({')
    expect(vignette).toContain("if (board === undefined && next.view !== undefined) embeddedDisplayFrame().reportFill('alerts', fillsWindow(next.view))")
    expect(read('ui/embed/dashboard/Dashboard.svelte')).toContain("kind: 'generated',")
  })
})

describe('sections', () => {
  const view = (state: object) => ({ viewType: 'display.vignette', title: 'Unit 1', height: 480, state: JSON.stringify(state) })
  const leads = (at: string): DashboardSection => ({ title: 'Unit 1', view: view({ title: 'Unit 1', at: { at, clock: 'simulation' }, views: [{ kind: 'values', lead: { objectId: 'plant:u1' }, zones: true, rows: 13 }] }) } as DashboardSection)

  test('a default section keeps its place and its sampling across reads; a pin is its id; each leads to its object\'s own dashboard', () => {
    expect(sectionKey(leads('2026-07-12T04:00:00.000Z'))).toBe(sectionKey(leads('2026-07-12T04:00:30.000Z')))
    expect(sectionKey({ ...leads('2026-07-12T04:00:00.000Z'), id: 'pin-0a1b2c3d', by: 'person' } as DashboardSection)).toBe('pin-0a1b2c3d')
    expect(leadObjectOf(leads('2026-07-12T04:00:00.000Z'))).toBe('plant:u1')
  })

  test('a refused section has no view: it says why, and a pin keeps its Unpin', () => {
    const refused = { id: 'pin-0a1b2c3d', by: 'agent', title: 'Unit 9', refused: { code: 'unknown_name', message: 'plant:u9 is no longer in this Run' } } as DashboardSection
    expect(sectionKey(refused)).toBe('pin-0a1b2c3d')
    expect(leadObjectOf(refused)).toBeNull()
    const page = read('ui/embed/dashboard/Dashboard.svelte')
    expect(page).toContain("<p class=\"refused\"><strong>{section.title}</strong> cannot be shown: {section.refused?.message ?? 'World sent no view for it'}</p>")
    expect(page).toMatch(/\{#if section\.id !== undefined\}\s*<button[^>]*onclick=\{unpin\(/)
  })

  test('"+N more" past eight: World counts what its default leaves out, and the page says so', () => {
    expect(read('ui/embed/dashboard/Dashboard.svelte')).toContain('+{reading.more} more: World\'s default shows {entries.length}')
  })

  test('a section samples only while the page is shown and it is scrolled into view', () => {
    const visibility = createBoardVisibility()
    const told: Array<[string, boolean]> = []
    const stopA = visibility.subscribe('a')(visible => told.push(['a', visible]))
    visibility.subscribe('frame')(visible => told.push(['frame', visible]))
    visibility.setInView('a', false)
    visibility.setPage(false)
    visibility.setInView('a', true)
    visibility.setPage(true)
    expect(told).toEqual([['a', true], ['frame', true], ['a', false], ['a', false], ['frame', false], ['a', false], ['a', true], ['frame', true]])
    stopA()
    visibility.setPage(false)
    expect(told.at(-1)).toEqual(['frame', false])
  })
})

describe('phones (< 768 px) get the frame and one section (D9)', () => {
  test('narrower than 768 px is a phone; it shows the one section chosen, clamped', () => {
    expect([isPhone(390), isPhone(767), isPhone(768), isPhone(0)]).toEqual([true, true, false, false])
    expect(sectionsShown(['a', 'b', 'c'], true, 1)).toEqual(['b'])
    expect(sectionsShown(['a', 'b', 'c'], true, 9)).toEqual(['c'])
    expect(sectionsShown(['a', 'b', 'c'], false, 1)).toEqual(['a', 'b', 'c'])
    expect(sectionsShown([], true, 0)).toEqual([])
  })

  test('no word below 12 px: the page writes none, and a phone draws the vignettes\' smallest type at PHONE_SCALE', () => {
    const sizesIn = (source: string): ReadonlyArray<number> => [...source.matchAll(/font-size: (\d+(?:\.\d+)?)px/g)].map(match => Number(match[1]))
    expect(Math.min(...sizesIn(read('ui/embed/dashboard/Dashboard.svelte')))).toBeGreaterThanOrEqual(12)
    const vignette = [...new Bun.Glob('*.svelte').scanSync({ cwd: join(src, 'ui/embed/vignette') })].flatMap(file => sizesIn(read(`ui/embed/vignette/${file}`)))
    expect(Math.min(...vignette) * PHONE_SCALE).toBeGreaterThanOrEqual(12)
    const page = read('ui/embed/dashboard/Dashboard.svelte')
    for (const part of ['class="frame"', 'class="bar"', 'class="sections"']) expect(page).toMatch(new RegExp(`${part}[^>]*style:zoom=\\{phone \\? scale : undefined\\}`))
  })
})

describe('pin and unpin name a revision; a stale one is read again and said', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })
  const reading = (revision: number, stored: boolean) => ({ result: { scope: 'run', revision, stored, sections: [], card: { at: { at: '2026-07-12T04:00:00.000Z', clock: 'simulation' }, items: [], more: 0, adjusted: [] } } })
  const answering = (answers: ReadonlyArray<{ readonly status: number; readonly body: unknown }>) => {
    const calls: Array<{ readonly path: string; readonly body: unknown }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ path: String(input), body: JSON.parse(String(init?.body)) })
      const next = answers[calls.length - 1]!
      return Response.json(next.body, { status: next.status })
    }) as typeof fetch
    return calls
  }
  configureActiveWorkspace(workspaceId as WorkspaceId)

  test('one press reads the revision and pins the shown vignette\'s state naming it', async () => {
    const calls = answering([{ status: 200, body: reading(0, false) }, { status: 200, body: { result: { scope: 'run', revision: 1, pins: [{ id: 'pin-0a1b2c3d', by: 'person', title: 'Unit 1' }] } } }])
    expect(await pinToRunDashboard(runId as SimulationRunId, { state: '{"title":"Unit 1"}', title: 'Unit 1' }))
      .toBe('Unit 1 is pinned to the dashboard (1 of 8 pins); it shows its pins now, in place of World\'s default')
    expect(calls.map(call => call.path)).toEqual([
      `/api/workspaces/${workspaceId}/world/simulation-runs/${runId}/displays/dashboard/read`,
      `/api/workspaces/${workspaceId}/world/simulation-runs/${runId}/displays/dashboard/update`,
    ])
    expect(calls[1]!.body).toEqual({ scope: 'run', expectedRevision: 0, pin: [{ state: '{"title":"Unit 1"}' }] })
  })

  test('a 409 is read again and the person is told; nothing is retried behind their back', async () => {
    const calls = answering([
      { status: 200, body: reading(0, false) },
      { status: 409, body: { error: { code: 'dashboard_revision_conflict', message: 'The dashboard changed: you read revision 0, it is at 1; read it again', details: { revision: 1 } } } },
      { status: 200, body: reading(1, true) },
    ])
    expect(await pinToRunDashboard(runId as SimulationRunId, { state: '{}', title: 'Unit 1' }))
      .toBe('Unit 1 was not pinned: the dashboard changed since it was read. It was read again (0 of 8 pins, revision 1); try again if you still want to.')
    expect(calls.map(call => call.path.split('/').at(-1))).toEqual(['read', 'update', 'read'])
  })

  test('any other refusal is said in World\'s words', async () => {
    answering([{ status: 200, body: reading(3, true) }, { status: 422, body: { error: { code: 'dashboard_full', message: 'A dashboard holds 8 pins; this change would leave 9: unpin first' } } }])
    expect(await pinToRunDashboard(runId as SimulationRunId, { state: '{}', title: 'Unit 1' })).toBe('Unit 1 was not pinned: A dashboard holds 8 pins; this change would leave 9: unpin first')
    answering([{ status: 403, body: { error: { code: 'dashboard_sided_run', message: 'Dashboards are not offered in a Run whose roles see different sides' } } }])
    expect(await pinToRunDashboard(runId as SimulationRunId, { state: '{}', title: 'Unit 1' })).toBe('Unit 1 was not pinned: Dashboards are not offered in a Run whose roles see different sides')
  })

  test('unpin names the revision the dashboard shows; a 409 shows it again as it stands and says so', () => {
    const page = read('ui/embed/dashboard/Dashboard.svelte')
    expect(page).toContain('const changed = await changeDashboard(runId, { scope: held.scope, expectedRevision: revision, unpin: [section.id] })')
    expect(page).toContain("return staleText(`${section.title} was not unpinned`, again)")
    expect(staleText('Unit 1 was not unpinned', { ok: false, status: 500, code: 'x', message: 'World is down' })).toBe('Unit 1 was not unpinned: the dashboard changed since it was read. Reading it again failed: World is down; try again if you still want to.')
  })
})

describe('the dashboard\'s components', () => {
  for (const file of ['Dashboard.svelte']) {
    test(`${file} compiles without warnings and without a raw $effect`, () => {
      const source = read(`ui/embed/dashboard/${file}`)
      const result = compile(source, { filename: file, generate: 'client', runes: true })
      expect(result.warnings.map(warning => `${warning.code}: ${warning.message}`)).toEqual([])
      expect(source).not.toContain('$effect(')
    })
  }

  test('the embed dispatches the dashboard view type, loading its code only in a dashboard\'s frame; the window shows it beside vignettes', () => {
    const embedded = read('ui/embed/EmbeddedView.svelte')
    expect(embedded).toContain("{:else if dashboard}\n  <!-- A dashboard's frame loads its own code: a display's frame never does (§5.8). -->\n  {#await import('./dashboard/Dashboard.svelte') then { default: Dashboard }}\n    <Dashboard {envelope} />")
    expect(embedded).not.toMatch(/import Dashboard from/)
    expect(embeddedViewListingSchema.parse({ key: 'k', caption: 'c', envelope: dashboard() }).envelope.viewType as string).toBe(DASHBOARD_VIEW_TYPE)
  })
})
