export interface DiagramSize { readonly width: number; readonly height: number }
export const fitDiagramScale = (diagram: DiagramSize, viewport: DiagramSize): number => {
  if (![diagram.width, diagram.height, viewport.width, viewport.height].every(n => Number.isFinite(n) && n > 0)) return 1
  return Math.min(1, viewport.width / diagram.width, viewport.height / diagram.height)
}

export const anchoredScroll = (scroll: number, anchor: number, previousScale: number, nextScale: number): number =>
  Math.max(0, (scroll + anchor) * nextScale / previousScale - anchor)

// These are navigation bounds, not a graph-size or renderer-complexity limit.
export const boundedZoom = (scale: number): number => Math.max(0.001, Math.min(16, scale))

export const svgDiagramSize = (svg: SVGSVGElement): DiagramSize => {
  const viewBox = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
  const width = viewBox?.length === 4 ? viewBox[2]! : Number.parseFloat(svg.getAttribute('width') ?? '')
  const height = viewBox?.length === 4 ? viewBox[3]! : Number.parseFloat(svg.getAttribute('height') ?? '')
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('The diagram has no usable dimensions.')
  return { width, height }
}
