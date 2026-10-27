import type { Map as MapLibreMap } from 'maplibre-gl'
import type { PhysicalGeometryPreparer } from './preparation.ts'
import type {PhysicalArchitectureBspPreparer} from './architecture-bsp-types.ts'
import type { PackPhysicalScene, PackPhysicalSceneDescriptor, PhysicalSceneBounds, PhysicalSceneLevel } from '../../../core/packs/scene.ts'

export type Color = readonly [number, number, number]
export interface PhysicalScenePalette {
  readonly materials: Readonly<Record<string, Color>>
  readonly planMaterials?: Readonly<Record<string, Color>>
  readonly defaultMaterial: Color
  readonly line: Color
  readonly lineOpacity?: number
  readonly contextLineOpacity?: number
  readonly lineWidth?: number
}
export interface PhysicalSceneView {
  readonly mode: '2d' | '3d'
  readonly levelId: string | 'all'
  readonly cutaway: boolean
  readonly separation: number
  readonly detail: 'auto' | 'hidden'
  readonly live: boolean
  /** Include neighbouring layout/context geometry during focused inspection. */
  readonly surroundings?: boolean
  readonly hiddenLayerIds?: ReadonlyArray<string>
  /** Inspection-only architecture transparency; equipment retains its material. */
  readonly wallOpacity?: number
  readonly floorOpacity?: number
}
/** Transient pointer/inspection emphasis; never part of a geometry identity. */
export interface PhysicalSceneHighlight { readonly sceneId: string; readonly occurrenceId: string; readonly color: Color }
/** Owner-qualified severity accent for drawing contours; solid material is architectural truth. */
export interface PhysicalSubjectStyle { readonly color: Color | null; readonly emphasis: number }
export type PhysicalSceneDescriptor = PackPhysicalSceneDescriptor
export interface PhysicalArchitectureOpacity {readonly wallOpacity:number;readonly floorOpacity:number}
export interface PhysicalSceneSource { readonly descriptor: PhysicalSceneDescriptor; readonly load: () => Promise<PackPhysicalScene> }
export interface PhysicalSceneHit {
  readonly sceneId: string
  readonly targetObjectId: string
  readonly occurrenceId: string
  readonly label: string
  readonly subjectIds: ReadonlyArray<string>
  readonly screen: { readonly x: number; readonly y: number }
}
export interface PhysicalScenePresentation {
  readonly descriptor: PhysicalSceneDescriptor
  readonly view: PhysicalSceneView
  readonly status: 'distant' | 'loading' | 'ready' | 'hidden' | 'unavailable'
  readonly reason?: string
  /** Display geometry generation; it is independent of immutable source revision. */
  readonly renderRevision?: number
  /** An incremental mesh request retains the currently valid geometry. */
  readonly layerPreparation?: { readonly status: 'loading' | 'unavailable'; readonly layerIds: ReadonlyArray<string>; readonly reason?: string }
  /** view is actually applied; fractional requested styles remain explicit until ordered geometry is ready. */
  readonly opacityPreparation?: {readonly status:'loading'|'unavailable';readonly requested:PhysicalArchitectureOpacity;readonly reason?:string}
  readonly occurrenceCount: number
}
export interface PhysicalSceneControllerOptions {
  readonly map: MapLibreMap
  readonly palette: PhysicalScenePalette
  /** The physical layer belongs below operational overlays and labels. */
  readonly beforeId: () => string | undefined
  /** Host picking is suspended only after this viewport consumes a drag. */
  readonly suspendPickingForNavigation?: () => (() => void)
  readonly onChange: (scenes: ReadonlyArray<PhysicalScenePresentation>) => void
  readonly reportError: (error: Error) => void
  /** The native Plan host supplies the exact font used by its painter. */
  readonly planFontFamily?: () => string
  /** Full measured map padding including controls/rails; otherwise the map's current padding plus a small margin. */
  readonly fitPadding?: (request?: PhysicalSceneFitRequest) => { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number }
  readonly prepare?: PhysicalGeometryPreparer
  readonly prepareArchitecture?: PhysicalArchitectureBspPreparer
  /** Representation error in CSS pixels; display quality policy, never a scene-count cap. */
  readonly quality?: { readonly pixelError: number }
}
export interface PhysicalCameraPose { readonly center: readonly [number, number]; readonly pitch: number; readonly bearing: number; readonly zoom: number; readonly revision: number; readonly elevation?: number }
export interface PhysicalSceneSurface {
  readonly kind: 'map' | 'canvas'
  readonly element: HTMLElement
  readonly getSize: () => { readonly width: number; readonly height: number }
  readonly getPadding: () => { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number }
  readonly on: (event: 'move' | 'render' | 'resize' | 'movestart', listener: () => void) => () => void
}
export interface PhysicalSceneFocus { readonly scopeId?: string | undefined; readonly occurrenceId?: string | undefined; readonly levelId?: string | undefined; readonly preservePose?: boolean | undefined }
export interface PhysicalViewportFitOptions {
  readonly padding: { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number }
  readonly preservePose: boolean
  readonly mode: '2d' | '3d'
  readonly bearing: number
  readonly pitch?: number
  readonly target?: readonly [number, number, number]
}
/** Measured UI covers choose a rectangle using the actual host camera fit. */
export interface PhysicalSceneFitRequest extends Omit<PhysicalViewportFitOptions, 'padding'> {
  readonly bounds: PhysicalSceneBounds
  /** Larger scores mean a larger displayed model: native Plan zoom or negative 3D distance. */
  readonly measure?: (padding: PhysicalViewportFitOptions['padding']) => number
}
export interface PhysicalProjectedPoint { readonly x: number; readonly y: number; readonly depth: number; readonly visible: boolean }
export interface PhysicalCanvasControllerOptions extends Omit<PhysicalSceneControllerOptions, 'map' | 'beforeId'> { readonly canvas: HTMLCanvasElement }
export const defaultPhysicalSceneView = (levels: ReadonlyArray<PhysicalSceneLevel>): PhysicalSceneView => ({ mode: '2d', levelId: levels[0]?.id ?? 'all', cutaway: true, separation: 0, detail: 'auto', live: true, surroundings: false })
