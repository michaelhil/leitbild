import { describe, expect, test } from 'bun:test'
import type { IsoTimestamp, OperationalObject } from '../../core/model/index.ts'
import { createActivePackViews } from '../../core/packs/active-views.ts'
import { assertContributionDescriptor } from '../../core/packs/assembly.ts'
import { scenarioDefinitionSchema } from '../../core/scenarios/definition.ts'
import { compileScenarioDefinition } from '../../core/scenarios/compiler.ts'
import { createDirectRoutingAdapter } from '../../routing/direct-adapter.ts'
import { mapCameraInteractionFor, openPanelDeclaring, railStartsCollapsed, surfacePanelPackId } from '../../ui/surface-panel-interaction.ts'
import { borderDefinitions } from './fixtures/border-harness.ts'
import { at, blue, config, cycles, place, red, stateWith, types } from './fixtures/combat-harness.ts'
import { definitionOf, lonLat, openRun, taskItem, unitItem } from './fixtures/run-harness.ts'
import { trackDataSchema } from './engine/combat-model.ts'
import { engineObjects } from './engine/objects.ts'
import { config as engineConfig, low, templates, types as engineTypes } from './fixtures/engine-harness.ts'
import { einsatzCommandIds } from './capabilities.ts'
import { einsatzPack } from './pack.ts'
import { einsatzDispatchPanelId, einsatzPackView } from './ui-pack.ts'
import { dispatchWords } from './ui/dispatch-words.ts'

const { categories, presentObject } = einsatzPackView.presentation
const recordType = (object: OperationalObject): unknown => (object.packData as { readonly type?: unknown }).type

/** Every object of an engagement in which one side holds a contact, identified tracks and a track on a unit it saw destroyed. */
const engagementObjects = async (): Promise<OperationalObject[]> => {
  const hold = (unitId: string) => ({ kind: 'set-roe' as const, unitId, roe: 'hold' as const })
  const free = (unitId: string) => ({ kind: 'set-roe' as const, unitId, roe: 'free' as const })
  const state = (await cycles(await stateWith([
    place('r1', types.redGun, red, at(0)),
    hold('r1'),
    place('s1', types.blueScout, blue, at(900)),
    place('r2', types.redGun, red, at(1_150)),
    place('w1', types.watcher, blue, at(0, -400)),
    place('b1', types.blueGun, blue, at(0, 1_800)),
    free('b1'),
    place('far', types.redGun, red, at(-1_800)),
    hold('far'),
  ]), 90)).state
  return engineObjects(state, () => ({ at: new Date(state.timeMs).toISOString() as IsoTimestamp, provenance: { source: 'simulator' } }))
}

const trackTier = (object: OperationalObject): string | undefined => {
  const parsed = trackDataSchema.safeParse(object.packData)
  return parsed.success ? parsed.data.tier : undefined
}

