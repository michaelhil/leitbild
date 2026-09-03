import { expect, test } from 'bun:test'
import { searchMapSymbols, isMapSymbol } from './catalog.ts'
import common from './common.json'
test('map artwork and semantic icon discovery share the pinned catalogue', () => {
  expect(searchMapSymbols({ text: 'surveillance' }).icons.map(icon => icon.id)).toContain('cctv')
  expect(searchMapSymbols({}).total).toBeGreaterThan(1600)
  for (const id of Object.keys(common)) expect(isMapSymbol(id)).toBe(true)
  expect(searchMapSymbols({ ids: ['cctv'], artwork: true }).icons[0]!.svg).toContain('<svg')
  expect(searchMapSymbols({ ids: ['cctv'] }).icons[0]!.svg).toBeUndefined()
  expect(() => searchMapSymbols({ ids: ['does-not-exist'] })).toThrow('Unknown icon')
})
