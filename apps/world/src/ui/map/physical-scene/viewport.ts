import type { PhysicalSceneBounds } from '../../../core/packs/scene.ts'
import type { PhysicalLayerEntry } from './layer.ts'
import type { PhysicalCameraPose, PhysicalProjectedPoint, PhysicalProjectedPointVisitor, PhysicalSceneHit, PhysicalSceneHighlight, PhysicalScenePalette, PhysicalSceneSurface, PhysicalViewportFitOptions } from './types.ts'
import type { Vector3 } from './math.ts'
import type { PhysicalBackendMetrics } from './backend.ts'
import type {PhysicalArchitectureBsp} from './architecture-bsp-types.ts'
import type {PhysicalArchitectureBspFrame} from './architecture-cohort.ts'
export type PhysicalViewportEvent = 'change' | 'resize' | 'render' | 'movestart' | 'style' | 'idle' | 'contextlost' | 'contextrestored'
export interface PhysicalViewportRenderer {
  readonly setPalette: (palette: PhysicalScenePalette) => void
  readonly setHighlight: (target: PhysicalSceneHighlight | null) => void
  readonly setArchitectureBsp: (asset: PhysicalArchitectureBsp|null,frame:PhysicalArchitectureBspFrame|null) => void
  readonly retainGeometryIdentities: (identities: ReadonlySet<string>) => void
  readonly dispose: () => void
  readonly invalidatePicks: () => void
  readonly metrics: () => PhysicalBackendMetrics | null
  readonly pick: (point: { x: number; y: number }) => PhysicalSceneHit | null
  readonly cheapProject: (sceneId: string, occurrenceId: string, levelId?: string) => PhysicalProjectedPoint | null
  readonly visibleAt: (sceneId: string, occurrenceId: string, point: { x: number; y: number }) => boolean
  readonly project: (sceneId: string, occurrenceId: string, levelId?: string) => PhysicalProjectedPoint | null
  /** Project actual local path points with the displayed occurrence's level offset. */
  readonly visitOccurrencePoints: (sceneId: string, occurrenceId: string, points: ReadonlyArray<Vector3>, visit: PhysicalProjectedPointVisitor, levelId?: string) => void
}
export interface PhysicalViewport {
  readonly surface: PhysicalSceneSurface
  readonly ready: () => boolean
  readonly on: (event: PhysicalViewportEvent, listener: () => void) => () => void
  /** Conservative visibility includes camera-inside, height and horizon cases. */
  readonly intersectsBounds: (bounds: PhysicalSceneBounds, mode: '2d' | '3d') => boolean
  readonly projectGeographic: (point: { lng: number; lat: number }) => { x: number; y: number }
  readonly requestRender: () => void
  readonly installRenderer: (entries: () => ReadonlyArray<PhysicalLayerEntry>, palette: PhysicalScenePalette, reportError: (error: Error) => void, planFontFamily?: () => string) => PhysicalViewportRenderer
  readonly registered: (renderer: PhysicalViewportRenderer) => boolean
  readonly orderRenderer: () => void
  readonly removeRenderer: (renderer: PhysicalViewportRenderer) => void
  readonly cameraPose: () => PhysicalCameraPose
  /** Suspend host-specific camera ownership without discarding the user's pose. */
  readonly setActive?: (active: boolean) => void
  /** A visible architectural Plan uses a flat geographic projection. */
  readonly setPlanarInspection?: (active: boolean) => void
  readonly setPose: (patch: Partial<Pick<PhysicalCameraPose, 'pitch' | 'bearing' | 'zoom' | 'center' | 'elevation'>>) => void
  /** Bounds in normalized Mercator world coordinates, including elevation. */
  readonly measureFit?: (bounds: PhysicalSceneBounds, options: PhysicalViewportFitOptions) => number
  readonly fitWorld: (bounds: PhysicalSceneBounds, options: PhysicalViewportFitOptions) => void
  readonly panBy: (x: number, y: number) => void
  readonly setNavigationTool: (tool: 'pan' | 'orbit') => void
  readonly cancelCamera: () => void
  readonly destroy: () => void
}
