import type { CustomLayerInterface, Map as MapLibreMap } from 'maplibre-gl'
import type { PackPhysicalScene } from '../../../core/packs/scene.ts'
import { createPhysicalBackend, type PhysicalDraw } from './backend.ts'
import { captureSceneGlState, restoreSceneGlState } from './gl-state.ts'
import type { PhysicalMesh } from './geometry.ts'
import { localMercatorMatrix, multiply, transform, type Vector3 } from './math.ts'
import { pickPhysicalMesh, type PhysicalPickEntry } from './picking.ts'
import type { PhysicalSceneHit, PhysicalScenePalette, PhysicalSceneView, PhysicalSubjectStyle } from './types.ts'

export interface PhysicalLayerEntry { readonly scene: PackPhysicalScene; readonly meshes: ReadonlyArray<PhysicalMesh>; readonly view: PhysicalSceneView; readonly status: ReadonlyMap<string, PhysicalSubjectStyle> }

const styleFor = (entry: PhysicalLayerEntry, mesh: PhysicalMesh): PhysicalSubjectStyle | null => {
  if (!entry.view.live || !mesh.object.subjectIds.length) return null
  const styles = mesh.object.subjectIds.map(id => entry.status.get(id))
  if (styles.some(style => !style)) return null
  const first = styles[0]!
  // Multiple owner subjects never acquire an invented average or arbitrary first-subject state.
  return styles.every(style => JSON.stringify(style) === JSON.stringify(first)) ? first : null
}

export const createPhysicalSceneLayer = (id: string, entries: () => ReadonlyArray<PhysicalLayerEntry>, palette: PhysicalScenePalette, reportError: (error: Error) => void) => {
  let backend: ReturnType<typeof createPhysicalBackend> | null = null
  let map: MapLibreMap | null = null
  let gl: WebGL2RenderingContext | null = null
  let disposed = false
  let picking: PhysicalPickEntry[] = []
  let failed = false
  let finalMetrics: ReturnType<typeof createPhysicalBackend>['metrics'] | null = null
  const dispose = (): void => { if (disposed) return; disposed = true; backend?.dispose(); finalMetrics = backend ? { ...backend.metrics } : null; backend = null; picking = [] }
  const layer: CustomLayerInterface = {
    id, type: 'custom', renderingMode: '3d',
    onAdd(owningMap, context) {
      map = owningMap; gl = context; disposed = false
      const before = captureSceneGlState(context)
      try { backend = createPhysicalBackend(context, palette) }
      catch (error) { failed = true; reportError(error instanceof Error ? error : new Error(String(error))) }
      finally { restoreSceneGlState(context, before) }
    },
    render(context, input) {
      if (!backend || disposed || failed) return
      const before = captureSceneGlState(context)
      try {
        const draws: PhysicalDraw[] = []
        picking = []
        for (const entry of entries()) {
          const matrix = multiply(input.defaultProjectionData.mainMatrix, localMercatorMatrix(entry.scene.anchor, entry.scene.bearing))
          picking.push({ sceneId: entry.scene.id, meshes: entry.meshes, matrix })
          const drawMatrix = new Float32Array(matrix)
          for (const mesh of entry.meshes) draws.push({ mesh, matrix: drawMatrix, flat: entry.view.mode === '2d', style: styleFor(entry, mesh) })
        }
        backend.draw(draws)
      } catch (error) { failed = true; picking = []; reportError(error instanceof Error ? error : new Error(String(error))) }
      finally { restoreSceneGlState(context, before) }
    },
    onRemove: dispose,
  }
  return {
    layer,
    dispose,
    metrics: () => backend ? { ...backend.metrics } : finalMetrics,
    pick(point: { x: number; y: number }): PhysicalSceneHit | null {
      if (!map || failed || disposed) return null
      const rectangle = map.getCanvas().getBoundingClientRect()
      const hit = pickPhysicalMesh(picking, point, rectangle.width, rectangle.height)
      if (!hit) return null
      const entry = entries().find(candidate => candidate.scene.id === hit.sceneId)
      if (!entry) return null
      return { sceneId: hit.sceneId, targetObjectId: entry.scene.targetObjectId, occurrenceId: hit.mesh.object.id, label: hit.mesh.object.label, subjectIds: hit.mesh.object.subjectIds, screen: point }
    },
    project(sceneId: string, occurrenceId: string): { x: number; y: number; visible: boolean } | null {
      const entry = picking.find(candidate => candidate.sceneId === sceneId)
      const mesh = entry?.meshes.find(candidate => candidate.object.id === occurrenceId)
      if (!entry || !mesh || !map) return null
      const center: Vector3 = [0, 1, 2].map(axis => (mesh.bounds.min[axis]! + mesh.bounds.max[axis]!) / 2 + mesh.offset[axis]!) as unknown as Vector3
      const p = transform(entry.matrix, center), rectangle = map.getCanvas().getBoundingClientRect()
      const screen = { x: (p[0] + 1) * rectangle.width / 2, y: (1 - p[1]) * rectangle.height / 2 }
      const hit = this.pick(screen)
      return { ...screen, visible: Math.abs(p[0]) <= 1 && Math.abs(p[1]) <= 1 && Math.abs(p[2]) <= 1 && hit?.sceneId === sceneId && hit.occurrenceId === occurrenceId }
    },
    context: () => gl,
  }
}
