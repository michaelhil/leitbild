// A flow drawing's key (plan v5 W6.7; U-05, #35): one row under the drawing
// naming what it draws, generated from it: each pipe look it uses, drawn by
// OpenBridge's own pipe renderer (flow, with its chevron; no flow; not
// known), the bold CMD word of a command an item does not follow in its
// outline, and the dashed outline of items whose alerts are all expected,
// after what. Pure: FlowLegend.svelte draws it.
import type { Segment } from '@oicl/connector-diagram'
import type { FlowDrawing } from './flow-symbols.ts'

export type LegendKey =
  | { readonly kind: 'pipe'; readonly text: string; readonly segments: ReadonlyArray<Segment> }
  | { readonly kind: 'command'; readonly text: string }
  | { readonly kind: 'expected'; readonly text: string }

/** A pipe key's canvas, in px. */
export const LEGEND_PIPE = { width: 32, height: 12 } as const

const pipe = (value: Segment['value'], chevron: boolean): ReadonlyArray<Segment> => {
  const y = LEGEND_PIPE.height / 2
  const base = { connectionId: `legend-${value}`, value, size: 'medium' as const }
  return [
    { kind: 'straight', ...base, x1: 1, y1: y, x2: LEGEND_PIPE.width - 1, y2: y },
    ...(chevron ? [{ kind: 'direction' as const, ...base, x: LEGEND_PIPE.width / 2, y, direction: 'right' as const }] : []),
  ]
}

/** The keys of what a drawing draws, in the order a reader meets them: the pipes, then the outlines. */
export const legendKeys = (drawing: Pick<FlowDrawing, 'segments' | 'texts' | 'expectedAfter'>): ReadonlyArray<LegendKey> => {
  const looks = new Set(drawing.segments.map(segment => (segment.kind === 'direction' ? 'chevron' : segment.value)))
  return [
    ...(looks.has('chevron') ? [{ kind: 'pipe' as const, text: 'flow', segments: pipe('open-flow', true) }] : []),
    ...(looks.has('empty') ? [{ kind: 'pipe' as const, text: 'no flow', segments: pipe('empty', false) }] : []),
    ...(looks.has('closed-dash') ? [{ kind: 'pipe' as const, text: 'not known', segments: pipe('closed-dash', false) }] : []),
    ...(drawing.texts.some(text => text.lines.some(line => line.kind === 'command' && line.text !== '')) ? [{ kind: 'command' as const, text: 'command not followed' }] : []),
    ...(drawing.texts.some(text => text.outline === 'expected') ? [{ kind: 'expected' as const, text: drawing.expectedAfter.length === 0 ? 'expected' : `expected after ${drawing.expectedAfter.join(', ')}` }] : []),
  ]
}
