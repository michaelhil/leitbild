import { describe, expect, test } from 'bun:test'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { createActivePackViews } from '../src/core/packs/active-views.ts'
import type { Component } from 'svelte'
import { createWorldPackDescriptor, type PackSurfacePanelContribution, type PackUiContribution, type PackWindowToolsProps, type WorldPackView } from '../src/core/packs/protocol.ts'
import { assertCameraInteractionContract } from '../src/ui/map/map-camera.ts'
import { createMapPromptController, mapPromptOffsets } from '../src/ui/map/map-prompt.ts'
import { knownUiPackIds, loadUiPack } from '../src/ui/pack-loader.ts'
import { geoPointFromLonLat, type IsoTimestamp, type ObjectId, type OperationalObject, type PackId, type SimulationRunId } from '../src/core/model/index.ts'
import { groundClicksWanted, targetPreviewsWanted } from '../src/ui/map-target-routing.ts'
import { assertMapCover, assertMapPrompt, assertMapTargeting, assertPanelInteraction, cameraPaddingFor, mapCameraInteractionFor, noMapCover, openPanelDeclaring, railStartsCollapsed, startingControllerId, surfacePanelPackId } from '../src/ui/surface-panel-interaction.ts'

const panelOf = (id: string, hooks: Pick<PackSurfacePanelContribution, 'mapTargets' | 'keymap'> = {}): PackSurfacePanelContribution => ({
  id,
  label: id,
  defaultOpen: true,
  load: async () => { throw new Error('fixture panels are never loaded') },
  ...hooks,
})

const viewOf = (id: string, ui?: PackUiContribution): WorldPackView => ({
  descriptor: createWorldPackDescriptor({ id, version: '1.0.0', name: id, description: `Fixture ${id}`, contributions: ['presentation'] }),
  presentation: { categories: [], presentObject: () => { throw new Error('fixture Packs present no objects') } },
  ...(ui ? { ui } : {}),
})

const allOn = { doubleClickZoom: true, keyboard: true, boxZoom: true }

describe('display-window tools', () => {
  test('a Pack\'s window tools load lazily, mounted with the Run and the object whose display the window shows', async () => {
    const mounted: Array<PackWindowToolsProps> = []
    const tools = ((_anchor: unknown, props: PackWindowToolsProps) => { mounted.push(props) }) as unknown as Component<PackWindowToolsProps>
    const ui: PackUiContribution = { surfacePanels: [], windowTools: async () => ({ default: tools }) }
    const view = viewOf('tooled', ui)
    const loaded = await view.ui?.windowTools?.()
    expect(loaded?.default).toBe(tools)
    const opened: string[] = []
    const object = { id: 'unit:one' as ObjectId } as OperationalObject
    ;(loaded!.default as unknown as (anchor: unknown, props: PackWindowToolsProps) => void)(null, {
      runId: 'run-1' as SimulationRunId, object, openDisplay: subject => opened.push(subject), controller: false, openAssistant: null,
      runningProcedures: [], openProcedure: () => undefined, room: 'wide', menu: () => undefined,
    })
    expect(mounted.map(({ runId, object: shown }) => ({ runId, objectId: shown.id }))).toEqual([{ runId: 'run-1' as SimulationRunId, objectId: 'unit:one' as ObjectId }])
    mounted[0]!.openDisplay('unit:one#engine')
    expect(opened).toEqual(['unit:one#engine'])
    expect(viewOf('plain', { surfacePanels: [] }).ui?.windowTools).toBeUndefined()
  })

  test('among the built-in Packs only the process plant opens a display on a press of its map icon or rail row, and it gives the window its tools', async () => {
    const views = await Promise.all(knownUiPackIds.map(loadUiPack))
    expect(views.filter(view => view.ui?.displayOnPress === true).map(view => view.descriptor.id)).toEqual(['process-plant'])
    expect((await loadUiPack('process-plant')).ui?.windowTools).toBeDefined()
  })
})

