import type { PhysicalSceneBounds } from '../../../core/packs/scene.ts'
import {createPhysicalSceneStyleCache} from './subject-styles.ts'
import { createPhysicalBackend, type PhysicalDraw } from './backend.ts'
import { createPhysicalPreparedResidency } from './prepared-residency.ts'
import { createPhysicalRenderPass } from './render-pass.ts'
import { visiblePhysicalSurfaceOwners } from './surface-ownership.ts'
import { projectPhysicalPlan } from './plan-projection.ts'
import { physicalPerspectiveNear } from './depth-projection.ts'
import { visiblePhysicalInspectionBoundaries } from './inspection-cutaway.ts'
import { captureSceneGlState, restoreSceneGlState } from './gl-state.ts'
import type { PhysicalLayerEntry } from './layer.ts'
import { physicalScopeMembers } from './scopes.ts'
import { localMercatorMatrix, multiply, transform, type Vector3 } from './math.ts'
import { pickPhysicalMesh, type PhysicalPickEntry } from './picking.ts'
import { physicalArchitectureOpacity } from './architecture-opacity.ts'
import { createPhysicalArchitectureBackend } from './architecture-backend.ts'
import type { PhysicalArchitectureBsp } from './architecture-bsp-types.ts'
import type { PhysicalArchitectureBspFrame } from './architecture-cohort.ts'
import { pickPhysicalPlan, physicalPlanOccurrenceBounds, type PhysicalPlanPickInput } from './plan-picking.ts'
import {createPhysicalOccurrenceMeshIndex,visitPhysicalSpatialPoints} from './occurrence-projection.ts'
import { physicalPlanFrame } from '../../physical-layout/plan-drawing.ts'
import type { PhysicalProjectedPoint, PhysicalProjectedPointVisitor, PhysicalSceneFocus, PhysicalSceneHit, PhysicalSceneHighlight, PhysicalScenePalette, PhysicalSubjectStyle } from './types.ts'

