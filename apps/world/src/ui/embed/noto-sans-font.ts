import { readFile } from 'node:fs/promises'
import subsetFont from 'subset-font'
import type { Plugin } from 'vite'
import { FLOW_TEXT_CHARACTERS } from '../../features/displays/topology/text.ts'

// The embed sets its text in OpenBridge's Noto Sans (plan v5 W6.5; U-26), whose
// widths the composer reserves a flow drawing's text by (features/displays/
// topology/text.ts). So the embed ships just the characters that table
// measures, at every weight the font has: about 20 kB of WOFF2 cut at build
// time from OpenBridge's 625 kB TTF, its glyph advances and kerning kept. A
// character outside it falls back to the system face, and the composer
// reserves it a whole em. It ships as a font file of its own, cached as every
// content-addressed asset is, never inside the embed's JavaScript (§5.8: as a
// data URL it was 27 kB of base64 every display frame parsed).

export const NOTO_SANS_MODULE = 'virtual:noto-sans-subset'
const OPENBRIDGE_FONT = '@oicl/openbridge-webcomponents/dist/NotoSans.ttf'
/** OpenType name ids: copyright, family, subfamily, unique id, full name, version, PostScript name, license, license URL. */
const OFL_NAME_IDS = [0, 1, 2, 3, 4, 5, 6, 13, 14] as const

/** Build-time module whose default export is the URL of the subset font the build emits, and whose `characters` are the ones it carries. */
export const notoSansSubset = (): Plugin => ({
  name: 'leitbild:noto-sans-subset',
  resolveId: source => (source === NOTO_SANS_MODULE ? `\0${NOTO_SANS_MODULE}` : null),
  async load(id) {
    if (id !== `\0${NOTO_SANS_MODULE}`) return null
    const font = await this.resolve(OPENBRIDGE_FONT)
    if (font === null) throw new Error(`cannot resolve ${OPENBRIDGE_FONT}`)
    // The font's own copyright and SIL Open Font License names travel with the subset.
    const subset = await subsetFont(await readFile(font.id), FLOW_TEXT_CHARACTERS, { targetFormat: 'woff2', preserveNameIds: [...OFL_NAME_IDS] })
    const file = this.emitFile({ type: 'asset', name: 'noto-sans-subset.woff2', source: subset })
    return [
      `export default import.meta.ROLLUP_FILE_URL_${file}`,
      `export const characters = ${JSON.stringify(FLOW_TEXT_CHARACTERS)}`,
    ].join('\n')
  },
})