describe('World surface hooks among the built-in Packs', () => {
  test('no built-in Pack but Einsatz declares a map-target panel, a keymap, map gestures, a layout hint or opt-in targeting, and the others leave camera, rail and targeting as they were', async () => {
    expect(knownUiPackIds).toContain('einsatz')
    const views = await Promise.all(knownUiPackIds.map(loadUiPack))
    const declaring = views.filter(view => (view.ui?.surfacePanels ?? []).some(panel => panel.mapTargets !== undefined || panel.keymap !== undefined)
      || view.ui?.mapInteraction !== undefined || view.ui?.surfaceLayout !== undefined
      || view.targeting?.describeTarget !== undefined || view.targeting?.pointTargets !== undefined || view.targeting?.mutedOnMap !== undefined)
    expect(declaring.map(view => view.descriptor.id)).toEqual(['einsatz'])
    // Without Einsatz active, every other Pack's view set is as inert as before the hooks existed.
    const others = views.filter(view => view.descriptor.id !== 'einsatz')
    expect(others.length).toBeGreaterThan(0)
    const panels = others.flatMap(view => view.ui?.surfacePanels ?? [])
    expect(openPanelDeclaring(panels, () => true, 'mapTargets')).toBeNull()
    expect(openPanelDeclaring(panels, () => true, 'keymap')).toBeNull()
    expect(mapCameraInteractionFor(others)).toEqual(allOn)
    expect(railStartsCollapsed(others)).toBe(false)
    const active = createActivePackViews(others)
    expect(active.targeting?.describeTarget).toBeUndefined()
    expect(active.targeting?.pointTargets).toBeUndefined()
    expect(active.targeting?.mutedOnMap).toBeUndefined()
    expect(targetPreviewsWanted({ targeting: active.targeting, panel: null })).toBe(false)
    expect(groundClicksWanted({ targeting: active.targeting, panel: null })).toBe(false)
  })
})

