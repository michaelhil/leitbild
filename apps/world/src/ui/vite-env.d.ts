declare module '*.css'
declare module '*.mjs?url' {
  const url: string
  export default url
}
declare module 'virtual:openbridge-mimic-font' {
  const url: string
  export default url
}
declare module 'subset-font' {
  const subsetFont: (font: Uint8Array, text: string, options?: { readonly targetFormat?: 'sfnt' | 'truetype' | 'woff' | 'woff2'; readonly preserveNameIds?: ReadonlyArray<number> }) => Promise<Buffer>
  export default subsetFont
}
