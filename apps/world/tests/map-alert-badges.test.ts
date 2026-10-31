import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { alertStateSchema, type Priority } from '../src/core/model/alerts.ts'
import { geoPointFromLonLat, nowIso, type IsoTimestamp, type ObjectId, type OperationalObject, type PackId } from '../src/core/model/index.ts'
import type { PackObjectPresentation, PackObjectStatusTone } from '../src/core/packs/protocol.ts'
import { severityTable } from '../src/ui/displays/severity.ts'
import { alertBadge, createMapFeatureStore } from '../src/ui/map-runtime/map-feature-store.ts'

// The live map's alert badges (plan v5 R4 B4, D9): an object's worst alert
// that asks for attention rings its icon in the one severity table's colour
// for the screen's palette; a Pack's colour and status tone never set it.

const read = (path: string): string => readFileSync(join(import.meta.dir, '../src', path), 'utf8')

describe('the live map\'s alert badges take the severity table\'s colours, never a Pack\'s (D9)', () => {
  const at = '2026-07-12T04:00:00.000Z' as IsoTimestamp
  const alert = (id: string, priority: Priority, facets: object = {}) =>
    alertStateSchema.parse({ id, kind: 'test', severity: priority === 'alarm' ? 'critical' : priority === 'notice' ? 'info' : 'warning', message: id, raisedAt: at, acknowledged: false, clock: 'simulation', priority, ...facets })
  const unit = (alerts: ReadonlyArray<ReturnType<typeof alert>>): OperationalObject => ({
    id: 'plant:u1' as ObjectId, kind: 'facility', packId: 'fixture' as PackId, label: 'Unit 1', lifecycle: 'active', revision: 1,
    spatial: { frame: { kind: 'wgs84' }, position: { point: geoPointFromLonLat(11.4, 59.1), observedAt: nowIso() } },
    operational: { status: 'normal', mode: 'simulated' }, alerts: [...alerts], provenance: { source: 'simulator' }, timestamps: { createdAt: nowIso(), updatedAt: nowIso() },
  }) as OperationalObject
  const presented = (color: string, tone: PackObjectStatusTone) => (): PackObjectPresentation => ({ categoryId: 'units', icon: 'factory', color, summary: '', fields: [], status: { tone, label: 'x', indicator: { shape: 'dot' } } })
  const point = (object: OperationalObject, present: () => PackObjectPresentation, alertPalette: 'day' | 'dusk' = 'day') => createMapFeatureStore().update({
    objects: [object], selectedControllerId: null, highlightedObjectIds: [], hiddenObjectCategoryIds: [], alertPalette, placementPoints: [], packFeatures: [], hasNewInfo: () => false, presentationFor: present,
  }).points[0]!

  test('the worst alert asking for attention badges the object in its priority\'s colour, per palette', () => {
    expect(alertBadge(unit([alert('lo', 'caution'), alert('trip', 'alarm')]), 'day')).toEqual({ priority: 'alarm', color: [224, 0, 18, 255] })
    expect(alertBadge(unit([alert('lo', 'caution')]), 'dusk')).toEqual({ priority: 'caution', color: [214, 169, 21, 255] })
    expect(severityTable.caution.rgb?.dusk).toBe('rgb(214, 169, 21)')
    // A standing alarm asks no attention; a notice has no hue; none, no badge.
    expect(alertBadge(unit([alert('stand', 'alarm', { standing: true })]), 'day')).toBeNull()
    expect(alertBadge(unit([alert('note', 'notice')]), 'day')).toBeNull()
    expect(alertBadge(unit([]), 'day')).toBeNull()
  })

  test('a Pack\'s colour and tone neither set nor change it: an "error" tone without an alert gets no badge', () => {
    const alarmed = unit([alert('trip', 'alarm')])
    expect(point(alarmed, presented('#16834f', 'ready')).alert).toEqual(point(alarmed, presented('#dc2626', 'error')).alert)
    expect(point(unit([]), presented('#dc2626', 'error')).alert).toBeNull()
    const layers = read('ui/map-runtime/operational-deck-layers.ts')
    expect(layers).not.toContain("statusTone === 'error'")
    expect(layers).toContain('if (point.alert !== null) return colorWithAlpha(point.alert.color, 230)')
  })
})
