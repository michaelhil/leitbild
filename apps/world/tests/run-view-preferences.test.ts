import { expect, test } from 'bun:test'
import { initialRunViewPreferences, readRunViewPreferences, runViewPreferencesKey, writeRunViewPreferences, type RunViewPreferences } from '../src/ui/run-view-preferences.ts'

const defaults: RunViewPreferences = { guidance: { mode: 'running', dismissedId: null, presentedId: null }, alarms: false, layout: false, panels: {}, layers: {}, weather: true, categories: {}, layoutMode: '2d' }
const reading = (value: string): RunViewPreferences => readRunViewPreferences({ getItem: () => value, setItem: () => {} }, 'key')

test('clean defaults are generic and explicit choices survive only their Workspace/Run browser session', () => {
  const data = new Map<string, string>(), storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
  const a = runViewPreferencesKey('workspace-a', 'run-a'), b = runViewPreferencesKey('workspace-a', 'run-b')
  expect(initialRunViewPreferences()).toEqual(defaults)
  expect(readRunViewPreferences(storage, a)).toEqual(defaults)
  const chosen: RunViewPreferences = {
    guidance: { mode: 'paused', dismissedId: 'orientation', presentedId: 'orientation' }, alarms: true, layout: true, panels: { 'some-pack.panel': true },
    layers: { 'some-pack.lines': false, 'some-pack.live': true }, weather: false, categories: { 'process-plants': false }, layoutMode: '3d',
  }
  writeRunViewPreferences(storage, a, chosen)
  expect(readRunViewPreferences(storage, a)).toEqual(chosen); expect(readRunViewPreferences(storage, b)).toEqual(defaults)
  expect(readRunViewPreferences(storage, runViewPreferencesKey('workspace-b', 'run-a'))).toEqual(defaults)
  expect(Object.keys(chosen)).not.toContain('acknowledged')
})

test('layer, Weather, category-eye and Plan or 3D choices are read back exactly; only choices made are stored', () => {
  const stored = { ...defaults, layers: { lines: false }, weather: false, categories: { units: false, sites: true }, layoutMode: '3d' as const }
  expect(reading(JSON.stringify(stored))).toEqual(stored)
  // An untouched group or category has no entry: its reader gives it the Pack's default.
  expect(reading(JSON.stringify(defaults)).layers).toEqual({})
  expect(reading(JSON.stringify(defaults)).categories).toEqual({})
})

test('a record of another shape, such as one written before a field existed, reads once as the defaults', () => {
  const before = { guidance: defaults.guidance, alarms: true, layout: true, panels: { 'some-pack.panel': true } }
  expect(reading(JSON.stringify(before))).toEqual(defaults)
  for (const field of ['layers', 'weather', 'categories', 'layoutMode'] as const) {
    const { [field]: _missing, ...rest } = { ...defaults, alarms: true }
    expect(reading(JSON.stringify(rest)), field).toEqual(defaults)
  }
  const wrong: ReadonlyArray<Record<string, unknown>> = [
    { layers: { lines: 'false' } }, { layers: [] }, { layers: null }, { weather: 'true' }, { weather: null },
    { categories: { units: 0 } }, { categories: [true] }, { layoutMode: 'plan' }, { layoutMode: null }, { layoutMode: 3 }, { panels: [] },
  ]
  for (const fields of wrong) expect(reading(JSON.stringify({ ...defaults, alarms: true, ...fields })), JSON.stringify(fields)).toEqual(defaults)
})

test('corrupt or unavailable browser storage does not break initial Run presentation', () => {
  const bad = ['null', '{', '[]', '{"guidance":false}', JSON.stringify({ ...defaults, panels: { x: 'true' } }), JSON.stringify({ ...defaults, guidance: { ...defaults.guidance, mode: 'unknown' } })]
  for (const value of bad) expect(reading(value)).toEqual(defaults)
  const blocked = { getItem: (): string => { throw new Error('denied') }, setItem: (): void => { throw new Error('denied') } }
  expect(readRunViewPreferences(blocked, 'key')).toEqual(defaults)
  expect(() => writeRunViewPreferences(blocked, 'key', defaults)).not.toThrow()
})
