import type { CustomLayerInterface, Map as MapLibreMap } from 'maplibre-gl'
import type { PackPhysicalScene } from '../../../core/packs/scene.ts'
import type { PhysicalMesh } from './geometry.ts'
import { createPhysicalSceneRenderer } from './renderer.ts'
import type { PhysicalProjectedPointVisitor, PhysicalSceneHighlight, PhysicalScenePalette, PhysicalSceneView, PhysicalSubjectStyle } from './types.ts'
import type { Vector3 } from './math.ts'
import type { PhysicalPreparedGeometry } from './preparation.ts'
import type {PhysicalArchitectureBsp} from './architecture-bsp-types.ts'
import type {PhysicalArchitectureBspFrame} from './architecture-cohort.ts'

export interface PhysicalLayerEntry { readonly scene: PackPhysicalScene; readonly meshes: ReadonlyArray<PhysicalMesh>; readonly asset?: PhysicalPreparedGeometry; readonly view: PhysicalSceneView; readonly status: ReadonlyMap<string, PhysicalSubjectStyle>; readonly scopeId?: string }
export const createPhysicalSceneLayer = (id: string, entries: () => ReadonlyArray<PhysicalLayerEntry>, palette: PhysicalScenePalette, reportError: (error: Error) => void, planFontFamily?: () => string) => {
  let renderer: ReturnType<typeof createPhysicalSceneRenderer> | null = null, gl: WebGL2RenderingContext | null = null
  let mapCanvas: HTMLCanvasElement | null = null
  let finalMetrics: ReturnType<ReturnType<typeof createPhysicalSceneRenderer>['metrics']> | null = null
  const dispose = (): void => { mapCanvas = null; if (!renderer) return; renderer.dispose(); finalMetrics = renderer.metrics(); renderer = null }
  const layer: CustomLayerInterface = {
    // The physical model owns depth; MapLibre receives only the colour overlay.
    id, type: 'custom', renderingMode: '2d',
    onAdd(map: MapLibreMap, context) { gl = context; mapCanvas = map.getCanvas(); try { renderer = createPhysicalSceneRenderer(context, entries, palette, () => map.getCanvas().getBoundingClientRect(), reportError, planFontFamily ?? (() => getComputedStyle(map.getCanvas()).fontFamily)) } catch (error) { reportError(error instanceof Error ? error : new Error(String(error))) } },
    prerender(_context, input) { if (mapCanvas) renderer?.prepareFrame(input.defaultProjectionData.mainMatrix, { width: mapCanvas.width, height: mapCanvas.height }) },
    render() { renderer?.compositeFrame() }, onRemove: dispose,
  }
  return { layer, dispose, setPalette: (next: PhysicalScenePalette) => renderer?.setPalette(next), setHighlight: (target: PhysicalSceneHighlight | null) => renderer?.setHighlight(target), setArchitectureBsp:(asset:PhysicalArchitectureBsp|null,frame:PhysicalArchitectureBspFrame|null)=>renderer?.setArchitectureBsp(asset,frame), retainGeometryIdentities: (identities: ReadonlySet<string>) => renderer?.retainGeometryIdentities(identities), invalidatePicks: () => renderer?.invalidatePicks(), metrics: () => renderer?.metrics() ?? finalMetrics, pick: (point: { x: number; y: number }) => renderer?.pick(point) ?? null,
    cheapProject: (sceneId: string, occurrenceId: string, levelId?: string) => renderer?.cheapProject(sceneId, occurrenceId, levelId) ?? null,
    visibleAt: (sceneId: string, occurrenceId: string, point: { x: number; y: number }) => renderer?.visibleAt(sceneId, occurrenceId, point) ?? false,
    project: (sceneId: string, occurrenceId: string, levelId?: string) => renderer?.project(sceneId, occurrenceId, levelId) ?? null,
    visitOccurrencePoints: (sceneId: string, occurrenceId: string, points: ReadonlyArray<Vector3>, visit: PhysicalProjectedPointVisitor, levelId?: string) => renderer?.visitOccurrencePoints(sceneId, occurrenceId, points, visit, levelId), context: () => gl }
}