describe('Einsatz presentation', () => {
  test('presents every unit, task, track and track index of an engagement in exactly the category that matches it', async () => {
    const objects = await engagementObjects()
    const tiers = new Set(objects.map(trackTier))
    expect([...tiers].filter(tier => tier !== undefined).sort()).toEqual(['contact', 'destroyed', 'identified'])
    expect(objects.some(object => (object.packData as { readonly type?: unknown }).type === 'track-index')).toBe(true)
    for (const object of objects) {
      const presentation = presentObject(object, { objects })
      expect(categories.filter(category => category.matches(object)).map(category => category.id)).toEqual([presentation.categoryId])
    }
  })

  test('a contact shows a neutral icon and colour and nothing of its type or side; identified and destroyed tracks show what was seen', async () => {
    const objects = await engagementObjects()
    const tracks = objects.filter(object => trackTier(object) !== undefined)
    const contacts = tracks.filter(object => trackTier(object) === 'contact')
    expect(contacts.length).toBeGreaterThan(0)
    const typeWords = config.unitTypes.flatMap(type => [type.label, type.icon])
    const sideWords = (borderDefinitions.scripted.sides ?? []).flatMap(side => [side.id, side.label, side.colour])
    const contactLooks = new Set<string>()
    for (const contact of contacts) {
      const presentation = presentObject(contact, { objects })
      contactLooks.add(`${presentation.icon} ${presentation.color}`)
      expect(presentation.fields.map(field => field.key)).toEqual(['tier', 'fix'])
      const shown = JSON.stringify(presentation)
      for (const word of [...typeWords, ...sideWords]) expect(shown.includes(word)).toBe(false)
    }
    expect(contactLooks.size).toBe(1)
    for (const track of tracks.filter(object => trackTier(object) !== 'contact')) {
      const data = trackDataSchema.parse(track.packData)
      const presentation = presentObject(track, { objects })
      if (data.identity !== undefined) {
        expect(presentation.icon).toBe(data.identity.icon)
        expect(presentation.summary).toContain(data.identity.typeLabel)
        expect(contactLooks.has(`${presentation.icon} ${presentation.color}`)).toBe(false)
      }
      expect(presentation.muted).toBe(data.tier === 'destroyed')
    }
    for (const index of objects.filter(object => (object.packData as { readonly type?: unknown }).type === 'track-index')) {
      expect(presentObject(index, { objects }).mapIconVisible).toBe(false)
    }
  })
})

