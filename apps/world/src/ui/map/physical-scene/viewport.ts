import type { PhysicalSceneBounds } from '../../../core/packs/scene.ts'
import type { PhysicalLayerEntry } from './layer.ts'
import type { PhysicalCameraPose, PhysicalProjectedPoint, PhysicalSceneHit, PhysicalScenePalette, PhysicalSceneSurface } from './types.ts'
import type { PhysicalBackendMetrics } from './backend.ts'
export type PhysicalViewportEvent = 'change' | 'resize' | 'render' | 'movestart' | 'style' | 'idle' | 'contextlost' | 'contextrestored'
export interface PhysicalViewportRenderer {
  readonly setPalette: (palette: PhysicalScenePalette) => void
  readonly retainGeometryIdentities: (identities: ReadonlySet<string>) => void
  readonly dispose: () => void
  readonly invalidatePicks: () => void
  readonly metrics: () => PhysicalBackendMetrics | null
  readonly pick: (point: { x: number; y: number }) => PhysicalSceneHit | null
  readonly cheapProject: (sceneId: string, occurrenceId: string, levelId?: string) => PhysicalProjectedPoint | null
  readonly visibleAt: (sceneId: string, occurrenceId: string, point: { x: number; y: number }) => boolean
  readonly project: (sceneId: string, occurrenceId: string, levelId?: string) => PhysicalProjectedPoint | null
}
export interface PhysicalViewport {
  readonly surface: PhysicalSceneSurface
  readonly ready: () => boolean
  readonly on: (event: PhysicalViewportEvent, listener: () => void) => () => void
  /** Conservative visibility includes camera-inside, height and horizon cases. */
  readonly intersectsBounds: (bounds: PhysicalSceneBounds, mode: '2d' | '3d') => boolean
  readonly projectGeographic: (point: { lng: number; lat: number }) => { x: number; y: number }
  readonly requestRender: () => void
  readonly installRenderer: (entries: () => ReadonlyArray<PhysicalLayerEntry>, palette: PhysicalScenePalette, reportError: (error: Error) => void) => PhysicalViewportRenderer
  readonly registered: (renderer: PhysicalViewportRenderer) => boolean
  readonly orderRenderer: () => void
  readonly removeRenderer: (renderer: PhysicalViewportRenderer) => void
  readonly cameraPose: () => PhysicalCameraPose
  readonly setPose: (patch: Partial<Pick<PhysicalCameraPose, 'pitch' | 'bearing' | 'zoom' | 'center' | 'elevation'>>) => void
  /** Bounds in normalized Mercator world coordinates, including elevation. */
  readonly fitWorld: (bounds: PhysicalSceneBounds, options: { padding: { top: number; right: number; bottom: number; left: number }; preservePose: boolean; mode: '2d' | '3d'; bearing: number }) => void
  readonly panBy: (x: number, y: number) => void
  readonly setNavigationTool: (tool: 'pan' | 'orbit') => void
  readonly cancelCamera: () => void
  readonly destroy: () => void
}
