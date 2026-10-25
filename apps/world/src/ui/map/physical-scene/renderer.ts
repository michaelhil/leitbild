import type { PhysicalSceneBounds } from '../../../core/packs/scene.ts'
import { createPhysicalBackend, type PhysicalDraw } from './backend.ts'
import { captureSceneGlState, restoreSceneGlState } from './gl-state.ts'
import type { PhysicalLayerEntry } from './layer.ts'
import { localMercatorMatrix, multiply, transform, type Vector3 } from './math.ts'
import { pickPhysicalMesh, type PhysicalPickEntry } from './picking.ts'
import type { PhysicalProjectedPoint, PhysicalSceneFocus, PhysicalSceneHit, PhysicalScenePalette, PhysicalSubjectStyle } from './types.ts'

const styleFor = (entry: PhysicalLayerEntry, subjectIds: ReadonlyArray<string>): PhysicalSubjectStyle | null => {
  if (!entry.view.live || !subjectIds.length) return null
  const styles = subjectIds.map(id => entry.status.get(id)), first = styles[0]
  if (!first || styles.some(style => !style || style.emphasis !== first.emphasis || JSON.stringify(style.color) !== JSON.stringify(first.color))) return null
  return first
}
/** Shared drawing/picking core. Hosts provide an actual GL context, matrix and surface size. */
export const createPhysicalSceneRenderer = (gl: WebGL2RenderingContext, entries: () => ReadonlyArray<PhysicalLayerEntry>, palette: PhysicalScenePalette, size: () => { width: number; height: number }, reportError: (error: Error) => void) => {
  const initial = captureSceneGlState(gl)
  let backend: ReturnType<typeof createPhysicalBackend>
  try { backend = createPhysicalBackend(gl, palette) } finally { restoreSceneGlState(gl, initial) }
  let disposed = false, failed = false, picking: PhysicalPickEntry[] = []
  const pick = (point: { x: number; y: number }): PhysicalSceneHit | null => {
    if (disposed || failed) return null
    const rectangle = size(), hit = pickPhysicalMesh(picking, point, rectangle.width, rectangle.height)
    if (!hit) return null
    const entry = entries().find(candidate => candidate.scene.id === hit.sceneId)
    return entry ? { sceneId: hit.sceneId, targetObjectId: entry.scene.targetObjectId, occurrenceId: hit.mesh.object.id, label: hit.mesh.object.label, subjectIds: hit.mesh.object.subjectIds, screen: point } : null
  }
  const cheapProject = (sceneId: string, occurrenceId: string, levelId?: string): PhysicalProjectedPoint | null => {
    const entry = picking.find(candidate => candidate.sceneId === sceneId)
    if (!entry || disposed || failed) return null
    const rectangle = size()
    const points = entry.meshes.filter(mesh => mesh.object.id === occurrenceId && (levelId === undefined || mesh.levelId === levelId)).map(mesh => {
      const center: Vector3 = [0, 1, 2].map(axis => (mesh.bounds.min[axis]! + mesh.bounds.max[axis]!) / 2 + mesh.offset[axis]!) as unknown as Vector3
      const p = transform(entry.matrix, center)
      return { x: (p[0] + 1) * rectangle.width / 2, y: (1 - p[1]) * rectangle.height / 2, depth: p[2], visible: Math.abs(p[0]) <= 1 && Math.abs(p[1]) <= 1 && Math.abs(p[2]) <= 1 }
    }).sort((a, b) => Number(b.visible) - Number(a.visible) || a.depth - b.depth)
    return points[0] ?? null
  }
  return {
    render(mainMatrix: ArrayLike<number>): void {
      if (disposed || failed) return
      const before = captureSceneGlState(gl)
      try {
        const draws: PhysicalDraw[] = []; picking = []
        for (const entry of entries()) {
          const matrix = multiply(mainMatrix, localMercatorMatrix(entry.scene.anchor, entry.scene.bearing)); picking.push({ sceneId: entry.scene.id, meshes: entry.meshes, matrix })
          const drawMatrix = new Float32Array(matrix)
          for (const mesh of entry.meshes) draws.push({ mesh, matrix: drawMatrix, flat: entry.view.mode === '2d', style: styleFor(entry, mesh.object.subjectIds) })
        }
        backend.draw(draws)
      } catch (error) { failed = true; picking = []; reportError(error instanceof Error ? error : new Error(String(error))) }
      finally { restoreSceneGlState(gl, before) }
    },
    invalidatePicks(): void { picking = [] }, pick, cheapProject,
    visibleAt(sceneId: string, occurrenceId: string, point: { x: number; y: number }): boolean { const hit = pick(point); return hit?.sceneId === sceneId && hit.occurrenceId === occurrenceId },
    project(sceneId: string, occurrenceId: string, levelId?: string): PhysicalProjectedPoint | null { const point = cheapProject(sceneId, occurrenceId, levelId); return point ? { ...point, visible: point.visible && this.visibleAt(sceneId, occurrenceId, point) } : null },
    metrics: () => ({ ...backend.metrics }),
    dispose(): void { if (disposed) return; disposed = true; backend.dispose(); picking = [] },
  }
}

/** Focus uses actual displayed fragment bounds, including level separation offsets. */
export const visiblePhysicalBounds = (entry: PhysicalLayerEntry, target: PhysicalSceneFocus = {}): PhysicalSceneBounds | null => {
  const scopes = new Map((entry.scene.scopes ?? []).map(scope => [scope.id, scope]))
  const inScope = (id: string): boolean => { let current: string | undefined = id; while (current !== undefined) { if (current === target.scopeId) return true; current = scopes.get(current)?.parentId } return false }
  const meshes = entry.meshes.filter(mesh => (target.occurrenceId === undefined || mesh.object.id === target.occurrenceId) && (target.levelId === undefined || mesh.levelId === target.levelId) && (target.scopeId === undefined || mesh.object.scopeIds?.some(inScope)))
  if (!meshes.length) return null
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const mesh of meshes) for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis]!, mesh.bounds.min[axis]! + mesh.offset[axis]!); max[axis] = Math.max(max[axis]!, mesh.bounds.max[axis]! + mesh.offset[axis]!) }
  return { min, max }
}
