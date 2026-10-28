import type { PhysicalFlowGlyph } from '../displays/physical-flow-marks.ts'

export interface PhysicalFlowMark {
  readonly kind: 'flow'
  readonly key: string
  readonly sceneId: string
  readonly occurrenceId: string
  readonly elementId: string
  readonly point: { readonly x: number; readonly y: number }
  readonly angle: number
  readonly glyph: PhysicalFlowGlyph
  readonly rank: number
}

const same = (left: PhysicalFlowMark, right: PhysicalFlowMark): boolean =>
  left.key === right.key && left.sceneId === right.sceneId && left.occurrenceId === right.occurrenceId && left.elementId === right.elementId
  && left.glyph === right.glyph && left.rank === right.rank && left.angle === right.angle && left.point.x === right.point.x && left.point.y === right.point.y

/** Keep only the current immutable presentation. Fresh readings with identical
 * projected geometry and discrete flow meaning must not repaint static ink. */
export const createPhysicalFlowPresentation = () => {
  let current: ReadonlyArray<PhysicalFlowMark> = []
  return (next: ReadonlyArray<PhysicalFlowMark>): ReadonlyArray<PhysicalFlowMark> => {
    if (current.length === next.length && next.every((mark, index) => same(current[index]!, mark))) return current
    const previous = new Map(current.map(mark => [mark.key, mark])), seen = new Set<string>()
    const retained = next.map(mark => {
      if (seen.has(mark.key)) throw Error('Flow presentation needs unique projected mark keys')
      seen.add(mark.key)
      const prior = previous.get(mark.key)
      return prior && same(prior, mark) ? prior : mark
    })
    current = retained
    return retained
  }
}
