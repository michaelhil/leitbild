import type { PhysicalSceneBounds } from '../../../core/packs/scene.ts'
import { createPhysicalBackend, type PhysicalDraw } from './backend.ts'
import { createPhysicalRenderPass } from './render-pass.ts'
import { visiblePhysicalSurfaceOwners } from './surface-ownership.ts'
import { projectPhysicalPlan } from './plan-projection.ts'
import { physicalPerspectiveNear } from './depth-projection.ts'
import { visiblePhysicalInspectionBoundaries } from './inspection-cutaway.ts'
import { captureSceneGlState, restoreSceneGlState } from './gl-state.ts'
import type { PhysicalLayerEntry } from './layer.ts'
import { physicalScopeMembers } from './scopes.ts'
import { localMercatorMatrix, multiply, transform, type Vector3 } from './math.ts'
import { derivePhysicalPickAcceleration, pickPhysicalMesh, type PhysicalPickEntry } from './picking.ts'
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
  let renderPass: ReturnType<typeof createPhysicalRenderPass> | null = null
  let depthNear = 0
  let disposed = false, failed = false, picking: PhysicalPickEntry[] = []
  const occurrenceMeshes = new WeakMap<PhysicalPickEntry['meshes'], Map<string, typeof picking[number]['meshes']>>()
  const indexedSelections = new WeakSet<ReadonlyArray<import('./geometry.ts').PhysicalMesh>>()
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
    let roster = occurrenceMeshes.get(entry.meshes)
    if (!roster) { roster = new Map(); for (const mesh of entry.meshes) { const previous = roster.get(mesh.object.id) ?? []; roster.set(mesh.object.id, [...previous, mesh]) }; occurrenceMeshes.set(entry.meshes, roster) }
    const points = (roster.get(occurrenceId) ?? []).filter(mesh => levelId === undefined || mesh.levelId === levelId).map(mesh => {
      const center: Vector3 = [0, 1, 2].map(axis => (mesh.bounds.min[axis]! + mesh.bounds.max[axis]!) / 2 + mesh.offset[axis]!) as unknown as Vector3
      const p = transform(entry.matrix, center)
      return { x: (p[0] + 1) * rectangle.width / 2, y: (1 - p[1]) * rectangle.height / 2, depth: p[2], visible: Math.abs(p[0]) <= 1 && Math.abs(p[1]) <= 1 && Math.abs(p[2]) <= 1 }
    }).sort((a, b) => Number(b.visible) - Number(a.visible) || a.depth - b.depth)
    return points[0] ?? null
  }
  return {
    render(mainMatrix: ArrayLike<number>): void {
      if (disposed || failed) return
      let before: ReturnType<typeof captureSceneGlState> | null = null
      try {
        const draws: PhysicalDraw[] = []; picking = []
        const current = entries().map(entry => {
          const boundary = visiblePhysicalInspectionBoundaries(entry.meshes, multiply(mainMatrix, localMercatorMatrix(entry.scene.anchor, entry.scene.bearing)))
          const meshes = visiblePhysicalSurfaceOwners(boundary, entry.asset?.acceleration)
          if (meshes !== entry.meshes && entry.asset && !indexedSelections.has(meshes)) { derivePhysicalPickAcceleration(meshes, entry.asset.acceleration); indexedSelections.add(meshes) }
          return { ...entry, meshes }
        }), plan = current.length > 0 && current.every(entry => entry.view.mode === '2d')
        const baseProjection = plan ? projectPhysicalPlan(current, mainMatrix) : current.map(entry => ({ entry, matrix: multiply(mainMatrix, localMercatorMatrix(entry.scene.anchor, entry.scene.bearing)), meshes: entry.meshes }))
        depthNear = plan ? 0 : physicalPerspectiveNear(mainMatrix)
        const projected = baseProjection
        for (const { entry, matrix, meshes } of projected) {
          picking.push({ sceneId: entry.scene.id, meshes, matrix })
          // Explicit architectural ink owns Plan colour. Retain the same solid
          // acceleration for operational picking without painting it twice.
          if (entry.view.mode === '2d' && entry.scene.planDrawing?.views.some(view => view.levelId === entry.view.levelId)) continue
          const drawMatrix = new Float32Array(matrix)
          if (!entry.asset) throw new Error('Physical render entry has no prepared GPU asset')
          draws.push({ asset: entry.asset, meshes, matrix: drawMatrix, flat: entry.view.mode === '2d', styles: entry.asset.meshes.map(mesh => styleFor(entry, mesh.object.subjectIds)) })
        }
        // Vector Plan still updates real solid picking above, but owns all
        // visible colour in its native drawing surface. An empty GL pass must
        // neither query shared GL state nor clear/composite a blank target.
        if (!draws.length) return
        before = captureSceneGlState(gl)
        renderPass ??= createPhysicalRenderPass(gl); renderPass.begin(before.viewport[2], before.viewport[3])
        backend.draw(draws, depthNear); renderPass.composite(before.drawFramebuffer, before.readFramebuffer, before.viewport)
      } catch (error) { failed = true; picking = []; reportError(error instanceof Error ? error : new Error(String(error))) }
      finally { if (before) restoreSceneGlState(gl, before) }
    },
    invalidatePicks(): void { picking = [] }, pick, cheapProject,
    visibleAt(sceneId: string, occurrenceId: string, point: { x: number; y: number }): boolean { const hit = pick(point); return hit?.sceneId === sceneId && hit.occurrenceId === occurrenceId },
    project(sceneId: string, occurrenceId: string, levelId?: string): PhysicalProjectedPoint | null { const point = cheapProject(sceneId, occurrenceId, levelId); return point ? { ...point, visible: point.visible && this.visibleAt(sceneId, occurrenceId, point) } : null },
    setPalette: backend.setPalette,
    retainGeometryIdentities(identities: ReadonlySet<string>): void { const before = captureSceneGlState(gl); try { backend.retainGeometryIdentities(identities) } finally { restoreSceneGlState(gl, before) } },
    metrics: () => { const owned = renderPass?.metrics(), base = backend.metrics; return { ...base, programs: base.programs + (owned?.programs ?? 0), textures: base.textures + (owned?.textures ?? 0), textureBytes: base.textureBytes + (owned?.textureBytes ?? 0), renderPass: owned ?? null, depthNear, liveProgramsAfterDisposal: base.liveProgramsAfterDisposal === null ? null : base.liveProgramsAfterDisposal + (owned?.livePrograms ?? 0), liveTexturesAfterDisposal: base.liveTexturesAfterDisposal === null ? null : base.liveTexturesAfterDisposal + (owned?.liveTextures ?? 0) } },
    dispose(): void { if (disposed) return; disposed = true; backend.dispose(); renderPass?.dispose(); picking = [] },
  }
}

/** Focus uses actual displayed fragment bounds, including level separation offsets. */
export const visiblePhysicalBounds = (entry: PhysicalLayerEntry, target: PhysicalSceneFocus = {}): PhysicalSceneBounds | null => {
  const members = target.scopeId === undefined ? null : physicalScopeMembers(entry.scene.scopes ?? [], target.scopeId)
  const meshes = entry.meshes.filter(mesh => (target.occurrenceId === undefined || mesh.object.id === target.occurrenceId) && (target.levelId === undefined || mesh.levelId === target.levelId) && (members === null || mesh.object.scopeIds?.some(id => members.has(id))))
  if (!meshes.length) return null
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const mesh of meshes) for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis]!, mesh.bounds.min[axis]! + mesh.offset[axis]!); max[axis] = Math.max(max[axis]!, mesh.bounds.max[axis]! + mesh.offset[axis]!) }
  return { min, max }
}