describe('surface panel hooks', () => {
  test('a panel connects exactly the handlers it declares', () => {
    const onMapTarget = () => undefined
    const onKey = () => true
    expect(() => assertPanelInteraction(panelOf('board', { mapTargets: true, keymap: true }), { onMapTarget, onKey })).not.toThrow()
    expect(() => assertPanelInteraction(panelOf('plain'), {})).not.toThrow()
    expect(() => assertPanelInteraction(panelOf('board', { mapTargets: true }), {})).toThrow('declares map targets but connects no onMapTarget')
    expect(() => assertPanelInteraction(panelOf('plain'), { onMapTarget })).toThrow('connects onMapTarget without declaring map targets')
    expect(() => assertPanelInteraction(panelOf('board', { keymap: true }), {})).toThrow('declares a keymap but connects no onKey')
    expect(() => assertPanelInteraction(panelOf('plain'), { onKey })).toThrow('connects onKey without declaring a keymap')
  })

  test('a panel may connect a map-target preview only beside its map targets', () => {
    const onMapTarget = () => undefined
    const previewMapTarget = () => null
    expect(() => assertPanelInteraction(panelOf('board', { mapTargets: true }), { onMapTarget, previewMapTarget })).not.toThrow()
    expect(() => assertPanelInteraction(panelOf('board', { mapTargets: true }), { onMapTarget })).not.toThrow()
    expect(() => assertPanelInteraction(panelOf('plain'), { previewMapTarget })).toThrow('connects previewMapTarget without declaring map targets')
    expect(() => assertPanelInteraction(panelOf('keys', { keymap: true }), { onKey: () => true, previewMapTarget })).toThrow('connects previewMapTarget without declaring map targets')
  })

  test('a panel belongs to the Pack that contributes it', () => {
    const board = panelOf('first.board', { mapTargets: true })
    const packs = [viewOf('first', { surfacePanels: [board] }), viewOf('second', { surfacePanels: [panelOf('second.records')] })]
    expect(surfacePanelPackId(packs, board)).toBe('first')
    expect(() => surfacePanelPackId(packs, panelOf('stray'))).toThrow('Surface panel stray belongs to no active Pack')
  })

  test('the surface selects the first controller at join and after a role switch only while no open panel takes map targets', () => {
    const at = '2026-10-12T08:00:00.000Z' as IsoTimestamp
    const objectOf = (id: string, unit: boolean): OperationalObject => ({
      id: id as ObjectId,
      kind: 'mobile_entity',
      packId: 'first' as PackId,
      label: id,
      lifecycle: 'active',
      revision: 1,
      spatial: { frame: { kind: 'wgs84' }, position: { point: geoPointFromLonLat(11.3, 59.1), observedAt: at } },
      operational: { status: 'normal', mode: 'simulated' },
      alerts: [],
      provenance: { source: 'simulator' },
      timestamps: { createdAt: at, updatedAt: at },
      packData: { unit },
    })
    const objects = [objectOf('task', false), objectOf('unit-1', true), objectOf('unit-2', true)]
    const targeting = {
      isController: (object: OperationalObject) => (object.packData as { readonly unit: boolean }).unit,
      isTarget: () => false,
      buildSetTargetCommand: () => { throw new Error('never sent') },
      buildCancelTargetCommand: () => { throw new Error('never sent') },
    }
    const board = panelOf('first.board', { mapTargets: true })
    const records = panelOf('first.records')
    const views = (panels: ReadonlyArray<PackSurfacePanelContribution>) => createActivePackViews([{ ...viewOf('first', { surfacePanels: panels }), targeting }])
    expect(startingControllerId(objects, views([records]), { objects }, () => true)).toBe('unit-1' as ObjectId)
    expect(startingControllerId(objects, views([records, board]), { objects }, () => true)).toBeNull()
    expect(startingControllerId(objects, views([records, board]), { objects }, panel => panel.id !== board.id)).toBe('unit-1' as ObjectId)
    expect(startingControllerId([objects[0]!], views([records]), { objects }, () => true)).toBeNull()
  })

  test('only an open declaring panel takes map targets or keys', () => {
    const panels = [panelOf('records'), panelOf('board', { mapTargets: true, keymap: true })]
    expect(openPanelDeclaring(panels, () => true, 'mapTargets')?.id).toBe('board')
    expect(openPanelDeclaring(panels, () => true, 'keymap')?.id).toBe('board')
    expect(openPanelDeclaring(panels, panel => panel.id !== 'board', 'keymap')).toBeNull()
  })

  test('active Packs admit one map-target panel and one keymap panel', () => {
    expect(() => createActivePackViews([
      viewOf('first', { surfacePanels: [panelOf('first.board', { keymap: true })] }),
      viewOf('second', { surfacePanels: [panelOf('second.board', { keymap: true })] }),
    ])).toThrow('active Packs declare keymap on more than one surface panel: first.board, second.board')
    expect(() => createActivePackViews([
      viewOf('first', { surfacePanels: [panelOf('first.board', { mapTargets: true })] }),
      viewOf('second', { surfacePanels: [panelOf('second.board', { mapTargets: true })] }),
    ])).toThrow('active Packs declare mapTargets on more than one surface panel')
  })

  test('map gestures go off only where a Pack switches them off, and the rail starts collapsed only on a hint', () => {
    const keyboardPack = viewOf('keys', { surfacePanels: [], mapInteraction: { keyboard: false, doubleClickZoom: false } })
    const boxPack = viewOf('box', { surfacePanels: [], mapInteraction: { boxZoom: false }, surfaceLayout: { railCollapsed: true } })
    expect(mapCameraInteractionFor([viewOf('plain')])).toEqual(allOn)
    expect(mapCameraInteractionFor([viewOf('plain'), keyboardPack])).toEqual({ doubleClickZoom: false, keyboard: false, boxZoom: true })
    expect(mapCameraInteractionFor([keyboardPack, boxPack])).toEqual({ doubleClickZoom: false, keyboard: false, boxZoom: false })
    expect(railStartsCollapsed([keyboardPack])).toBe(false)
    expect(railStartsCollapsed([keyboardPack, boxPack])).toBe(true)
  })
})

describe('camera padding from surface panels', () => {
  test('each edge is padded by the farthest any open panel reaches over it, and nothing without a panel', () => {
    expect(cameraPaddingFor([])).toEqual(noMapCover)
    expect(cameraPaddingFor([{ top: 0, right: 300, bottom: 10, left: 0 }, { top: 40, right: 120, bottom: 0, left: 0 }])).toEqual({ top: 40, right: 300, bottom: 10, left: 0 })
  })

  test('a panel\'s report that is no length is refused, naming the panel and the edge', () => {
    const cover = { top: 0, right: 492, bottom: 0, left: 0 }
    expect(assertMapCover('first.board', cover)).toBe(cover)
    expect(() => assertMapCover('first.board', { top: 0, right: -1, bottom: Number.NaN, left: 0 })).toThrow('Surface panel first.board reported a map cover that is no length: right -1, bottom NaN')
  })
})

