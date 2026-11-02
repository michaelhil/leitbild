import { expect, test } from 'bun:test'
import { initialRunViewPreferences, readRunViewPreferences, runViewPreferencesKey, writeRunViewPreferences } from '../src/ui/run-view-preferences.ts'
test('clean defaults are generic and explicit choices survive only their Workspace/Run browser session', () => {
  const data = new Map<string, string>(), storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
  const a = runViewPreferencesKey('workspace-a', 'run-a'), b = runViewPreferencesKey('workspace-a', 'run-b')
  expect(readRunViewPreferences(storage, a)).toEqual({ guidance: { mode: 'running', dismissedId: null, presentedId: null }, alarms: false, layout: false, panels: {} })
  const chosen = { guidance: { mode: 'paused' as const, dismissedId: 'orientation', presentedId: 'orientation' }, alarms: true, layout: true, panels: { 'some-pack.panel': true } }
  writeRunViewPreferences(storage, a, chosen)
  expect(readRunViewPreferences(storage, a)).toEqual(chosen); expect(readRunViewPreferences(storage, b)).toEqual(initialRunViewPreferences())
  expect(readRunViewPreferences(storage, runViewPreferencesKey('workspace-b', 'run-a'))).toEqual(initialRunViewPreferences())
  expect(Object.keys(chosen)).not.toContain('acknowledged')
})
test('corrupt or unavailable browser storage does not break initial Run presentation', () => {
  const bad = ['null', '{', '{"guidance":false}', '{"guidance":{"mode":"running","dismissedId":null,"presentedId":null},"alarms":true,"layout":false,"panels":{"x":"true"}}', '{"guidance":{"mode":"unknown","dismissedId":null,"presentedId":null},"alarms":true,"layout":false,"panels":{}}']
  for (const value of bad) expect(readRunViewPreferences({ getItem: () => value, setItem: () => {} }, 'key')).toEqual(initialRunViewPreferences())
  const blocked = { getItem: (): string => { throw new Error('denied') }, setItem: (): void => { throw new Error('denied') } }
  expect(readRunViewPreferences(blocked, 'key')).toEqual(initialRunViewPreferences())
  expect(() => writeRunViewPreferences(blocked, 'key', initialRunViewPreferences())).not.toThrow()
})
