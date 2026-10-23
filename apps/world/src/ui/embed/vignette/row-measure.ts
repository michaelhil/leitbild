import type { RowFont } from './alerts.ts'

// How wide an alert row's parts are written (AlertRowLine.svelte's fonts), measured once per text on a canvas in the
// page's own font, so a list knows which rows fit one line before it lays them out. Marks are bold 12 px spaced
// 0.03 em; the detail is 12 px; the message the vignette's 13 px.

const FONTS: Readonly<Record<RowFont, { readonly size: number; readonly weight: number; readonly spacing: number }>> = {
  message: { size: 13, weight: 400, spacing: 0 },
  mark: { size: 12, weight: 700, spacing: 0.03 },
  detail: { size: 12, weight: 400, spacing: 0 },
}

/** A measure of row parts in px; where the page has no canvas, a width by characters that never says a long row fits. */
export const rowMeasure = (): ((text: string, font: RowFont) => number) => {
  const context = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  const family = typeof document === 'undefined' ? 'sans-serif' : getComputedStyle(document.body).fontFamily || 'sans-serif'
  const known = new Map<string, number>()
  return (text, font) => {
    const key = `${font}|${text}`
    const cached = known.get(key)
    if (cached !== undefined) return cached
    const style = FONTS[font]
    let width: number
    if (context === null) width = text.length * style.size * 0.62
    else {
      context.font = `${style.weight} ${style.size}px ${family}`
      width = context.measureText(text).width
    }
    const spaced = Math.ceil(width + text.length * style.spacing * style.size)
    known.set(key, spaced)
    return spaced
  }
}
