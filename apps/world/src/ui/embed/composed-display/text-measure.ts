// Text widths in a panel's font, measured as the browser draws them, so a name
// is fitted to the room it actually has rather than to a count of characters.
const context = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')

export const textMeasure = (font: string): ((text: string) => number) => text => {
  if (context === null) throw new Error('fitting names needs a 2D canvas to measure them')
  context.font = font
  return context.measureText(text).width
}

/** The panels' text font (Noto Sans, as OpenBridge sets it). */
export const panelFont = (size: number, weight = 400): string => `${weight} ${size}px "Noto Sans", system-ui, sans-serif`
