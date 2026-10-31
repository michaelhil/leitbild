export type PhysicalFlowGlyph = 'forward' | 'reverse' | 'stopped' | 'unknown' | 'conducting' | 'deenergized'

/** Native-map spatial annotation, independent of alarm colour. The existing
 * route's exact pick/occlusion decides whether this mark can be painted. */
export const drawPhysicalFlowMark = (context: CanvasRenderingContext2D, mark: { readonly point: { readonly x: number; readonly y: number }; readonly angle: number; readonly glyph: PhysicalFlowGlyph }, style: { readonly ink: string; readonly paper: string; readonly fontSize: number; readonly fontFamily: string }): void => {
  const radius = style.fontSize * .6
  context.save()
  try {
    context.translate(mark.point.x, mark.point.y); context.lineJoin = 'round'; context.lineCap = 'round'
    if (mark.glyph === 'forward' || mark.glyph === 'reverse') {
      context.rotate(mark.angle + (mark.glyph === 'reverse' ? Math.PI : 0)); context.beginPath()
      context.moveTo(radius, 0); context.lineTo(-radius, -radius * .65); context.lineTo(-radius * .55, 0); context.lineTo(-radius, radius * .65); context.closePath()
      context.strokeStyle = style.paper; context.lineWidth = 3; context.stroke(); context.fillStyle = style.ink; context.fill()
    } else {
      context.fillStyle = style.paper; context.strokeStyle = style.ink; context.lineWidth = 1.3
      context.beginPath(); context.arc(0, 0, radius, 0, Math.PI * 2); context.fill(); context.stroke()
      context.font = `${style.fontSize}px ${style.fontFamily}`; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillStyle = style.ink
      context.fillText(mark.glyph === 'stopped' ? '0' : mark.glyph === 'conducting' ? 'E' : mark.glyph === 'deenergized' ? '×' : '?', 0, .5)
    }
  } finally { context.restore() }
}
