import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { PackSurfacePanelContribution } from '../src/core/packs/protocol.ts'
import { loadUiPack } from '../src/ui/pack-loader.ts'
import { openPanelDeclaring, surfacePanelIsOpen } from '../src/ui/surface-panel-interaction.ts'

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

  test('resetting the local view (no choices) opens a default-open panel again', () => {
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

  test('the World surface reads panel open state only through surfacePanelIsOpen', () => {
    // fff1009a0 replaced `?? panel.defaultOpen` with `?? false` at six reads and hid the Einsatz Board in every Run.
    const route = readFileSync(new URL('../src/ui/routes/ControlSurfaceRoute.svelte', import.meta.url), 'utf8')
    expect(route.match(/surfacePanelOpen\[[^\]]+\]\s*\?\?/g) ?? []).toEqual([])
  })
})
