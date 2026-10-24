import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import * as hb from 'harfbuzzjs'
import { FLOW_TEXT, FLOW_TEXT_CHARACTERS, textFigures, textWidth, type FlowTextStyle } from '../src/features/displays/topology/text.ts'
import { NOTO_SANS_MODULE, notoSansSubset } from '../src/ui/embed/noto-sans-font.ts'

// The drawing's text in OpenBridge's Noto Sans (plan v5 W6.5; U-26; the old mimic-text-metrics and mimic-font tests,
// re-expressed): the composer reserves each line by the font's own advances, held here to the font OpenBridge ships as
// HarfBuzz shapes it at the weights the drawing sets; the embed ships that font cut to those characters.

const FONT = fileURLToPath(import.meta.resolve('@oicl/openbridge-webcomponents/dist/NotoSans.ttf'))
const face = new hb.Face(new hb.Blob(await readFile(FONT)))
const fontAt = (weight: number) => {
  const font = new hb.Font(face)
  font.setVariations([new hb.Variation('wght', weight)])
  return font
}
const fonts = { 400: fontAt(400), 700: fontAt(700) } as const
/** The width HarfBuzz shapes `text` to at `weight` and `size` px, kerning included. */
const shaped = (text: string, weight: 400 | 700, size: number): number => {
  const buffer = new hb.Buffer()
  buffer.addText(text)
  buffer.guessSegmentProperties()
  hb.shape(fonts[weight], buffer)
  return (buffer.getGlyphPositions().reduce((sum, position) => sum + position.xAdvance, 0) * size) / face.upem
}

// Lines as the drawing sets them, in their styles.
const samples: ReadonlyArray<readonly [FlowTextStyle, string]> = [
  ['name', 'Turbine stop valves'], ['name', 'MFW A/B'], ['name', 'from AFW valve A'], ['name', 'to PORV block, Safety valves'], ['name', 'from ACC check valve ×4 +4 more'], ['name', 'Cond pump A/B'],
  ['word', 'OFF LINE'], ['word', 'part open'], ['word', 'STOP 2/2'], ['word', 'Rods off bottom'], ['word', 'LIVE 1/2'],
  ['command', 'CMD RUN'], ['command', 'CMD CLOSED'], ['command', 'CMD 40 %'], ['command', 'CMD trip'],
  ['reading', '15.51 MPa'], ['reading', '4.4×10⁻⁷ A'], ['reading', '1000000 cps'], ['reading', '113 kg/s'], ['reading', '302.4 °C'],
  ['vesselReading', 'LVL 100.0 %'], ['vesselReading', '7.45 MPa'], ['vesselReading', '7533 Pa'],
]

describe('the drawing\'s text widths, measured against Noto Sans (W6.5)', () => {
  test('every character the composer measures advances as OpenBridge\'s Noto Sans sets it, regular and bold', () => {
    for (const weight of [400, 700] as const) {
      const style: FlowTextStyle = weight === 400 ? 'word' : 'command'
      // One character alone, no pair to kern: its advance, rounded up to the px.
      const off = [...FLOW_TEXT_CHARACTERS].filter(character => textWidth(character, style) !== Math.ceil(shaped(character, weight, FLOW_TEXT[style].size)))
      expect(off).toEqual([])
    }
  })

  test('a line\'s reserved width is within 1.5 % of the shaped width (and the px it rounds up to); a name at its bold width', () => {
    for (const [style, text] of samples) {
      // A name is reserved bold: an alert on its item sets it so.
      const real = shaped(text, style === 'name' ? 700 : FLOW_TEXT[style].weight, FLOW_TEXT[style].size)
      const reserved = textWidth(text, style)
      expect({ style, text, within: Math.abs(reserved - real) <= Math.max(1, 0.015 * real) }).toEqual({ style, text, within: true })
    }
  })

  test('figures are tabular, so a value is reserved by how many figures it takes', () => {
    for (const style of ['reading', 'vesselReading'] as const) {
      const size = FLOW_TEXT[style].size
      expect(new Set([...'0123456789'].map(digit => Math.round(shaped(digit, 400, size) * 100))).size).toBe(1)
      expect(textFigures(5, style)).toBe(Math.ceil(shaped('00000', 400, size)))
    }
  })

  test('a character the subset does not carry is reserved a whole em, wider than any it does', () => {
    expect(textWidth('Kjølevann', 'name')).toBeGreaterThan(textWidth('Kjolevann', 'name'))
    expect(textWidth('ø', 'word')).toBe(FLOW_TEXT.word.size)
  })
})

describe('the font the embed ships (the old mimic-font test)', () => {
  test('is OpenBridge\'s Noto Sans cut to the characters the composer measures, a small WOFF2 with its licence names', async () => {
    const plugin = notoSansSubset()
    type Emitted = { readonly type: string; readonly name: string; readonly source: Uint8Array }
    const emitted: Emitted[] = []
    const load = plugin.load as (this: { resolve: (id: string) => Promise<{ id: string }>; emitFile: (file: Emitted) => string }, id: string) => Promise<string>
    const module = await load.call({ resolve: async () => ({ id: FONT }), emitFile: file => { emitted.push(file); return 'font-ref' } }, `\0${NOTO_SANS_MODULE}`)
    const [first, second] = module.split('\n')
    // A font file of its own, its URL the module's default (§5.8: never base64 inside the embed's JavaScript).
    expect(first).toBe('export default import.meta.ROLLUP_FILE_URL_font-ref')
    expect(JSON.parse(second!.replace(/^export const characters = /, ''))).toBe(FLOW_TEXT_CHARACTERS)
    expect(emitted.map(file => [file.type, file.name])).toEqual([['asset', 'noto-sans-subset.woff2']])
    const bytes = Buffer.from(emitted[0]!.source)
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('wOF2')
    expect(bytes.length).toBeLessThan(30_000)
  })
})
