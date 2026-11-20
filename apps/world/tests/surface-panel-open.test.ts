import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { objectIdSchema } from '../src/core/model/index.ts'
import type { PackSurfacePanelContribution } from '../src/core/packs/protocol.ts'
import { loadUiPack } from '../src/ui/pack-loader.ts'
import { armedPanelStays, openPanelDeclaring, surfacePanelIsOpen, type MapTargeting } from '../src/ui/surface-panel-interaction.ts'

const panelOf = (id: string, defaultOpen: boolean, hooks: Pick<PackSurfacePanelContribution, 'mapTargets'> = {}): PackSurfacePanelContribution => ({
  id,
  label: id,
  defaultOpen,
  load: async () => { throw new Error('fixture panels are never loaded') },
  ...hooks,
})

describe('surface panel open state', () => {
  test('a panel this tab never touched follows its declared defaultOpen', () => {
    expect(surfacePanelIsOpen(panelOf('a.open', true), {})).toBe(true)
    expect(surfacePanelIsOpen(panelOf('a.closed', false), {})).toBe(false)
  })

  test('a choice this tab made wins over the default, both ways', () => {
    expect(surfacePanelIsOpen(panelOf('a.open', true), { 'a.open': false })).toBe(false)
    expect(surfacePanelIsOpen(panelOf('a.closed', false), { 'a.closed': true })).toBe(true)
  })

  test('a panel whose choice is gone follows its default again', () => {
    const panel = panelOf('a.open', true)
    expect(surfacePanelIsOpen(panel, { 'a.open': false })).toBe(false)
    expect(surfacePanelIsOpen(panel, {})).toBe(true)
  })

  test('a default-open map-target panel takes map clicks before anyone opens it', () => {
    const panels = [panelOf('a.list', false), panelOf('a.board', true, { mapTargets: true })]
    expect(openPanelDeclaring(panels, panel => surfacePanelIsOpen(panel, {}), 'mapTargets')?.id).toBe('a.board')
    expect(openPanelDeclaring(panels, panel => surfacePanelIsOpen(panel, { 'a.board': false }), 'mapTargets')).toBeNull()
  })

  test('the Packs whose panel is their working surface open it by default', async () => {
    for (const packId of ['einsatz', 'situation-monitor', 'electric-grid']) {
      const view = await loadUiPack(packId)
      const panels = view.ui?.surfacePanels ?? []
      expect(panels.length).toBeGreaterThan(0)
      for (const panel of panels) expect(surfacePanelIsOpen(panel, {})).toBe(panel.defaultOpen)
      expect(panels.some(panel => panel.defaultOpen)).toBe(true)
    }
  })

  test('the rail\'s toggle leaves the open map-target panel in place while it arms an order', () => {
    const board = panelOf('a.board', true, { mapTargets: true }), list = panelOf('a.list', true)
    const armed: Record<string, MapTargeting> = { 'a.board': { from: objectIdSchema.parse('unit:a'), targets: [], complete: false } }
    expect(armedPanelStays('a.board', board, armed)).toBe(true)
    // Nothing armed, another panel, or no open map-target panel: the toggle acts.
    expect(armedPanelStays('a.board', board, { 'a.board': null })).toBe(false)
    expect(armedPanelStays('a.board', board, {})).toBe(false)
    expect(armedPanelStays(list.id, board, armed)).toBe(false)
    expect(armedPanelStays('a.board', null, armed)).toBe(false)
    // The rail's one toggle asks before it changes anything, and says why it refused in the status line.
    const route = readFileSync(new URL('../src/ui/routes/ControlSurfaceRoute.svelte', import.meta.url), 'utf8')
    expect(route).toMatch(/const toggleSurfacePanel = \(panelId: string\): void => \{\s*const panel = [^\n]*\s*if \(!panel\) return\s*if \(armedPanelStays\(panelId, mapTargetPanelContribution, panelMapTargetings\)\) \{ status = 'Finish or cancel the armed order before hiding this panel'; return \}\s*setSurfacePanelOpen\(/)
  })

  test('the World surface reads panel open state only through surfacePanelIsOpen', () => {
    // fff1009a0 replaced `?? panel.defaultOpen` with `?? false` at six reads and hid the Einsatz Board in every Run.
    const route = readFileSync(new URL('../src/ui/routes/ControlSurfaceRoute.svelte', import.meta.url), 'utf8')
    expect(route.match(/surfacePanelOpen\[[^\]]+\]\s*\?\?/g) ?? []).toEqual([])
  })
})