describe('map prompts', () => {
  const point = geoPointFromLonLat(11.38, 59.12)
  const option = (label: string) => ({ label, onConfirm: () => undefined })

  test('a prompt has one or two labelled options, and any other is refused naming the panel', () => {
    const onDismiss = () => undefined
    const one = { point, options: [option('Move A4 here')], onDismiss }
    const two = { point, options: [option('After current job'), { ...option('Now (drops C-3 · P3)'), tone: 'warning' as const }], onDismiss }
    expect(assertMapPrompt('fixture.panel', one)).toBe(one)
    expect(assertMapPrompt('fixture.panel', two)).toBe(two)
    expect(() => assertMapPrompt('fixture.panel', { point, options: [], onDismiss })).toThrow('Surface panel fixture.panel showed a map prompt with 0 options; a prompt has one or two')
    expect(() => assertMapPrompt('fixture.panel', { point, options: [option('a'), option('b'), option('c')], onDismiss })).toThrow('with 3 options')
    expect(() => assertMapPrompt('fixture.panel', { point, options: [option('a'), option(' ')], onDismiss })).toThrow('option 2 has no label')
  })

  test('the operator dismissing a prompt takes it off the map and is heard once; a replacement, a clear or teardown is no dismissal', () => {
    const drawn: string[] = []
    const removed: string[] = []
    const dismissed: string[] = []
    let closeDrawn: () => void = () => { throw new Error('nothing drawn') }
    const controller = createMapPromptController({
      getMap: () => ({}) as MapLibreMap,
      onDismiss: prompt => { dismissed.push(prompt.options[0]!.label) },
      draw: (_map, prompt, dismiss) => {
        const label = prompt.options[0]!.label
        drawn.push(label)
        closeDrawn = dismiss
        return { remove: () => { removed.push(label) } }
      },
    })
    const promptOf = (label: string) => ({ point, options: [option(label)], onDismiss: () => undefined })
    const move = promptOf('Move A4 here')
    controller.show(move)
    // A map click elsewhere or Esc.
    expect(controller.dismiss()).toBe(true)
    expect(controller.dismiss()).toBe(false)
    // The same prompt given again stays dismissed; only a new one is drawn.
    controller.show(move)
    expect({ drawn, removed, dismissed }).toEqual({ drawn: ['Move A4 here'], removed: ['Move A4 here'], dismissed: ['Move A4 here'] })
    const busy = promptOf('After current job')
    controller.show(busy)
    // Its ×.
    closeDrawn()
    expect(dismissed).toEqual(['Move A4 here', 'After current job'])
    // The panel replacing or clearing its prompt, and the map going, are no dismissal.
    controller.show(promptOf('Move A4 there'))
    controller.show(promptOf('Move A4 elsewhere'))
    controller.show(null)
    controller.show(promptOf('Move A4 back'))
    controller.destroy()
    expect(controller.dismiss()).toBe(false)
    expect({ drawn, removed, dismissed }).toEqual({
      drawn: ['Move A4 here', 'After current job', 'Move A4 there', 'Move A4 elsewhere', 'Move A4 back'],
      removed: ['Move A4 here', 'After current job', 'Move A4 there', 'Move A4 elsewhere', 'Move A4 back'],
      dismissed: ['Move A4 here', 'After current job'],
    })
  })

  test('wherever the map anchors it, the prompt stands clear of a 44 px tap around its point, above it unless an edge leaves no room', () => {
    for (const [anchor, [x, y]] of Object.entries(mapPromptOffsets)) expect({ anchor, clear: Math.hypot(x, y) >= 22 }).toEqual({ anchor, clear: true })
    expect(mapPromptOffsets.bottom[1]).toBeLessThan(0)
    expect(mapPromptOffsets.center[1]).toBeLessThan(0)
  })
})

