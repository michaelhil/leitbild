declare module '*.css'
declare module '*.mjs?url' {
  const url: string
  export default url
}
declare module 'virtual:noto-sans-subset' {
  /** The embed's Noto Sans subset as a data URL (ui/embed/noto-sans-font.ts). */
  const url: string
  export default url
  /** The characters it carries. */
  export const characters: string
}
declare module 'subset-font' {
  const subsetFont: (font: Uint8Array, text: string, options?: { readonly targetFormat?: 'sfnt' | 'truetype' | 'woff' | 'woff2'; readonly preserveNameIds?: ReadonlyArray<number> }) => Promise<Buffer>
  export default subsetFont
}
