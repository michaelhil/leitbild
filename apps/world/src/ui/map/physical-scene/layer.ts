import type { CustomLayerInterface, Map as MapLibreMap } from 'maplibre-gl'
import type { PackPhysicalScene } from '../../../core/packs/scene.ts'
import type { PhysicalMesh } from './geometry.ts'
import { createPhysicalSceneRenderer } from './renderer.ts'
import type { PhysicalScenePalette, PhysicalSceneView, PhysicalSubjectStyle } from './types.ts'
import type { PhysicalPreparedGeometry } from './preparation.ts'

export interface PhysicalLayerEntry { readonly scene: PackPhysicalScene; readonly meshes: ReadonlyArray<PhysicalMesh>; readonly asset?: PhysicalPreparedGeometry; readonly view: PhysicalSceneView; readonly status: ReadonlyMap<string, PhysicalSubjectStyle> }
export const createPhysicalSceneLayer = (id: string, entries: () => ReadonlyArray<PhysicalLayerEntry>, palette: PhysicalScenePalette, reportError: (error: Error) => void) => {
  let renderer: ReturnType<typeof createPhysicalSceneRenderer> | null = null, gl: WebGL2RenderingContext | null = null
  let finalMetrics: ReturnType<ReturnType<typeof createPhysicalSceneRenderer>['metrics']> | null = null
  const dispose = (): void => { if (!renderer) return; renderer.dispose(); finalMetrics = renderer.metrics(); renderer = null }
  const layer: CustomLayerInterface = {
    id, type: 'custom', renderingMode: '3d',
    onAdd(map: MapLibreMap, context) { gl = context; try { renderer = createPhysicalSceneRenderer(context, entries, palette, () => map.getCanvas().getBoundingClientRect(), reportError) } catch (error) { reportError(error instanceof Error ? error : new Error(String(error))) } },
    render(_context, input) { renderer?.render(input.defaultProjectionData.mainMatrix) }, onRemove: dispose,
  }
  return { layer, dispose, setPalette: (next: PhysicalScenePalette) => renderer?.setPalette(next), retainGeometryIdentities: (identities: ReadonlySet<string>) => renderer?.retainGeometryIdentities(identities), invalidatePicks: () => renderer?.invalidatePicks(), metrics: () => renderer?.metrics() ?? finalMetrics, pick: (point: { x: number; y: number }) => renderer?.pick(point) ?? null,
    cheapProject: (sceneId: string, occurrenceId: string, levelId?: string) => renderer?.cheapProject(sceneId, occurrenceId, levelId) ?? null,
    visibleAt: (sceneId: string, occurrenceId: string, point: { x: number; y: number }) => renderer?.visibleAt(sceneId, occurrenceId, point) ?? false,
    project: (sceneId: string, occurrenceId: string, levelId?: string) => renderer?.project(sceneId, occurrenceId, levelId) ?? null, context: () => gl }
}
