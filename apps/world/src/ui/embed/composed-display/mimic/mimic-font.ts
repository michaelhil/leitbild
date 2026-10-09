import { readFile } from 'node:fs/promises'
import subsetFont from 'subset-font'
import type { Plugin } from 'vite'
import metrics from '../../../../packs/process-plant/displays/mimic/openbridge-text-metrics.json'
import { mimicLegend } from './mimic-legend.ts'

// A mimic sets its text in OpenBridge's Noto Sans, whose widths the server
// measured (text-metrics.ts); a label with a character the table lacks is
// refused when the mimic is composed. So the embed ships only the measured
// glyphs and its key's, at every weight the font has: about 22 kB of WOFF2
// built from OpenBridge's 625 kB TTF. Glyph advances and kerning are kept.

export const MIMIC_FONT_MODULE = 'virtual:openbridge-mimic-font'
const OPENBRIDGE_FONT = '@oicl/openbridge-webcomponents/dist/NotoSans.ttf'
/** OpenType name ids: copyright, family, subfamily, unique id, full name, version, PostScript name, license, license URL. */
const OFL_NAME_IDS = [0, 1, 2, 3, 4, 5, 6, 13, 14] as const

/** Every character a mimic can set: what the text table measured, and its key. */
export const mimicFontCharacters = (): ReadonlyArray<string> => [...new Set([
  ...Object.values(metrics.styles).flatMap(style => Object.keys(style.advance)),
  ...Object.values(mimicLegend).flatMap(text => [...text]),
])].sort()

/** Build-time module whose default export is the subset font as a data URL, loaded with the lazy mimic chunk. */
export const openBridgeMimicFont = (): Plugin => ({
  name: 'leitbild:openbridge-mimic-font',
  resolveId: source => (source === MIMIC_FONT_MODULE ? `\0${MIMIC_FONT_MODULE}` : null),
  async load(id) {
    if (id !== `\0${MIMIC_FONT_MODULE}`) return null
    const font = await this.resolve(OPENBRIDGE_FONT)
    if (font === null) throw new Error(`cannot resolve ${OPENBRIDGE_FONT}`)
    // The font's own copyright and SIL Open Font License names travel with the subset.
    const subset = await subsetFont(await readFile(font.id), mimicFontCharacters().join(''), { targetFormat: 'woff2', preserveNameIds: [...OFL_NAME_IDS] })
    return `export default ${JSON.stringify(`data:font/woff2;base64,${subset.toString('base64')}`)}`
  },
})