describe('map targeting', () => {
  const from = 'unit:a4' as ObjectId
  const target = (id: string, tag = '4 min') => ({ id: id as ObjectId, tag })

  test('an armed order marks every valid target, at most eight of them tagged, none twice or its own object, and any other is refused naming the panel', () => {
    const eight = { from, complete: true, targets: Array.from({ length: 8 }, (_, index) => target(`task:c-${index}`)) }
    expect(assertMapTargeting('fixture.panel', eight)).toBe(eight)
    expect(assertMapTargeting('fixture.panel', { from, complete: false, targets: [] }).targets).toEqual([])
    // Every valid target is marked: beyond the eight tagged ones, untagged.
    const twelve = { from, complete: true, targets: [...eight.targets, ...Array.from({ length: 4 }, (_, index) => ({ id: `task:d-${index}` as ObjectId }))] }
    expect(assertMapTargeting('fixture.panel', twelve)).toBe(twelve)
    // The target a click was just refused for carries the refusal as its tag.
    const refused = { from, complete: true, targets: [{ ...target('task:c-1', 'Needs fire suppression'), tone: 'refused' as const }, target('task:c-2')] }
    expect(assertMapTargeting('fixture.panel', refused)).toBe(refused)
    expect(() => assertMapTargeting('fixture.panel', { from, complete: true, targets: [...eight.targets, target('task:c-9')] })).toThrow('Surface panel fixture.panel showed a map targeting from unit:a4 with 9 tags; at most 8 are shown')
    expect(() => assertMapTargeting('fixture.panel', { from, complete: true, targets: [target('unit:a4')] })).toThrow('that targets its own object')
    expect(() => assertMapTargeting('fixture.panel', { from, complete: true, targets: [target('task:c-1'), target('task:c-1')] })).toThrow('that marks task:c-1 twice')
    expect(() => assertMapTargeting('fixture.panel', { from, complete: true, targets: [target('task:c-1', '')] })).toThrow('whose target task:c-1 has an empty tag')
    expect(() => assertMapTargeting('fixture.panel', { from, complete: true, targets: [{ id: 'task:c-1' as ObjectId, tone: 'refused' as const }] })).toThrow('whose refused target task:c-1 has no tag')
  })
})

describe('map camera contract', () => {
  const fakeMap = () => {
    const handler = (enabled: boolean) => {
      let on = enabled
      return { enable: () => { on = true }, disable: () => { on = false }, isEnabled: () => on }
    }
    return {
      cooperativeGestures: handler(true),
      dragPan: handler(false),
      scrollZoom: handler(true),
      boxZoom: handler(true),
      doubleClickZoom: handler(true),
      touchZoomRotate: handler(true),
      keyboard: handler(true),
    }
  }
  const states = (map: ReturnType<typeof fakeMap>) => Object.fromEntries(Object.entries(map).map(([name, handler]) => [name, handler.isEnabled()]))

  test('keeps every gesture on unless the Packs switch it off, and turns it back on when they no longer do', () => {
    const map = fakeMap()
    assertCameraInteractionContract(map as unknown as MapLibreMap, allOn)
    expect(states(map)).toEqual({ cooperativeGestures: false, dragPan: true, scrollZoom: true, boxZoom: true, doubleClickZoom: true, touchZoomRotate: true, keyboard: true })
    assertCameraInteractionContract(map as unknown as MapLibreMap, { doubleClickZoom: false, keyboard: false, boxZoom: false })
    expect(states(map)).toEqual({ cooperativeGestures: false, dragPan: true, scrollZoom: true, boxZoom: false, doubleClickZoom: false, touchZoomRotate: true, keyboard: false })
    assertCameraInteractionContract(map as unknown as MapLibreMap, allOn)
    expect(states(map)).toEqual({ cooperativeGestures: false, dragPan: true, scrollZoom: true, boxZoom: true, doubleClickZoom: true, touchZoomRotate: true, keyboard: true })
  })

  test('fails visibly when a gesture will not follow the contract', () => {
    const map = { ...fakeMap(), keyboard: { enable: () => undefined, disable: () => undefined, isEnabled: () => false } }
    expect(() => assertCameraInteractionContract(map as unknown as MapLibreMap, allOn)).toThrow('Map camera interactions do not match the contract: keyboard off')
  })
})
