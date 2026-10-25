import type { Map as MapLibreMap } from 'maplibre-gl'
import type { PackPhysicalScene, PackPhysicalSceneDescriptor, PhysicalSceneBounds, PhysicalSceneLevel } from '../../../core/packs/scene.ts'

export type Color = readonly [number, number, number]
export interface PhysicalScenePalette {
  readonly materials: Readonly<Record<string, Color>>
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
}
export interface PhysicalSubjectStyle { readonly color: Color | null; readonly emphasis: number }
export type PhysicalSceneDescriptor = PackPhysicalSceneDescriptor
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
  readonly occurrenceCount: number
}
export interface PhysicalSceneControllerOptions {
  readonly map: MapLibreMap
  readonly palette: PhysicalScenePalette
  /** The physical layer belongs below operational overlays and labels. */
  readonly beforeId: () => string | undefined
  readonly onChange: (scenes: ReadonlyArray<PhysicalScenePresentation>) => void
  readonly reportError: (error: Error) => void
  /** Full measured map padding including controls/rails; otherwise the map's current padding plus a small margin. */
  readonly fitPadding?: () => { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number }
}
export interface PhysicalCameraPose { readonly center: readonly [number, number]; readonly pitch: number; readonly bearing: number; readonly zoom: number; readonly revision: number }
export interface PhysicalSceneSurface {
  readonly kind: 'map' | 'canvas'
  readonly element: HTMLElement
  readonly getSize: () => { readonly width: number; readonly height: number }
  readonly getPadding: () => { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number }
  readonly on: (event: 'move' | 'render' | 'resize' | 'movestart', listener: () => void) => () => void
}
export interface PhysicalSceneFocus { readonly scopeId?: string; readonly occurrenceId?: string; readonly levelId?: string; readonly preservePose?: boolean }
export interface PhysicalProjectedPoint { readonly x: number; readonly y: number; readonly depth: number; readonly visible: boolean }
export interface PhysicalCanvasControllerOptions extends Omit<PhysicalSceneControllerOptions, 'map' | 'beforeId'> { readonly canvas: HTMLCanvasElement }
export const defaultPhysicalSceneView = (levels: ReadonlyArray<PhysicalSceneLevel>): PhysicalSceneView => ({ mode: '2d', levelId: levels[0]?.id ?? 'all', cutaway: true, separation: 0, detail: 'auto', live: true })
