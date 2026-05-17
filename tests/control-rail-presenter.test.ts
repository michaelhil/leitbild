import { describe, expect, test } from 'bun:test'
import { nowIso, type DomainId, type ObjectId, type OperationalObject } from '../src/core/model/index.ts'
import type { PackObjectPresentation } from '../src/core/packs/protocol.ts'
import { buildPresentedCategoryRows } from '../src/ui/control-rail-presenter.ts'
import type { CategoryRow } from '../src/ui/types.ts'

const object = {
  id: 'object:test' as ObjectId,
  label: 'Test Object',
  kind: 'facility',
  domain: 'test' as DomainId,
  lifecycle: 'active',
  revision: 1,
  spatial: { frame: { kind: 'wgs84' } },
  operational: { status: 'ready', mode: 'simulated' },
  alerts: [],
  provenance: { source: 'simulator' },
  timestamps: { createdAt: nowIso(), updatedAt: nowIso() },
} satisfies OperationalObject

const row: CategoryRow = {
  category: {
    id: 'facilities',
    label: 'Facilities',
    emptyLabel: 'No facilities',
    matches: () => true,
  },
  objects: [object],
}

const presentation: PackObjectPresentation = {
  categoryId: 'facilities',
  icon: 'hospital',
  color: '#245b9f',
  summary: 'ready',
  fields: [
    { key: 'capacity', label: 'Capacity', value: '2 / 4' },
    { key: 'crew', label: 'Crew', value: 'available' },
  ],
  status: { tone: 'ready', label: 'Ready', indicator: { shape: 'dot' } },
}

describe('control rail presenter', () => {
  test('derives visible object fields from explicit visibility state', () => {
    const withoutVisibleFields = buildPresentedCategoryRows({
      categoryRows: [row],
      collapsedCategoryIds: {},
      openFieldCategoryId: null,
      visibleFieldsByCategory: {},
      presentationFor: () => presentation,
      hasNewInfo: () => false,
    })

    expect(withoutVisibleFields[0]?.presentedRows[0]?.visibleFields).toEqual([])

    const withVisibleFields = buildPresentedCategoryRows({
      categoryRows: [row],
      collapsedCategoryIds: {},
      openFieldCategoryId: null,
      visibleFieldsByCategory: { facilities: ['capacity'] },
      presentationFor: () => presentation,
      hasNewInfo: () => false,
    })

    expect(withVisibleFields[0]?.fieldOptions.map(field => field.key)).toEqual(['capacity', 'crew'])
    expect(withVisibleFields[0]?.presentedRows[0]?.visibleFields).toEqual([
      { key: 'capacity', label: 'Capacity', value: '2 / 4' },
    ])
  })
})