describe('Einsatz UI declarations', () => {
  test('the Dispatch panel is the Pack\'s one surface panel: open by default, taking map targets, no keymap, under the static label "Dispatch" its header shows too, under an id whose first segment is the Pack\'s', () => {
    const panels = einsatzPackView.ui.surfacePanels
    expect(panels.map(panel => ({ id: panel.id, label: panel.label, defaultOpen: panel.defaultOpen, mapTargets: panel.mapTargets, keymap: 'keymap' in panel })))
      .toEqual([{ id: einsatzDispatchPanelId, label: dispatchWords.panel, defaultOpen: true, mapTargets: true, keymap: false }])
    expect(dispatchWords.panel).toBe('Dispatch')
    expect(einsatzDispatchPanelId).toBe('einsatz.dispatch')
    expect(einsatzDispatchPanelId.split('.')[0]).toBe(einsatzPackView.descriptor.id)
    const active = createActivePackViews([einsatzPackView])
    expect(openPanelDeclaring(active.surfacePanels, () => true, 'mapTargets')?.id).toBe(einsatzDispatchPanelId)
    expect(openPanelDeclaring(active.surfacePanels, () => true, 'keymap')).toBeNull()
    expect(surfacePanelPackId(active.packs, panels[0]!)).toBe(einsatzPackView.descriptor.id)
  })

  test('the panel\'s Pack is found through a copy of its panel, as the route\'s deep state hands it over a different proxy per path', () => {
    const active = createActivePackViews([einsatzPackView])
    const proxied = new Proxy(active.surfacePanels[0]!, {})
    expect(proxied).not.toBe(einsatzPackView.ui.surfacePanels[0])
    expect(surfacePanelPackId(active.packs, proxied)).toBe(einsatzPackView.descriptor.id)
    expect(surfacePanelPackId(active.packs, { ...einsatzPackView.ui.surfacePanels[0]! })).toBe(einsatzPackView.descriptor.id)
    expect(() => surfacePanelPackId(active.packs, { ...einsatzPackView.ui.surfacePanels[0]!, id: 'other.dispatch' })).toThrow('Surface panel other.dispatch belongs to no active Pack')
  })

  test('the Pack switches off double-click zoom only, so a double-click acts as one click; keyboard pan and box zoom stay; the rail starts collapsed', () => {
    expect(einsatzPackView.ui.mapInteraction).toEqual({ doubleClickZoom: false })
    expect(mapCameraInteractionFor([einsatzPackView])).toEqual({ doubleClickZoom: false, keyboard: true, boxZoom: true })
    expect(railStartsCollapsed([einsatzPackView])).toBe(true)
  })

  test('the descriptor declares every contribution the Pack makes, targeting, its interaction handlers and its wiki page included, so registering it is not refused', () => {
    expect(einsatzPackView.descriptor.contributions.map(contribution => contribution.kind).sort()).toEqual(['interactions', 'knowledge', 'presentation', 'runtime', 'scenario', 'targeting'])
    expect(() => assertContributionDescriptor(einsatzPack)).not.toThrow()
  })

  test('no Einsatz category takes a rail section: the Dispatch panel is the only list', async () => {
    expect(categories.map(category => category.rail)).toEqual(categories.map(() => false))
    const definition = scenarioDefinitionSchema.parse(definitionOf([unitItem('u1', engineTypes.roadCarrier, lonLat(0)), taskItem('t1', templates.load, lonLat(0.01), { [low]: 1 })]))
    const compiled = await compileScenarioDefinition(definition, [einsatzPack], { routing: createDirectRoutingAdapter() })
    expect(compiled.view.rail.sections).toEqual([])
    // A Starting View may still name one.
    const named = await compileScenarioDefinition({ ...definition, view: { ...definition.view, rail: { sections: [{ categoryId: categories[0]!.id, visible: true, collapsed: false, visibleFields: [] }] } } }, [einsatzPack], { routing: createDirectRoutingAdapter() })
    expect(named.view.rail.sections.map(section => section.categoryId)).toEqual([categories[0]!.id])
  })

  test('the generic map path never sends an Einsatz order; units that move are map controllers, so their clicks reach the panel; sites, tasks and tracks never are', async () => {
    const objects = await engagementObjects()
    const unitObject = objects.find(object => recordType(object) === 'unit')!
    const { targeting } = einsatzPackView
    expect(targeting.isTarget()).toBe(false)
    expect(() => targeting.buildSetTargetCommand(unitObject)).toThrow('Einsatz map orders go through the Dispatch panel')
    expect(() => targeting.buildCancelTargetCommand(unitObject)).toThrow('Einsatz map orders go through the Dispatch panel')
    expect('mutedOnMap' in targeting).toBe(false)
    for (const object of objects) expect(targeting.isController(object)).toBe(recordType(object) === 'unit' && object.kind === 'mobile_entity')
    expect(objects.some(object => targeting.isController(object))).toBe(true)

    const run = await openRun({ items: [unitItem('u1', engineTypes.roadCarrier, lonLat(0)), unitItem('u2', engineTypes.roadCarrier, lonLat(0.001)), unitItem('h1', engineTypes.publicSite, lonLat(0.02)), taskItem('t1', templates.load, lonLat(0.01), { [low]: 2 })], paused: true })
    try {
      const listed = run.run.snapshot().objects
      expect(['u1', 'h1', 't1'].map(id => targeting.isController(listed.find(object => object.id === id)!))).toEqual([true, false, false])
    } finally {
      await run.close()
    }
  })

  test('the map fades committed units and fully covered calls and keeps completed calls as history dots', async () => {
    const run = await openRun({ items: [unitItem('u1', engineTypes.roadCarrier, lonLat(0)), unitItem('u2', engineTypes.roadCarrier, lonLat(0.001)), unitItem('h1', engineTypes.publicSite, lonLat(0.02)), taskItem('t1', templates.load, lonLat(0.01), { [low]: 2 })], paused: true })
    try {
      const objects = run.run.snapshot().objects
      const objectOf = (id: string) => objects.find(object => object.id === id)!
      const present = (object: OperationalObject) => presentObject(object, { objects })
      const iconOf = (typeId: string) => engineConfig.unitTypes.find(type => type.id === typeId)!.icon
      expect(present(objectOf('u1'))).toMatchObject({ mapLabel: 'U1 · AV', status: { tone: 'ready' }, icon: iconOf(engineTypes.roadCarrier) })
      expect(present(objectOf('u1')).mapMarker).toBeUndefined()
      expect(present(objectOf('h1'))).toMatchObject({ mapLabel: 'H1', icon: iconOf(engineTypes.publicSite) })
      expect(present(objectOf('h1')).status).toBeUndefined()
      expect(present(objectOf('t1'))).toMatchObject({ mapLabel: 'T1', icon: engineConfig.taskTemplates.find(template => template.id === templates.load)!.icon })
      // Every unit is drawn: no screen-side filter hides one.
      for (const object of objects) expect(present(object).mapIconVisible).not.toBe(false)
      const current = (id: string) => presentObject(run.object(id)!, { objects: run.run.snapshot().objects })
      const closed = { ...objectOf('h1'), packData: { ...(objectOf('h1').packData as object), accepting: false } } as OperationalObject
      expect(present(closed)).toMatchObject({ mapLabel: 'H1 · closed', mapMarker: 'muted' })
      expect(present(objectOf('t1')).status).toEqual({ tone: 'idle', label: 'open', indicator: { shape: 'dot', pulse: true } })
      expect((await run.invoke(einsatzCommandIds.order, { units: ['u1'], stops: [{ taskId: 't1' }] })).ok).toBe(true)
      expect(current('u1')).toMatchObject({ mapMarker: 'muted', status: { tone: 'working' } })
      expect(current('t1').mapMarker).toBeUndefined()
      expect(current('t1').status?.indicator.pulse).toBe(true)
      expect((await run.invoke(einsatzCommandIds.order, { units: ['u2'], stops: [{ taskId: 't1' }] })).ok).toBe(true)
      expect(current('t1')).toMatchObject({ mapMarker: 'muted', glance: [expect.any(String), 'All needs covered'] })
      expect(current('t1').status).toBeUndefined()

      const history = presentObject({ ...objectOf('t1'), lifecycle: 'resolved' }, { objects })
      expect(history).toMatchObject({ mapMarker: 'dot', muted: true, color: '#b46e50', glance: [expect.any(String), 'Completed'] })
      expect(history.mapLabel).toBeUndefined()
    } finally {
      await run.close()
    }

    const objects = await engagementObjects()
    const currentTime = new Date(Math.max(...objects.map(object => Date.parse(object.timestamps.updatedAt)))).toISOString() as IsoTimestamp
    for (const object of objects) {
      const data = object.packData as { readonly type: string; readonly integrity?: string }
      const presentation = presentObject(object, { objects, currentTime })
      // A place that never moves shows no phase while it stands.
      if (data.type === 'unit') expect(presentation.mapLabel).toMatch(object.kind === 'facility' ? new RegExp(`^${object.label}( · X)?( · DMG)?$`) : new RegExp(`^${object.label} · [A-Z]+( · DMG)?$`))
      if (data.type === 'unit' && data.integrity === 'damaged') expect(presentation.mapLabel).toEndWith(' · DMG')
      if (data.type === 'unit' && data.integrity === 'destroyed') expect(presentation.status?.tone).toBe('error')
      if (data.type === 'track') {
        expect(presentation.mapLabel).toMatch(new RegExp(`^${object.label} · \\d+:\\d\\d$`))
        expect(presentObject(object, { objects }).mapLabel).toBe(object.label)
      }
    }
  })

  test('a place that never moves is labelled with its name alone: no phase such as "AV", and no free or committed dot', async () => {
    const run = await openRun({ definition: borderDefinitions.scripted, paused: true })
    try {
      const objects = run.run.snapshot().objects
      const places = objects.filter(object => recordType(object) === 'unit' && object.kind === 'facility')
      expect(places.length).toBeGreaterThan(0)
      for (const object of places) {
        const presentation = presentObject(object, { objects })
        expect(presentation.status).toBeUndefined()
        expect(presentation.mapLabel === object.label || presentation.mapLabel === `${object.label} · closed`).toBe(true)
      }
    } finally {
      await run.close()
    }
  })
})
