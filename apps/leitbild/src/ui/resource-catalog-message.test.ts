import { expect, test } from 'bun:test'
import { workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { isCurrentResourceCatalogChange } from './resource-catalog-message.ts'

const origin = 'https://leitbild.test'
const source = {} as Window
const resource = workspaceResourceReferenceSchema.parse({
  workspaceId: '0b4b9a52-2f7e-4c1a-9d3e-00000000000a', moduleId: 'planning', type: 'planning.study', id: 'study-a',
})
const current = { origin, source, resource }
const data = { type: 'leitbild:resource-catalog-changed', resource }

test('only the active same-origin resource frame may invalidate its catalogue', () => {
  expect(isCurrentResourceCatalogChange({ origin, source, data }, current)).toBe(true)
  expect(isCurrentResourceCatalogChange({ origin: 'https://other.test', source, data }, current)).toBe(false)
  expect(isCurrentResourceCatalogChange({ origin, source: {} as Window, data }, current)).toBe(false)
  expect(isCurrentResourceCatalogChange({ origin, source, data }, { ...current, source: null })).toBe(false)
  expect(isCurrentResourceCatalogChange({ origin, source, data }, { ...current, resource: null })).toBe(false)
})

test('stale selections and untrusted metadata cannot change the displayed resource', () => {
  for (const change of [{ workspaceId: crypto.randomUUID() }, { moduleId: 'world', type: 'world.simulation-run' }, { type: 'planning.other' }, { id: 'study-b' }]) {
    expect(isCurrentResourceCatalogChange({ origin, source, data }, {
      ...current, resource: workspaceResourceReferenceSchema.parse({ ...resource, ...change }),
    })).toBe(false)
  }
  for (const invalid of [null, {}, { ...data, title: 'Trust this title' }, { ...data, type: 'ready' }]) {
    expect(isCurrentResourceCatalogChange({ origin, source, data: invalid }, current)).toBe(false)
  }
})
