import { describe, expect, test } from 'bun:test'
import { composeAttribution, composeAttributionFromManifest } from '../src/ui/map/reference-attribution.ts'
import { osmOdbl, nveNlod20, repoOwned } from '../src/reference-data/licences.ts'

describe('composeAttribution', () => {
  test('joins per-licence attribution lines with middot', () => {
    const out = composeAttribution([osmOdbl, nveNlod20])
    expect(out).toContain('OpenStreetMap')
    expect(out).toContain('NVE')
    expect(out).toContain(' • ')
  })

  test('deduplicates by licence id', () => {
    const out = composeAttribution([osmOdbl, osmOdbl, nveNlod20])
    expect(out.split(' • ').length).toBe(2)
  })

  test('empty input produces empty string', () => {
    expect(composeAttribution([])).toBe('')
  })

  test('single licence has no separator', () => {
    const out = composeAttribution([repoOwned])
    expect(out).not.toContain(' • ')
    expect(out).toContain('Leitbild')
  })
})

describe('composeAttributionFromManifest', () => {
  test('reads attribution from manifest licence entries', () => {
    const out = composeAttributionFromManifest({
      licences: [
        { id: 'a', attribution: '© A' },
        { id: 'b', attribution: '© B' },
        { id: 'a', attribution: '© A' }, // duplicate by id
      ],
    })
    expect(out).toBe('© A • © B')
  })
})
