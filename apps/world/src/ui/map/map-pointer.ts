/**
 * What the map does with the pointer it last saw. Hover cards, target
 * previews and an armed order's line to the pointer are for a mouse. A touch
 * screen follows a tap with a compatibility mousemove: shown a hover card for
 * it, WebKit drops the tap's click because content appeared, and the object
 * it leaves hovered is stale by the next press. So the map tracks the type of
 * the last pointer
 * it saw (`PointerEvent.pointerType`), and before any it shows nothing on
 * hover. A finger also needs a bigger target than an icon: a tap picks
 * objects within a radius around it, a mouse click only under it.
 */

/** Whether a hover over an object shows its card and target preview: only for a mouse. */
export const hoverCardsFor = (pointerType: string | null): boolean => pointerType === 'mouse'

/** The smallest target a tap needs (A9, touch first): 44 px square. */
export const touchTargetPx = 44

/**
 * How far around the pointer a press picks an object, in px: nothing for a
 * mouse, which points exactly, and before any pointer; for a finger or a
 * pen, enough that an icon of `iconPx` takes a tap anywhere in a
 * `touchTargetPx` square around it.
 */
export const pickingRadiusFor = (pointerType: string | null, iconPx: number): number =>
  pointerType === null || pointerType === 'mouse' ? 0 : Math.max(0, Math.ceil((touchTargetPx - iconPx) / 2))

/**
 * Whether an icon's coloured disk takes a click, not only its glyph's
 * strokes: only while the surface picks map targets (`targetPicking`) and the
 * pointer picks exactly, with no radius, as a mouse does. A click between the
 * strokes is then the object's, never the ground's. A finger or a pen already
 * picks within a radius around the strokes, which the larger disk would
 * widen; every other surface picks the glyph alone, as it always has.
 */
export const disksPickFor = (targetPicking: boolean, pickingRadiusPx: number): boolean => targetPicking && pickingRadiusPx === 0
