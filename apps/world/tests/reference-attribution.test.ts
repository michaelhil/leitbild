import { describe, expect, test } from 'bun:test'
import { composeAttribution, composeAttributionFromManifest } from '../src/ui/map/reference-attribution.ts'
import { ccByNcSa40, nlod20, repoOwned } from '../src/reference-data/licences.ts'

describe('composeAttribution', () => {
  test('joins per-licence attribution lines with middot', () => {
    const out = composeAttribution([ccByNcSa40, nlod20])
    expect(out).toContain('OpenAIP')
    expect(out).toContain('Avinor')
    expect(out).toContain(' • ')
  })

  test('deduplicates by licence id', () => {
    const out = composeAttribution([ccByNcSa40, ccByNcSa40, nlod20])
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
