import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { MIMIC_FONT_MODULE, mimicFontCharacters, openBridgeMimicFont } from '../src/ui/embed/composed-display/mimic/mimic-font.ts'
import { mimicLegend } from '../src/ui/embed/composed-display/mimic/mimic-legend.ts'
import { unmeasurable } from '../src/packs/process-plant/displays/mimic/text-metrics.ts'

describe('the font a mimic ships', () => {
  test('covers every character the server measures and the key, and nothing else', () => {
    const characters = new Set(mimicFontCharacters())
    for (const text of Object.values(mimicLegend)) for (const character of text) expect(characters.has(character)).toBe(true)
    const measured = [...characters].filter(character => unmeasurable('tag', character).length === 0)
    expect(characters.size - measured.length).toBeLessThanOrEqual([...new Set(Object.values(mimicLegend).join(''))].length)
  })

  test('is OpenBridge\'s Noto Sans cut to those glyphs, a small WOFF2', async () => {
    const plugin = openBridgeMimicFont()
    const font = fileURLToPath(import.meta.resolve('@oicl/openbridge-webcomponents/dist/NotoSans.ttf'))
    const load = plugin.load as (this: { resolve: (id: string) => Promise<{ id: string }> }, id: string) => Promise<string>
    const module = await load.call({ resolve: async () => ({ id: font }) }, `\0${MIMIC_FONT_MODULE}`)
    const url = JSON.parse(module.replace(/^export default /, '')) as string
    expect(url).toStartWith('data:font/woff2;base64,')
    const bytes = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('wOF2')
    expect(bytes.length).toBeLessThan(40_000)
  })
})