/** Shared drawing/picking core. Hosts provide an actual GL context, matrix and surface size. */
export const createPhysicalSceneRenderer = (gl: WebGL2RenderingContext, entries: () => ReadonlyArray<PhysicalLayerEntry>, palette: PhysicalScenePalette, size: () => { width: number; height: number }, reportError: (error: Error) => void, planFontFamily: () => string = () => 'sans-serif') => {
  const initial = captureSceneGlState(gl)
  let backend: ReturnType<typeof createPhysicalBackend>
  try { backend = createPhysicalBackend(gl, palette) } finally { restoreSceneGlState(gl, initial) }
  const architectureBackend = createPhysicalArchitectureBackend(gl, palette)
  const cpu = createPhysicalPreparedResidency()
  const stylesFor=createPhysicalSceneStyleCache()
  let renderPass: ReturnType<typeof createPhysicalRenderPass> | null = null
  let depthNear = 0
  let highlight: PhysicalSceneHighlight | null = null
  let architectureFrame: PhysicalArchitectureBspFrame | null = null
  let disposed = false, failed = false, picking: PhysicalPickEntry[] = []
  let planPicking: ReadonlyArray<{ readonly entry: PhysicalLayerEntry; readonly input: PhysicalPlanPickInput }> = []
  const occurrenceMeshes=createPhysicalOccurrenceMeshIndex()
  let renderedRectangle={width:0,height:0}
  const architecturePicks = new WeakMap<PhysicalPickEntry['meshes'], Map<string, PhysicalPickEntry['meshes']>>()
  const architectureVisibility = new WeakMap<PhysicalPickEntry['meshes'], Map<string, PhysicalPickEntry['meshes']>>()
  const pick = (point: { x: number; y: number }): PhysicalSceneHit | null => {
    if (disposed || failed) return null
    for (let index = planPicking.length - 1; index >= 0; index--) {
      const plan = planPicking[index]!, hit = pickPhysicalPlan(plan.input, point)
      if (!hit) continue
      const object = hit.ownerOccurrenceId ? plan.entry.scene.objects.find(object => object.id === hit.ownerOccurrenceId) : undefined
      // Non-owned drafting ink can block an item below without inventing a
      // physical object. The ordinary scene footprint retains owner overview.
      if (!object) return null
      return { sceneId: plan.entry.scene.id, targetObjectId: plan.entry.scene.targetObjectId, occurrenceId: object.id, label: object.label, subjectIds: object.subjectIds, screen: point }
    }
    const rectangle=renderedRectangle,hit=pickPhysicalMesh(picking,point,rectangle.width,rectangle.height)
    if (!hit) return null
    const entry = entries().find(candidate => candidate.scene.id === hit.sceneId)
    return entry ? { sceneId: hit.sceneId, targetObjectId: entry.scene.targetObjectId, occurrenceId: hit.mesh.object.id, label: hit.mesh.object.label, subjectIds: hit.mesh.object.subjectIds, screen: point } : null
  }
  const cheapProject = (sceneId: string, occurrenceId: string, levelId?: string): PhysicalProjectedPoint | null => {
    const plan = planPicking.find(candidate => candidate.entry.scene.id === sceneId)
    if (plan) {
      if (levelId !== undefined && levelId !== plan.entry.view.levelId) return null
      const bounds = physicalPlanOccurrenceBounds(plan.input, occurrenceId)
      if (!bounds) return null
      const x = (bounds.min[0] + bounds.max[0]) / 2, y = (bounds.min[1] + bounds.max[1]) / 2, f = plan.input.frame
      const point = { x: f.a * x + f.c * y + f.e, y: f.b * x + f.d * y + f.f, depth: 0 }
      return { ...point, visible: point.x >= 0 && point.y >= 0 && point.x <= plan.input.width && point.y <= plan.input.height }
    }
    const entry = picking.find(candidate => candidate.sceneId === sceneId)
    if (!entry || disposed || failed) return null
    const rectangle=renderedRectangle
    const points = occurrenceMeshes.group(entry.meshes,occurrenceId).filter(mesh => levelId === undefined || mesh.levelId === levelId).map(mesh => {
      const center: Vector3 = [0, 1, 2].map(axis => (mesh.bounds.min[axis]! + mesh.bounds.max[axis]!) / 2 + mesh.offset[axis]!) as unknown as Vector3
      const p = transform(entry.matrix, center)
      return { x: (p[0] + 1) * rectangle.width / 2, y: (1 - p[1]) * rectangle.height / 2, depth: p[2], visible: Math.abs(p[0]) <= 1 && Math.abs(p[1]) <= 1 && Math.abs(p[2]) <= 1 }
    }).sort((a, b) => Number(b.visible) - Number(a.visible) || a.depth - b.depth)
    return points[0] ?? null
  }
  type FrameTarget = { readonly kind: 'borrowed' } | { readonly kind: 'offscreen'; readonly width: number; readonly height: number }
  let preparedColor = false
  const drawFrame = (mainMatrix: ArrayLike<number>, target: FrameTarget): boolean => {
    if (disposed || failed) return false
    let before: ReturnType<typeof captureSceneGlState> | null = null, offscreenTouched = false
    try {
      const draws: PhysicalDraw[] = []; picking = []; planPicking = []; const presented = entries(); cpu.update(presented.flatMap(entry => entry.asset ? [entry.asset] : []))
      const rectangle = size(); renderedRectangle={width:rectangle.width,height:rectangle.height}; const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
      const ink = presented.filter(entry => entry.view.mode === '2d' && entry.scene.planDrawing?.views.some(view => view.levelId === entry.view.levelId))
      planPicking = ink.flatMap(entry => {
        const matrix = multiply(mainMatrix, localMercatorMatrix(entry.scene.anchor, entry.scene.bearing))
        const points = [[0, 0, 0], [1, 0, 0], [0, 1, 0]].map(point => { const p = transform(matrix, point as unknown as Vector3); return { x: (p[0] + 1) * rectangle.width / 2, y: (1 - p[1]) * rectangle.height / 2 } })
        const frame = physicalPlanFrame(points)
        return frame ? [{ entry, input: { scene: entry.scene, view: entry.view, scopeId: entry.scopeId ?? null, frame, width: rectangle.width, height: rectangle.height, ratio, fontFamily: planFontFamily() } }] : []
      })
      const rosters = new Map<PhysicalLayerEntry, PhysicalLayerEntry['meshes']>()
      const current = presented.filter(entry => !ink.includes(entry)).map(entry => {
        const boundary = visiblePhysicalInspectionBoundaries(entry.meshes, multiply(mainMatrix, localMercatorMatrix(entry.scene.anchor, entry.scene.bearing)))
        // Invisible architecture is no longer a surface owner. Select its
        // retained alternatives before using the SAME set for colour/picks.
        let visible = boundary
        if (entry.view.wallOpacity === 0 || entry.view.floorOpacity === 0) {
          let selections = architectureVisibility.get(boundary)
          if (!selections) { selections = new Map(); architectureVisibility.set(boundary, selections) }
          const key = JSON.stringify([entry.view.wallOpacity === 0, entry.view.floorOpacity === 0])
          const cached = selections.get(key)
          if (cached) visible = cached
          else { visible = boundary.filter(mesh => physicalArchitectureOpacity(mesh.object, entry.view) > 0); selections.set(key, visible) }
        }
        const selected = { ...entry, meshes: visiblePhysicalSurfaceOwners(visible) }
        rosters.set(selected, entry.meshes)
        return selected
      }), plan = current.length > 0 && current.every(entry => entry.view.mode === '2d')
      const baseProjection = plan ? projectPhysicalPlan(current, mainMatrix, architectureFrame?.planDepth) : current.map(entry => ({ entry, matrix: multiply(mainMatrix, localMercatorMatrix(entry.scene.anchor, entry.scene.bearing)), meshes: entry.meshes }))
      depthNear = plan ? 0 : physicalPerspectiveNear(mainMatrix)
      const projected = baseProjection
      for (const { entry, matrix, meshes } of projected) {
        let pickable = meshes
        if ((entry.view.wallOpacity ?? 1) < 1 || (entry.view.floorOpacity ?? 1) < 1) {
          const key = JSON.stringify([(entry.view.wallOpacity ?? 1) === 1, (entry.view.floorOpacity ?? 1) === 1])
          let selections = architecturePicks.get(meshes)
          if (!selections) { selections = new Map(); architecturePicks.set(meshes, selections) }
          const cached = selections.get(key)
          if (cached) pickable = cached
          else { pickable = meshes.filter(mesh => mesh.object.subjectIds.length > 0 || physicalArchitectureOpacity(mesh.object, entry.view) === 1); selections.set(key, pickable) }
        }
        // Solid Plan has its own semantic-band offsets. 3D retains the exact
        // pre-camera roster's hierarchy and filters active leaves at pick time.
        const roster = plan ? meshes : rosters.get(entry)
        if (!roster) throw Error('Physical picking lost its displayed spatial roster')
        picking.push({ sceneId: entry.scene.id, meshes: pickable, roster, matrix })
        const drawMatrix = new Float32Array(matrix)
        if (!entry.asset) throw new Error('Physical render entry has no prepared GPU asset')
        draws.push({ sceneId: entry.scene.id, asset: entry.asset, meshes, matrix: drawMatrix, flat: entry.view.mode === '2d', architecture: entry.view, styles:stylesFor(entry.asset,entry.status,entry.view.live), ...(highlight?.sceneId === entry.scene.id ? { highlight } : {}) })
      }
      // Native vector Plan draws and picks its own ink. An empty GL pass
      // must neither query shared state nor composite a blank target.
      if (!draws.length) return false
      if (target.kind === 'borrowed') before = captureSceneGlState(gl)
      else if (target.width <= 0 || target.height <= 0) return false
      const pixels = target.kind === 'offscreen' ? target : { width: before!.viewport[2], height: before!.viewport[3] }
      offscreenTouched = target.kind === 'offscreen'
      renderPass ??= createPhysicalRenderPass(gl); renderPass.begin(pixels.width, pixels.height)
      let architectureMatrix: Float32Array | undefined
      if (architectureFrame) {
        const common = multiply(mainMatrix, architectureFrame.matrix)
        if (plan && projected.length) {
          common[8] = common[9] = common[11] = common[2] = common[6] = 0
          common[10] = projected[0]!.matrix[10]!; common[14] = projected[0]!.matrix[14]!
        }
        architectureMatrix = new Float32Array(common)
      }
      backend.draw(architectureBackend.opaqueDraws(draws), depthNear); architectureBackend.draw(draws, depthNear, architectureMatrix)
      if (before) renderPass.composite(before.drawFramebuffer, before.readFramebuffer, before.viewport)
      else renderPass.resolve()
      return true
    } catch (error) { failed = true; picking = []; planPicking = []; reportError(error instanceof Error ? error : new Error(String(error))); return false }
    finally { if (before) restoreSceneGlState(gl, before); else if (offscreenTouched) gl.bindFramebuffer(gl.FRAMEBUFFER, null) }
  }
  return {
    /** A borrowed host retains a complete state transaction. */
    render(mainMatrix: ArrayLike<number>): void { preparedColor = false; drawFrame(mainMatrix, { kind: 'borrowed' }) },
    /** MapLibre owns state reset around its public offscreen callback. */
    prepareFrame(mainMatrix: ArrayLike<number>, pixels: { readonly width: number; readonly height: number }): void {
      preparedColor = false
      preparedColor = drawFrame(mainMatrix, { kind: 'offscreen', ...pixels })
    },
    compositeFrame(): void {
      if (!preparedColor || disposed || failed) return
      try { renderPass!.compositeCurrent() }
      catch (error) { preparedColor = false; failed = true; picking = []; planPicking = []; reportError(error instanceof Error ? error : new Error(String(error))) }
    },
    invalidatePicks(): void { preparedColor = false; picking = []; planPicking = [] }, pick, cheapProject,
    setHighlight(value: PhysicalSceneHighlight | null): void { preparedColor = false; highlight = value },
    setArchitectureBsp(value: PhysicalArchitectureBsp | null, frame: PhysicalArchitectureBspFrame | null): void {
      preparedColor = false
      if (value && (!frame || frame.matrix.length !== 16 || !frame.matrix.every(Number.isFinite))) throw Error('Architecture cohort requires its actual common-basis placement')
      if (frame?.planDepth && (!Object.values(frame.planDepth).every(Number.isFinite) || frame.planDepth.span <= 0 || frame.planDepth.domain <= 0)) throw Error('Architecture cohort has an invalid Plan depth domain')
      architectureFrame = value ? { matrix: frame!.matrix.slice(), ...(frame!.planDepth ? { planDepth: { ...frame!.planDepth } } : {}) } : null
      architectureBackend.setAsset(value)
    },
    visitOccurrencePoints(sceneId: string, occurrenceId: string, points: ReadonlyArray<Vector3>, visit: PhysicalProjectedPointVisitor, levelId?: string): void {
      if (disposed || failed) return
      const plan = planPicking.find(candidate => candidate.entry.scene.id === sceneId)
      if (plan) {
        if (levelId !== undefined && levelId !== plan.entry.view.levelId || !physicalPlanOccurrenceBounds(plan.input, occurrenceId)) return
        const f = plan.input.frame
        for (const point of points) { const x = f.a * point[0] + f.c * point[1] + f.e, y = f.b * point[0] + f.d * point[1] + f.f; visit(x, y, 0, x >= 0 && y >= 0 && x <= plan.input.width && y <= plan.input.height) }
        return
      }
      const entry = picking.find(candidate => candidate.sceneId === sceneId)
      const mesh=entry?occurrenceMeshes.first(entry.meshes,occurrenceId,levelId):undefined
      if (!entry || !mesh) return
      visitPhysicalSpatialPoints(entry.matrix,mesh.offset,renderedRectangle,points,visit)
    },
    visibleAt(sceneId: string, occurrenceId: string, point: { x: number; y: number }): boolean { const hit = pick(point); return hit?.sceneId === sceneId && hit.occurrenceId === occurrenceId },
    project(sceneId: string, occurrenceId: string, levelId?: string): PhysicalProjectedPoint | null { const point = cheapProject(sceneId, occurrenceId, levelId); return point ? { ...point, visible: point.visible && this.visibleAt(sceneId, occurrenceId, point) } : null },
    setPalette(value: PhysicalScenePalette): void { preparedColor = false; backend.setPalette(value); architectureBackend.setPalette(value) },
    retainGeometryIdentities(identities: ReadonlySet<string>): void { preparedColor = false; cpu.retainIdentities(identities); const before = captureSceneGlState(gl); try { backend.retainGeometryIdentities(identities) } finally { restoreSceneGlState(gl, before) } },
    metrics: () => {
      const owned = renderPass?.metrics(), base = backend.metrics, architecture = architectureBackend.metrics()
      return { ...base, architecture, cpuResidency: cpu.metrics(), renderPass: owned ?? null, depthNear,
        geometryUploads: base.geometryUploads + architecture.geometryUploads, geometryBytes: base.geometryBytes + architecture.geometryBytes + architecture.orderBytes,
        instanceBytes: base.instanceBytes + architecture.instanceBytes, instanceUploads: base.instanceUploads + architecture.instanceUploads,
        statusUploads: base.statusUploads + architecture.statusUploads, paletteUploads: base.paletteUploads + architecture.paletteUploads, draws: base.draws + architecture.draws,
        residentCpuBytes: cpu.metrics().residentBytes + base.residentCpuBytes + architecture.residentCpuBytes, buffers: base.buffers + architecture.buffers,
        programs: base.programs + architecture.programs + (owned?.programs ?? 0), textures: base.textures + architecture.textures + (owned?.textures ?? 0), textureBytes: base.textureBytes + architecture.textureBytes + (owned?.textureBytes ?? 0),
        liveBuffersAfterDisposal: base.liveBuffersAfterDisposal === null ? null : base.liveBuffersAfterDisposal + (architecture.liveBuffersAfterDisposal ?? 0),
        liveProgramsAfterDisposal: base.liveProgramsAfterDisposal === null ? null : base.liveProgramsAfterDisposal + (architecture.liveProgramsAfterDisposal ?? 0) + (owned?.livePrograms ?? 0),
        liveTexturesAfterDisposal: base.liveTexturesAfterDisposal === null ? null : base.liveTexturesAfterDisposal + (architecture.liveTexturesAfterDisposal ?? 0) + (owned?.liveTextures ?? 0) }
    },
    dispose(): void { if (disposed) return; preparedColor = false; disposed = true; backend.dispose(); architectureBackend.dispose(); renderPass?.dispose(); cpu.clear(); picking = []; planPicking = [] },
  }
}

/** Focus uses actual displayed fragment bounds, including level separation offsets. */
export const visiblePhysicalBounds = (entry: PhysicalLayerEntry, target: PhysicalSceneFocus = {}): PhysicalSceneBounds | null => {
  const members = target.scopeId === undefined ? null : physicalScopeMembers(entry.scene.scopes ?? [], target.scopeId)
  const meshes = entry.meshes.filter(mesh => (target.occurrenceId === undefined || mesh.object.id === target.occurrenceId) && (target.levelId === undefined || mesh.levelId === target.levelId) && (members === null || mesh.inspectionScopeId === target.scopeId || (mesh.annotation?.scopeIds ?? mesh.object.scopeIds)?.some(id => members.has(id))))
  if (!meshes.length) return null
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const mesh of meshes) for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis]!, mesh.bounds.min[axis]! + mesh.offset[axis]!); max[axis] = Math.max(max[axis]!, mesh.bounds.max[axis]! + mesh.offset[axis]!) }
  return { min, max }
}
