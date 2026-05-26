import { describe, expect, test } from 'bun:test'
import {
  aeroNorwayDefaultsOn,
  createMapLayersPanel,
  defaultVisibility,
  type MapLayersStorage,
} from '../src/ui/map/map-layers-panel-state.ts'

const memoryStorage = (): MapLayersStorage => {
  const map = new Map<string, string>()
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => { map.set(k, v) },
  }
}

const categories = ['fir', 'tma', 'ctr', 'airport', 'restricted', 'exclusion'] as const

describe('defaultVisibility', () => {
  test('sets ON for categories in defaultsOn, OFF for others', () => {
    const v = defaultVisibility(categories, ['tma', 'airport'])
    expect(v.tma).toBe(true)
    expect(v.airport).toBe(true)
    expect(v.fir).toBe(false)
  })

  test('covers every supplied category', () => {
    const v = defaultVisibility(categories, [])
    expect(Object.keys(v).sort()).toEqual([...categories].sort())
  })
})

describe('createMapLayersPanel', () => {
  test('initialises with defaults', () => {
    const ctrl = createMapLayersPanel({
      datasetId: 'aero-norway',
      categories: [...categories],
      defaultsOn: ['tma', 'airport'],
      controlInstanceId: null,
    })
    expect(ctrl.isVisible('tma')).toBe(true)
    expect(ctrl.isVisible('fir')).toBe(false)
  })

  test('toggle flips a category and returns a fresh controller', () => {
    const ctrl = createMapLayersPanel({
      datasetId: 'aero-norway',
      categories: [...categories],
      defaultsOn: ['tma'],
      controlInstanceId: null,
    })
    const after = ctrl.toggle('fir')
    expect(after.isVisible('fir')).toBe(true)
    expect(ctrl.isVisible('fir')).toBe(false) // original unchanged
  })

  test('setAll(true) turns every category on', () => {
    const ctrl = createMapLayersPanel({
      datasetId: 'aero-norway',
      categories: [...categories],
      defaultsOn: [],
      controlInstanceId: null,
    })
    const all = ctrl.setAll(true)
    for (const c of categories) expect(all.isVisible(c)).toBe(true)
  })

  test('setAll(false) turns every category off', () => {
    const ctrl = createMapLayersPanel({
      datasetId: 'aero-norway',
      categories: [...categories],
      defaultsOn: [...categories],
      controlInstanceId: null,
    })
    const none = ctrl.setAll(false)
    for (const c of categories) expect(none.isVisible(c)).toBe(false)
  })

  test('persists to storage when controlInstanceId is supplied', () => {
    const storage = memoryStorage()
    const ctrl = createMapLayersPanel({
      datasetId: 'aero-norway',
      categories: [...categories],
      defaultsOn: ['tma'],
      controlInstanceId: 'halden',
      storage,
    })
    ctrl.toggle('fir')
    const raw = storage.get('leitbild:layers:aero-norway:halden')
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    expect(parsed.fir).toBe(true)
  })

  test('does not persist when controlInstanceId is null', () => {
    const storage = memoryStorage()
    const ctrl = createMapLayersPanel({
      datasetId: 'aero-norway',
      categories: [...categories],
      defaultsOn: [],
      controlInstanceId: null,
      storage,
    })
    ctrl.toggle('tma')
    expect(storage.get('leitbild:layers:aero-norway:null')).toBeNull()
  })

  test('reads back persisted state on construction', () => {
    const storage = memoryStorage()
    storage.set(
      'leitbild:layers:aero-norway:halden',
      JSON.stringify({ fir: true, tma: false }),
    )
    const ctrl = createMapLayersPanel({
      datasetId: 'aero-norway',
      categories: [...categories],
      defaultsOn: ['tma'],
      controlInstanceId: 'halden',
      storage,
    })
    expect(ctrl.isVisible('fir')).toBe(true)
    expect(ctrl.isVisible('tma')).toBe(false)
  })

  test('persisted entries for unknown categories are ignored', () => {
    const storage = memoryStorage()
    storage.set(
      'leitbild:layers:aero-norway:halden',
      JSON.stringify({ unknown_category: true }),
    )
    const ctrl = createMapLayersPanel({
      datasetId: 'aero-norway',
      categories: [...categories],
      defaultsOn: ['tma'],
      controlInstanceId: 'halden',
      storage,
    })
    expect(ctrl.isVisible('unknown_category' as never)).toBe(false)
    expect(ctrl.isVisible('tma')).toBe(true)
  })

  test('garbage in storage falls back to defaults', () => {
    const storage = memoryStorage()
    storage.set('leitbild:layers:aero-norway:halden', 'not json')
    const ctrl = createMapLayersPanel({
      datasetId: 'aero-norway',
      categories: [...categories],
      defaultsOn: ['tma'],
      controlInstanceId: 'halden',
      storage,
    })
    expect(ctrl.isVisible('tma')).toBe(true)
  })
})

describe('aeroNorwayDefaultsOn', () => {
  test('matches the documented defaults', () => {
    expect(aeroNorwayDefaultsOn).toEqual([
      'cta', 'tma', 'ctr', 'restricted', 'prohibited', 'danger', 'airport', 'exclusion',
    ])
  })
})
