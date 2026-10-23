/** The flow drawing's geometry as a person sees it (plan v5 §5.5 "Overlap": no text against text, a frame, a symbol
 * or a pipe; stubs end straight ≥ 16 px; vessel gap ≤ 1 px). The pipes, symbols and stops come from the same
 * function the display draws with (`flowDrawing` in the worktree's flow-symbols.ts, given the view and the sample a
 * person sees); the text comes from the page as rendered (render-checks.ts readDrawing: the glyphs' boxes in the
 * drawing's own coordinates), so a font or a width the composer guessed wrong shows as an overlap. */
import type { RenderedDrawing, RenderedLine } from './render-checks.ts'

interface Box { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
type Segment =
  | { readonly kind: 'straight'; readonly connectionId: string; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number; readonly size?: string; readonly decorative?: boolean }
  | { readonly kind: 'corner'; readonly connectionId: string; readonly from: { x: number; y: number }; readonly to: { x: number; y: number }; readonly size?: string; readonly decorative?: boolean }
  | { readonly kind: 'endpoint'; readonly connectionId: string; readonly x: number; readonly y: number; readonly size?: string }
  | { readonly kind: 'arrow'; readonly connectionId: string; readonly x: number; readonly y: number; readonly size?: string }
  | { readonly kind: 'direction'; readonly connectionId: string; readonly x: number; readonly y: number; readonly size?: string }
interface Drawing {
  readonly segments: ReadonlyArray<Segment>
  readonly devices: ReadonlyArray<{ readonly id: string; readonly x: number; readonly y: number }>
  readonly vessels: ReadonlyArray<Box & { readonly id: string; readonly kind: string; readonly trace?: string | null; readonly title?: string }>
  readonly buses: ReadonlyArray<Box & { readonly id: string }>
  readonly texts: ReadonlyArray<{ readonly id: string; readonly title?: string; readonly lines?: ReadonlyArray<{ readonly kind: string; readonly ref?: string }> }>
}

const WORKTREE = new URL('../../', import.meta.url).pathname
/** The display's own drawing function and its stub length, from the worktree under test. */
const drawingModule = async (): Promise<{ readonly flowDrawing: (section: unknown, observations: unknown, alerts: unknown, frozen: boolean) => Drawing; readonly stubStraight: number }> => {
  const symbols = await import(`${WORKTREE}apps/world/src/ui/embed/vignette/flow-symbols.ts`)
  const pipes = await import(`${WORKTREE}apps/world/src/ui/embed/vignette/pipe-segments.ts`).catch(() => ({}))
  return { flowDrawing: symbols.flowDrawing, stubStraight: typeof (pipes as any).STUB_STRAIGHT === 'number' ? (pipes as any).STUB_STRAIGHT : 16 }
}

const HALF_WIDTH: Readonly<Record<string, number>> = { small: 2, medium: 3, large: 4 }
/** OpenBridge's automation button draws a disc about 40 px across at the device's centre. */
const DEVICE_RADIUS = 20
/** A text line's glyph box, less what a font's line box adds above and below the ink. */
const ink = (line: RenderedLine): Box => ({ x: line.x + 1, y: line.y + 2, w: Math.max(0, line.w - 2), h: Math.max(0, line.h - 4) })
const overlap = (a: Box, b: Box): number => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
const circleHits = (box: Box, cx: number, cy: number, r: number): boolean => {
  const dx = cx - Math.max(box.x, Math.min(cx, box.x + box.w)), dy = cy - Math.max(box.y, Math.min(cy, box.y + box.h))
  return dx * dx + dy * dy < (r - 1) * (r - 1)
}
/** The box a pipe piece covers: a straight's run widened by its half width, a corner's square, a cap's end. */
const pieceBox = (segment: Segment): Box | null => {
  const hw = HALF_WIDTH[segment.size ?? 'medium'] ?? 3
  if (segment.kind === 'straight') {
    if ((segment as { decorative?: boolean }).decorative) return null
    return { x: Math.min(segment.x1, segment.x2) - hw, y: Math.min(segment.y1, segment.y2) - hw, w: Math.abs(segment.x2 - segment.x1) + 2 * hw, h: Math.abs(segment.y2 - segment.y1) + 2 * hw }
  }
  if (segment.kind === 'corner') {
    if ((segment as { decorative?: boolean }).decorative) return null
    return { x: Math.min(segment.from.x, segment.to.x) - hw, y: Math.min(segment.from.y, segment.to.y) - hw, w: Math.abs(segment.to.x - segment.from.x) + 2 * hw, h: Math.abs(segment.to.y - segment.from.y) + 2 * hw }
  }
  return { x: segment.x - 5, y: segment.y - 5, w: 10, h: 10 }
}

export interface GeometryResult {
  readonly lines: number
  readonly textAgainstText: ReadonlyArray<string>
  readonly textAgainstPipe: ReadonlyArray<string>
  readonly textAgainstSymbol: ReadonlyArray<string>
  readonly stubs: { readonly ends: number; readonly stubStraight: number; readonly short: ReadonlyArray<string> }
  readonly vesselGaps: ReadonlyArray<{ readonly silhouette: string; readonly at: string; readonly gap: number }>
  readonly drawn: { readonly segments: number; readonly devices: number; readonly vessels: number; readonly silhouettes: number }
  /** Vessel traces (W6.6): each drawn vessel, tank or exchanger, whether the display's model traces it (a tile trace, or
   * a trace line in its text) and whether the page drew that trace's line. */
  readonly traces: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly name: string; readonly modelled: boolean; readonly drawn: boolean }>
}

