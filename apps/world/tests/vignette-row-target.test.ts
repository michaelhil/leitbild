import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AlertRow } from '../src/features/displays/alerts/rows.ts'
import { alertRowTarget } from '../src/ui/embed/vignette/row-target.ts'

// W9.2 (plan v5 §3, UX T10, F29): one grammar for alert rows and entity rows on every Pack.
const row = (alert: Record<string, unknown>, objectId = 'o:1'): AlertRow => ({ objectId, alert: { id: 'a', message: 'm', ...alert } }) as unknown as AlertRow

describe('what a press on an alert row opens', () => {
  test('the element it is on (a plant item, a grid branch), in any list', () => {
    expect(alertRowTarget(row({ subject: { element: 'sgA' }, observable: 'plant:1#x' }, 'plant:1'), false)).toEqual({ kind: 'element', objectId: 'plant:1', elementId: 'sgA' })
  })

  test('the group it is on, as its object\'s element (a grid island)', () => {
    expect(alertRowTarget(row({ subject: { group: 'island:bus:x' } }, 'grid:1'), false)).toEqual({ kind: 'element', objectId: 'grid:1', elementId: 'island:bus:x' })
  })

  test('the observable it judges (a weather zone\'s visibility: its trend)', () => {
    expect(alertRowTarget(row({ observable: 'weather:z#visibilityM' }, 'weather:z'), false)).toEqual({ kind: 'subject', subject: 'weather:z#visibilityM' })
  })

  test('in a list of several objects, the object it is on; in its own object\'s list, nothing, and no button', () => {
    expect(alertRowTarget(row({}, 'unit:amb-1'), true)).toEqual({ kind: 'subject', subject: 'unit:amb-1' })
    expect(alertRowTarget(row({}, 'unit:amb-1'), false)).toBeNull()
  })

  test('the alerts section and the entity table open them through the vignette\'s opening', () => {
    const section = readFileSync(join(import.meta.dir, '../src/ui/embed/vignette/AlertsSection.svelte'), 'utf8')
    expect(section).toContain("const target = alertRowTarget(row, section.objectIds === 'run' || section.objectIds.length > 1)")
    expect(section).toContain("target.kind === 'element' ? opening.element(target.objectId, target.elementId) : opening.subject(target.subject)")
    const table = readFileSync(join(import.meta.dir, '../src/ui/embed/vignette/EntityTable.svelte'), 'utf8')
    expect(table).toContain('void opening?.subject(row.objectId)')
    expect(table).toContain('const opens = $derived(opening !== undefined && opening.where !== null)')
    expect(table).toContain('<button type="button" class="open" aria-label={`Open ${row.label}`}')
    const opening = readFileSync(join(import.meta.dir, '../src/ui/embed/vignette/opening.svelte.ts'), 'utf8')
    expect(opening).toContain("element: async (objectId, elementId, how = 'select') => requestElement({ objectId, elementId, how }) ? null : openDefault(`${objectId}#${elementId}`)")
    expect(opening).toContain('subject: openDefault,')
  })
})

describe('an alert on a subject group its Pack declares as an element (a grid island)', () => {
  const island = (id: string, label?: string) => ({ ...row({ subject: { group: id }, priority: 'alarm' }, 'grid:1'), group: { objectId: 'grid:1', subjectGroup: id, ...(label === undefined ? {} : { label }) } }) as unknown as AlertRow

  test('its tile is named by the element, never by the group id', async () => {
    const { alertTiles } = await import('../src/features/displays/alerts/census.ts')
    const tiles = alertTiles([island('island:bus:a', 'Island at Hasle trafostasjon 420 kV'), island('island:bus:b', 'Island at Halden PWR switchyard')])
    expect(tiles.map(tile => tile.label)).toEqual(['Island at Hasle trafostasjon 420 kV', 'Island at Halden PWR switchyard'])
    const view = readFileSync(join(import.meta.dir, '../src/features/displays/compose/view.ts'), 'utf8')
    expect(view).toContain('declared.get(row.objectId)?.declaration?.elements.find(element => element.id === row.group.subjectGroup)?.label')
  })

  test('the element\'s own alerts list it, in the sample and in the section', async () => {
    const { inSection } = await import('../src/ui/embed/vignette/alerts.ts')
    expect(inSection({ objectIds: ['grid:1'], elements: ['island:bus:a'] })(island('island:bus:a'))).toBe(true)
    expect(inSection({ objectIds: ['grid:1'], elements: ['island:bus:b'] })(island('island:bus:a'))).toBe(false)
    const view = readFileSync(join(import.meta.dir, '../src/features/displays/compose/view.ts'), 'utf8')
    expect(view).toContain('|| (subjectOf(row) !== undefined && view.elements?.includes(subjectOf(row)!) === true)')
  })
})
