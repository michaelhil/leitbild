import type { OperationalObject } from '../../core/model/index.ts'
import { statusDiskRadiusPx } from '../map-runtime/symbol-kit.ts'
import type { OperationalPointFeature, Position3 } from '../map-runtime/types.ts'

/**
 * Objects stacked under one tap. Where several icons cover one spot (units
 * parked on a depot), the top one takes every tap and the others cannot be
 * reached. A surface that picks map targets (`targetPicking`, while a panel
 * takes them) then shows a small chooser listing them, and the one chosen is
 * picked as if it had been tapped alone.
 */

export interface ScreenPoint { readonly x: number; readonly y: number }

/**
 * The object a tap on a stack picks without asking: while no controller is
 * highlighted, the one controller the stack holds, when it holds exactly
 * one, as a unit standing on its own task's marker. The tap then highlights
 * it as a tap on it alone would. With a controller highlighted, the tap
 * names a target, and the chooser asks which.
 */
export const stackPick = (
  stack: ReadonlyArray<OperationalObject>,
  controllerHighlighted: boolean,
  isController: (object: OperationalObject) => boolean,
): OperationalObject | null => {
  if (controllerHighlighted) return null
  const controllers = stack.filter(isController)
  return controllers.length === 1 ? controllers[0]! : null
}

/** What a tap does: it lands on the object the map picked, another object is picked for it, or a chooser asks which. */
export type StackTap =
  | { readonly kind: 'tapped' }
  | { readonly kind: 'picked'; readonly object: OperationalObject }
  | { readonly kind: 'chooser'; readonly objects: ReadonlyArray<OperationalObject> }

/**
 * What a tap on the icons under it (`under`, top first, as `objectsUnder`
 * finds them) does. One icon or none: the tap is on the object it landed
 * on. While an order is armed whose valid targets are known (`valid`), a
 * stack shows the chooser of its valid targets only, even of one, so a tap
 * never orders to an object the finger did not choose; a stack holding no
 * valid target is a tap on the object it landed on, which the order's
 * server refuses. Otherwise a stack shows the chooser of all its objects,
 * unless `stackPick` picks one.
 */
export const stackTap = (
  under: ReadonlyArray<OperationalObject>,
  valid: ReadonlySet<string> | null,
  controllerHighlighted: boolean,
  isController: (object: OperationalObject) => boolean,
): StackTap => {
  if (under.length < 2) return { kind: 'tapped' }
  if (valid !== null) {
    const choices = under.filter(object => valid.has(object.id))
    return choices.length === 0 ? { kind: 'tapped' } : { kind: 'chooser', objects: choices }
  }
  const picked = stackPick(under, controllerHighlighted, isController)
  return picked === null ? { kind: 'chooser', objects: under } : { kind: 'picked', object: picked }
}

/**
 * The objects whose icons lie under a point on the map's canvas itself, top
 * first (the last drawn): those whose coloured disk, which covers its glyph,
 * holds the point. No picking radius widens it, so icons that only stand
 * near each other never count as a stack; only icons overlapping where the
 * finger lands do. Labels do not count.
 */
export const objectsUnder = (
  points: ReadonlyArray<OperationalPointFeature>,
  screenOf: (position: Position3) => ScreenPoint,
  at: ScreenPoint,
): ReadonlyArray<OperationalObject> => {
  const seen = new Set<string>()
  const objects: OperationalObject[] = []
  for (const point of [...points].reverse()) {
    if (seen.has(point.object.id)) continue
    const screen = screenOf(point.position)
    if (Math.hypot(screen.x - at.x, screen.y - at.y) > statusDiskRadiusPx(point.sizePx)) continue
    seen.add(point.object.id)
    objects.push(point.object)
  }
  return objects
}