/** Judges one drawing: the topology section of the view, the sample's observations and alerts, and what the page drew. */
export const judgeDrawing = async (section: unknown, sample: { readonly observations?: unknown; readonly alerts?: unknown } | null, rendered: RenderedDrawing): Promise<GeometryResult> => {
  const { flowDrawing, stubStraight } = await drawingModule()
  const drawing = flowDrawing(section, sample?.observations ?? [], sample?.alerts ?? [], false)
  const lines = rendered.lines.filter(line => line.w > 0 && line.h > 0)
  const name = (line: RenderedLine) => `${line.item}:"${line.text.slice(0, 24)}"`
  // Text against text: two lines of different items, or of one item that run into each other.
  const textAgainstText: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    for (let j = i + 1; j < lines.length; j += 1) {
      const area = overlap(ink(lines[i]!), ink(lines[j]!))
      if (area > 2) textAgainstText.push(`${name(lines[i]!)} × ${name(lines[j]!)} (${Math.round(area)} px²)`)
    }
  }
  // Text against a pipe, a cap, a chevron or a bus bar.
  const pieces = drawing.segments.map(segment => ({ segment, box: pieceBox(segment) })).filter((entry): entry is { segment: Segment; box: Box } => entry.box !== null)
  const textAgainstPipe: string[] = []
  for (const line of lines) {
    const hits = pieces.filter(piece => overlap(ink(line), piece.box) > 4)
    const bars = drawing.buses.filter(bus => overlap(ink(line), bus) > 4)
    if (hits.length + bars.length > 0) textAgainstPipe.push(`${name(line)} × ${[...new Set(hits.map(hit => `${hit.segment.kind} ${hit.segment.connectionId}`))].slice(0, 3).join(', ')}${bars.length > 0 ? `${hits.length > 0 ? ', ' : ''}bus ${bars.map(bus => bus.id).join(', ')}` : ''}`)
  }
  // Text against a symbol: a device's disc, a vessel's drawn silhouette (else its box).
  const silhouettes: ReadonlyArray<Box & { readonly tag: string }> = rendered.silhouettes.length > 0 ? rendered.silhouettes : drawing.vessels.map(vessel => ({ ...vessel, tag: vessel.kind }))
  const textAgainstSymbol: string[] = []
  for (const line of lines) {
    const discs = drawing.devices.filter(device => circleHits(ink(line), device.x, device.y, DEVICE_RADIUS))
    const vessels = silhouettes.filter(vessel => overlap(ink(line), { x: vessel.x + 1, y: vessel.y + 1, w: vessel.w - 2, h: vessel.h - 2 }) > 4)
    if (discs.length + vessels.length > 0) textAgainstSymbol.push(`${name(line)} × ${[...discs.map(device => `device ${device.id}`), ...vessels.map(vessel => vessel.tag)].slice(0, 3).join(', ')}`)
  }
  // Stubs: each pipe that stops ends on a straight of at least stubStraight px (no cap or arrow in a bend).
  const straights = drawing.segments.filter((segment): segment is Extract<Segment, { kind: 'straight' }> => segment.kind === 'straight')
  const ends = drawing.segments.filter((segment): segment is Extract<Segment, { kind: 'endpoint' | 'arrow' }> => segment.kind === 'endpoint' || segment.kind === 'arrow')
  const short = ends.flatMap(end => {
    const pipe = straights.filter(piece => `${piece.connectionId}:end` === end.connectionId || piece.connectionId === end.connectionId)
    const last = pipe.find(piece => (piece.x2 === end.x && piece.y2 === end.y) || (piece.x1 === end.x && piece.y1 === end.y))
    const corners = drawing.segments.filter(segment => segment.kind === 'corner' && (`${segment.connectionId}:end` === end.connectionId || segment.connectionId === end.connectionId))
    if (last !== undefined && pipe.length === 1 && corners.length === 0) return []
    const length = last === undefined ? 0 : Math.abs(last.x2 - last.x1) + Math.abs(last.y2 - last.y1)
    return length >= stubStraight ? [] : [`${end.connectionId} ${Math.round(length)} px`]
  })
  // Vessel gaps: a pipe end heading into a vessel stops at most 1 px short of what the vessel draws.
  const vesselGaps: Array<{ silhouette: string; at: string; gap: number }> = []
  for (const piece of straights) {
    for (const [x, y, dx, dy] of [[piece.x1, piece.y1, piece.x1 - piece.x2, piece.y1 - piece.y2], [piece.x2, piece.y2, piece.x2 - piece.x1, piece.y2 - piece.y1]] as const) {
      for (const vessel of rendered.silhouettes) {
        // Outside the silhouette, heading toward it along the pipe, within 12 px: that distance is the gap.
        const towardX = dx === 0 ? 0 : Math.sign(dx), towardY = dy === 0 ? 0 : Math.sign(dy)
        const gapX = towardX > 0 ? vessel.x - x : towardX < 0 ? x - (vessel.x + vessel.w) : null
        const gapY = towardY > 0 ? vessel.y - y : towardY < 0 ? y - (vessel.y + vessel.h) : null
        const inBand = towardX !== 0 ? y > vessel.y && y < vessel.y + vessel.h : x > vessel.x && x < vessel.x + vessel.w
        const gap = towardX !== 0 ? gapX : gapY
        if (gap !== null && inBand && gap > 1 && gap <= 12) vesselGaps.push({ silhouette: vessel.tag, at: `${Math.round(x)},${Math.round(y)} (${piece.connectionId})`, gap: Math.round(gap * 10) / 10 })
      }
    }
  }
  // Vessel traces: the model's (a tile trace on an exchanger, a trace line in a vessel's or tank's text) against the
  // page's drawn ones (a tile trace inside the vessel's box, a text trace in its block).
  const traceLines = new Set(drawing.texts.filter(text => (text.lines ?? []).some(line => line.kind === 'trace')).map(text => text.id))
  const traces = drawing.vessels.map(vessel => {
    const name = (vessel.title ?? vessel.id).split(' · ')[0]!
    const tile = vessel.trace !== undefined && vessel.trace !== null
    const text = traceLines.has(vessel.id)
    const drawn = rendered.traces.some(trace => trace.drawn && (trace.item === vessel.id || (trace.where === 'tile' && trace.x >= vessel.x - 1 && trace.x + trace.w <= vessel.x + vessel.w + 1 && trace.y >= vessel.y - 1 && trace.y + trace.h <= vessel.y + vessel.h + 1)))
    return { id: vessel.id, kind: vessel.kind, name, modelled: tile || text, drawn }
  })
  return {
    traces,
    lines: lines.length, textAgainstText, textAgainstPipe, textAgainstSymbol,
    stubs: { ends: ends.length, stubStraight, short },
    vesselGaps,
    drawn: { segments: drawing.segments.length, devices: drawing.devices.length, vessels: drawing.vessels.length, silhouettes: rendered.silhouettes.length },
  }
}

/** The topology section a display's compiled view draws first (the one readDrawing reads). */
export const topologyOf = (view: any): unknown => (view?.sections ?? []).find((section: any) => section.kind === 'topology') ?? null
