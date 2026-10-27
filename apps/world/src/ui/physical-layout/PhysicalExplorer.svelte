<script lang="ts">
  import { tick, untrack } from 'svelte'
  import { embeddedViewFragment, embeddedViewPath, type EmbeddedViewListing } from '@leitbild/contracts'
  import type { Map as MapLibreMap } from 'maplibre-gl'
  import type { OperationalObject, SimulationRunId } from '../../core/model/index.ts'
  import { objectIdSchema } from '../../core/model/index.ts'
  import type { PackPhysicalScene } from '../../core/packs/scene.ts'
  import type { PackObjectPresentation } from '../../core/packs/protocol.ts'
  import { createPhysicalSceneController, type PhysicalSceneController } from '../map/physical-scene/controller.ts'
  import { createPhysicalAnnotationScheduler } from './annotation-scheduler.ts'
  import { createPhysicalAnnotationSceneKey } from './annotation-scene.ts'
  import { explorerGroupKey, explorerLayoutKey, explorerScopeChoices, levelForPhysicalFocus, levelForScopeFocus, physicalOccurrenceInScope, physicalOccurrenceOnLevel, type ExplorerScopeChoice } from './explorer-model.ts'
  import { physicalCollectionFloorGroups, physicalCollectionFloorChanges, physicalCollectionMixedSettings, physicalPlanLevelAfterModeChange } from './collection-floors.ts'
  import { physicalCollectionLayerChoices, physicalCollectionLayerChanges } from './collection-layers.ts'
  import { physicalExplorerFitPadding, type ExplorerViewportPadding } from './explorer-viewport.ts'
  import { physicalExplorerKeyboardRoute, physicalExplorerNeedsLive } from './explorer-interaction.ts'
  import { createPhysicalSceneOverview } from '../map/physical-scene/overview.ts'
  import type { PhysicalSceneHit, PhysicalScenePresentation, PhysicalSceneView, PhysicalScenePalette, PhysicalSceneFitRequest } from '../map/physical-scene/types.ts'
  import { physicalSceneLayerAnchorId } from '../map/physical-scene/order.ts'
  import { activeWorkspaceId } from '../workspace-context.ts'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import { createEmbeddedFrameHost } from '../process-display/embedded-frame-host.ts'
  import Controls from './Controls.svelte'
  import CameraControls from './CameraControls.svelte'
  import { createLayoutLiveSession, layoutLiveFrozen, layoutLiveRoutes, type LayoutLiveSnapshot } from './client.ts'
  import { layoutInspectionEnvelope, layoutInspectionHostRoom, layoutInspectionMessageSchema, layoutInspectionSampleMessage, layoutInspectionSpaceMessage, type LayoutInspectionState } from './inspection.ts'
  import { physicalSubjectStatus, physicalSubjectStyle, physicalLayoutStatusSummary } from './status.ts'
  import { priorityRank } from '../../features/displays/alerts/rows.ts'
  import { sparseLayoutBadges } from './badges.ts'
  import { physicalLayoutPalette } from './palette.ts'
  import { drawPhysicalPlanAnnotations, visiblePhysicalPlanAnnotations } from './plan-annotations.ts'
  import { drawPhysicalPlanDrawing, visiblePhysicalPlanDrawing } from './plan-drawing.ts'
  import { retryablePhysicalLayouts } from './retry.ts'
  import { physicalLayerPreparationText } from './layer-preparation.ts'
  import { requestedPhysicalLayoutView, physicalOpacityPreparationText } from './view-intent.ts'
  import { createPhysicalHoverIntent } from './hover-intent.ts'
  import { resolvePhysicalSubjectOperation, type PhysicalSubjectOperation } from './operation.ts'
  import { physicalOperationContext, physicalOperationBadgeWord } from './operation-presentation.ts'
  import { physicalRouteInspectionPaths, createPhysicalRouteScreenMarks } from './route-marks.ts'
  import { physicalScopeRegions } from '../map/physical-scene/scope-regions.ts'
  import { drawPhysicalFlowMark, type PhysicalFlowGlyph } from '../displays/physical-flow-marks.ts'
  import { physicalLayoutSources, type PhysicalLayoutBinding, type PhysicalLayoutMapInteraction } from './sources.ts'
  let { suspendPickingForNavigation, controlsOpen = $bindable(false), map, active = true, objects, bindings, hiddenCategoryIds, presentationFor, runId, perspectiveEpoch, suspended, theme, clearTop = 0, reservedPadding = { top: 0, right: 0, bottom: 0, left: 0 }, onDetailedOwners = () => {}, onoverview, onopen, onerror, onconnect = () => {} }: {
    suspendPickingForNavigation?: (() => (() => void)) | undefined
    controlsOpen?: boolean
    map: MapLibreMap
    active?: boolean
    objects: ReadonlyArray<OperationalObject>
    bindings: ReadonlyArray<PhysicalLayoutBinding>
    hiddenCategoryIds: ReadonlyArray<string>
    presentationFor: (object: OperationalObject) => PackObjectPresentation
    runId: SimulationRunId
    perspectiveEpoch: number
    suspended: boolean
    theme: 'light' | 'dark'
    clearTop?: number
    /** Actual host UI covers, independent of the camera's current composition. */
    reservedPadding?: ExplorerViewportPadding
    onDetailedOwners?: (ids: ReadonlyArray<string>) => void
    onoverview: (object: OperationalObject) => void
    onopen: (listing: EmbeddedViewListing) => void
    onerror: (message: string) => void
    onconnect?: (interaction: PhysicalLayoutMapInteraction | null) => void
  } = $props()

  let scenes = $state.raw<ReadonlyArray<PhysicalScenePresentation>>([])
  const annotationKey = createPhysicalAnnotationSceneKey()
  const annotationSceneKey = $derived(annotationKey(scenes))
  // Snapshot only when actual draw/pick geometry changes, not pending UI intent.
  const annotationScenes = $derived.by(() => { void annotationSceneKey; return untrack(() => scenes) })
  let focusedId = $state<string | null>(null)
  let focusedScopeId = $state<string | null>(null)
  let focusedGroupId = $state<string | null>(null)
  let collectionInspection = $state(false)
  let navigation = $state<'pan' | 'orbit'>('pan')
  let draftingCanvas = $state<HTMLCanvasElement | null>(null)
  let draftingColors = $state.raw<{ line: string; allowance: string; access: string } | null>(null)
  let draftingPalette = $state.raw<PhysicalScenePalette | null>(null)
  let controls = $state<{ dismiss: () => boolean } | null>(null)
  let cameraControls = $state<{ dismiss: () => boolean } | null>(null)
  let cameraElement = $state<HTMLElement | null>(null)
  let overlayElement = $state<HTMLElement | null>(null)
  let controller = $state.raw<PhysicalSceneController | null>(null)
  let viewportFailure = $state<string | null>(null)
  let componentsOpen = $state(false)
  let componentScope = $state<{ readonly sceneId: string; readonly label: string; readonly subjectIds: ReadonlyArray<string> } | null>(null)
  let filter = $state('')
  let hover = $state<PhysicalSceneHit | null>(null)
  let hoverLabelElement = $state<HTMLElement | null>(null)
  let hoverLabelSize = $state.raw({ width: 0, height: 0 })
  let hoverDismissTimer: ReturnType<typeof setTimeout> | null = null
  const retainHover = (): void => { if (hoverDismissTimer !== null) clearTimeout(hoverDismissTimer); hoverDismissTimer = null }
  const dismissHoverSoon = (): void => { retainHover(); hoverIntent.clear(); hoverDismissTimer = setTimeout(() => { hoverDismissTimer = null; hover = null }, 200) }
  let inspected = $state<{ readonly sceneId: string; readonly occurrenceId: string | null; readonly elementId: string; readonly label: string; readonly channel: string } | null>(null)
  let inspectionReady = $state(false)
  let inspectionFrame = $state<HTMLIFrameElement | null>(null)
  let inspectionHeight = $state<number | null>(null)
  let toolsElement = $state<HTMLElement | null>(null)
  let toolsBox = $state<{ readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null>(null)
  let cameraBox = $state<{ readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null>(null)
  let focusLocations = $state<{ readonly sceneId: string; readonly subjectId: string; readonly label: string; readonly occurrenceIds: ReadonlyArray<string> } | null>(null)
  let floorChoice = $state<{ readonly sceneId: string; readonly occurrenceId: string; readonly label: string; readonly levelIds: ReadonlyArray<string> } | null>(null)
  let scopeFloorChoice = $state<{ readonly key: string; readonly sceneId: string; readonly label: string; readonly levelIds: ReadonlyArray<string> } | null>(null)
  let pendingFocus = $state<{ readonly sceneId: string; readonly subjectId: string; readonly label: string } | null>(null)
  let pendingCameraFocus = $state<{ readonly sceneId: string; readonly occurrenceId: string; readonly levelId: string; readonly mode: PhysicalSceneView['mode'] } | null>(null)
  const rememberedPlanFloor = new Map<string, string>()
  let snapshots = $state.raw<ReadonlyMap<string, LayoutLiveSnapshot>>(new Map())
  let wallNow = $state(Date.now())
  let documentVisible = $state(!document.hidden)
  let screenRevision = $state(0)
  let cameraReadout = $state({ pitch: 0, bearing: 0 })
  let size = $state({ width: 0, height: 0 })
  let badgeMeasure = $state.raw<CanvasRenderingContext2D | null>(null)
  const sessions = new Map<string, { readonly key: string; readonly session: ReturnType<typeof createLayoutLiveSession> }>()
  type Reading = NonNullable<LayoutLiveSnapshot['latest']>
  const statusCache = new WeakMap<Reading, Map<boolean, ReadonlyMap<string, ReturnType<typeof physicalSubjectStatus>>>>()
  const operationCache = new WeakMap<Reading, Map<boolean, ReadonlyMap<string, PhysicalSubjectOperation>>>()
  const operationsFor = (reading: Reading, stale: boolean): ReadonlyMap<string, PhysicalSubjectOperation> => {
    let cached = operationCache.get(reading)
    if (!cached) { cached = new Map(); operationCache.set(reading, cached) }
    const previous = cached.get(stale); if (previous) return previous
    const next = new Map(reading.subjects.map(subject => [subject.elementId, resolvePhysicalSubjectOperation(subject, reading.sample.observations, stale)]))
    cached.set(stale, next); return next
  }
  // Only freshness transitions, not every wall-clock tick, invalidate drawing.
  const frozenSceneIds = $derived(JSON.stringify(scenes.filter(scene => { const snapshot = snapshots.get(scene.descriptor.id); return snapshot === undefined || layoutLiveFrozen(snapshot, wallNow) }).map(scene => scene.descriptor.id)))
  const frozenScenes = $derived(new Set<string>(JSON.parse(frozenSceneIds)))
  const appliedStatus = new Map<string, { readonly reading: Reading | undefined; readonly stale: boolean; readonly palette: string }>()
  const statusesFor = (reading: Reading, stale: boolean): ReadonlyMap<string, ReturnType<typeof physicalSubjectStatus>> => {
    let cached = statusCache.get(reading)
    if (!cached) { cached = new Map(); statusCache.set(reading, cached) }
    const previous = cached.get(stale)
    if (previous) return previous
    const next = new Map(reading.subjects.map(subject => [subject.elementId, physicalSubjectStatus({ subject: { packId: reading.scope.packId, objectId: reading.scope.objectId, elementId: subject.elementId, label: subject.label }, values: subject.values, observations: reading.sample.observations }, reading.sample.alerts, stale)]))
    cached.set(stale, next); return next
  }
  let overviewLayer = $state.raw<ReturnType<typeof createPhysicalSceneOverview> | null>(null)
  let overlayDirty = true
  let cameraSignature = ''
  let focusGeneration = 0
  const fitPadding = (request?: PhysicalSceneFitRequest) => {
    const padding = reservedPadding
    const surface = controller?.surface.element.getBoundingClientRect(), tools = toolsElement?.getBoundingClientRect(), camera = cameraElement?.getBoundingClientRect()
    if (!surface) return padding
    const nativeControls = [...map.getContainer().querySelectorAll<HTMLElement>('.maplibregl-ctrl')].map(element => element.getBoundingClientRect()).filter(box => box.width > 0 && box.height > 0)
    const covers = [tools, camera, ...nativeControls].filter((cover): cover is DOMRect => cover !== undefined).map(cover => ({ x: cover.left - surface.left, y: cover.top - surface.top, width: cover.width, height: cover.height }))
    if (inspected !== null) covers.push({ ...cardPoint, width: inspectionWidth, height: allocatedInspectionHeight })
    return physicalExplorerFitPadding(surface, { ...padding, top: Math.max(padding.top, clearTop > surface.top ? clearTop - surface.top + 8 : 0) }, covers, request?.measure)
  }
  const afterPanels = async (work: () => void): Promise<void> => {
    const generation = ++focusGeneration
    await tick()
    if (generation !== focusGeneration || !active || suspended || !documentVisible) return
    try { work() } catch (error) { onerror(error instanceof Error ? error.message : String(error)) }
  }
  const focused = $derived(scenes.find(scene => scene.descriptor.id === focusedId) ?? scenes.find(scene => scene.status === 'ready') ?? scenes[0] ?? null)
  const focusedOwner = $derived(objects.find(object => object.id === focused?.descriptor.targetObjectId) ?? null)
  const focusedLabel = $derived(objects.find(object => object.id === focused?.descriptor.id)?.label ?? focusedOwner?.label ?? 'Physical layout')
  const groups = $derived.by(() => {
    const result = new Map<string, { id: string; label: string; sceneIds: string[] }>()
    for (const scene of scenes) if (scene.descriptor.group) {
      const group = result.get(scene.descriptor.group.id)
      if (group) group.sceneIds.push(scene.descriptor.id)
      else result.set(scene.descriptor.group.id, { ...scene.descriptor.group, sceneIds: [scene.descriptor.id] })
    }
    return result
  })
  const choices = $derived.by((): ReadonlyArray<ExplorerScopeChoice> => [
    ...[...groups.values()].map(group => ({ key: explorerGroupKey(group.id), sceneId: null, groupId: group.id, sceneIds: group.sceneIds, label: group.label, path: group.label, depth: 0, kind: 'site group' })),
    ...scenes.flatMap(scene => explorerScopeChoices(scene.descriptor, objects.find(object => object.id === scene.descriptor.id)?.label ?? scene.descriptor.targetObjectId)),
  ])
  $effect(() => {
    const current = controller
    if (!current || !collectionInspection || focusedId !== null) return
    const ids = focusedGroupId === null ? scenes.map(scene => scene.descriptor.id) : groups.get(focusedGroupId)?.sceneIds ?? []
    untrack(() => current.selectCollection(ids))
  })
  const collectionScenes = $derived(scenes.filter(scene => focusedGroupId === null || scene.descriptor.group?.id === focusedGroupId))
  const collectionFloorGroups = $derived(focusedId === null ? physicalCollectionFloorGroups(collectionScenes, scene => objects.find(object => object.id === scene.descriptor.targetObjectId)?.label ?? scene.descriptor.targetObjectId) : [])
  const collectionLayerChoices = $derived(focusedId === null ? physicalCollectionLayerChoices(collectionScenes, scene => objects.find(object => object.id === scene.descriptor.targetObjectId)?.label ?? scene.descriptor.targetObjectId) : [])
  const mixedSettings = $derived(focusedId === null ? physicalCollectionMixedSettings(collectionScenes) : [])
  const scopeKey = $derived(focusedId === null ? focusedGroupId === null ? null : explorerGroupKey(focusedGroupId) : explorerLayoutKey(focusedId, focusedScopeId ?? undefined))
  const activeScope = $derived(focused?.descriptor.scopes?.find(scope => scope.id === focusedScopeId) ?? null)
  const scopeTitle = $derived(focusedId === null ? groups.get(focusedGroupId ?? '')?.label ?? 'All layouts' : activeScope?.label ?? focusedLabel)
  const scopePath = $derived(choices.find(choice => choice.key === scopeKey)?.path ?? 'All admitted layouts')
  const scopeLevels = $derived(focusedId === null ? [] : activeScope === null ? focused?.descriptor.levels ?? [] : (focused?.descriptor.levels ?? []).filter(level => activeScope.levelIds.includes(level.id)))
  const latest = $derived(focused === null ? null : snapshots.get(focused.descriptor.id) ?? null)
  const frozen = $derived(latest === null || layoutLiveFrozen(latest, wallNow))
  const components = $derived(scenes.filter(scene => componentScope !== null ? scene.descriptor.id === componentScope.sceneId : (focusedId === null || scene.descriptor.id === focusedId) && (focusedGroupId === null || scene.descriptor.group?.id === focusedGroupId)).flatMap(scene => scene.descriptor.subjectIds.map(id => ({
    sceneId: scene.descriptor.id, elementId: id, label: snapshots.get(scene.descriptor.id)?.latest?.subjects.find(subject => subject.elementId === id)?.label ?? id,
    owner: objects.find(object => object.id === scene.descriptor.targetObjectId)?.label ?? scene.descriptor.targetObjectId,
  }))))
  const activeInspection = $derived(scenes.find(scene => scene.descriptor.id === inspected?.sceneId) ?? null)
  const inspectedOwner = $derived(objects.find(object => object.id === activeInspection?.descriptor.targetObjectId) ?? null)
  const inspectionState = $derived.by((): LayoutInspectionState | null => {
    if (inspected === null || activeInspection === null || inspectedOwner === null) return null
    return {
      layoutObjectId: objectIdSchema.parse(activeInspection.descriptor.id), revision: activeInspection.descriptor.revision, objectId: inspectedOwner.id,
      packId: inspectedOwner.packId, modelDigest: activeInspection.descriptor.modelDigest, elementId: inspected.elementId, label: inspected.label,
      delivery: 'host', channel: inspected.channel,
    }
  })
  const inspectionSource = $derived.by(() => {
    if (inspectionState === null) return null
    const envelope = layoutInspectionEnvelope({ workspaceId: activeWorkspaceId(), runId, state: inspectionState })
    return `${embeddedViewPath(envelope)}${embeddedViewFragment(envelope)}`
  })
  const closeInspection = (returnFocus = false): void => {
    inspected = null; inspectionReady = false
    if (returnFocus) controller?.surface.element.focus({ preventScroll: true })
  }
  const overview = (scene: PhysicalScenePresentation): void => {
    if (suspended) return
    closeInspection(); hover = null
    const owner = objects.find(object => object.id === scene.descriptor.targetObjectId)
    if (owner !== undefined) onoverview(owner)
  }
  const inspect = (sceneId: string, elementId: string, label: string, occurrenceId: string | null): void => {
    if (suspended) return
    pendingFocus = null; pendingCameraFocus = null; focusGeneration++
    // A physical housing or casing is not a new measured process component.
    const ownerLabel = snapshots.get(sceneId)?.latest?.subjects.find(subject => subject.elementId === elementId)?.label
    inspected = { sceneId, elementId, label: ownerLabel ?? label, occurrenceId, channel: crypto.randomUUID() }
    inspectionReady = false
    hover = null
    inspectionHeight = null
  }
  const inspectHit = (hit: PhysicalSceneHit): void => {
    if (hit.subjectIds.length === 1) inspect(hit.sceneId, hit.subjectIds[0]!, hit.label, hit.occurrenceId)
    else { controlsOpen = true; componentScope = { sceneId: hit.sceneId, label: hit.label, subjectIds: hit.subjectIds }; filter = ''; componentsOpen = true }
  }
  const hoverIntent = createPhysicalHoverIntent(hit => {
    if (!active || suspended || !documentVisible || inspected !== null) return
    const current = controller?.pick(hit.screen)
    if (current?.sceneId === hit.sceneId && current.occurrenceId === hit.occurrenceId && current.subjectIds.length > 0) inspectHit(current)
  })
  const highlighted = $derived(hover ?? (inspected?.occurrenceId ? { sceneId: inspected.sceneId, occurrenceId: inspected.occurrenceId } : null))
  const hoverContext = $derived.by(() => {
    if (hover === null || hover.subjectIds.length !== 1) return []
    const reading = snapshots.get(hover.sceneId)?.latest
    return reading ? physicalOperationContext(operationsFor(reading, frozenScenes.has(hover.sceneId)).get(hover.subjectIds[0]!)) : []
  })
  const hoverPoint = $derived.by(() => {
    const point = hover?.screen ?? { x: 0, y: 0 }, box = hoverLabelSize
    return { x: Math.max(8, Math.min(size.width - box.width - 8, point.x + 16)), y: point.y + 16 + box.height <= size.height - 8 ? point.y + 16 : Math.max(8, Math.min(size.height - box.height - 8, point.y - box.height - 16)) }
  })
  $effect(() => {
    const element = hoverLabelElement
    if (!element) return
    const measure = (): void => { const box = element.getBoundingClientRect(); if (box.width !== hoverLabelSize.width || box.height !== hoverLabelSize.height) hoverLabelSize = { width: box.width, height: box.height } }
    const observer = new ResizeObserver(measure); observer.observe(element); measure()
    return () => observer.disconnect()
  })
  $effect(() => {
    const color = draftingPalette?.materials.selection
    controller?.setHighlight(active && !suspended && documentVisible && highlighted !== null && color ? { sceneId: highlighted.sceneId, occurrenceId: highlighted.occurrenceId, color } : null)
    hoverIntent.update(active && !suspended && documentVisible && inspected === null ? hover : null)
  })
  const frameHost = createEmbeddedFrameHost({
    origin: location.origin, frame: () => inspectionFrame?.contentWindow ?? null,
    post: (frame, message) => (frame as Window).postMessage(message, location.origin),
    open: listing => {
      if (listing.envelope.subject.workspaceId !== activeWorkspaceId() || String(listing.envelope.subject.id) !== String(runId) || listing.envelope.moduleId !== 'world') return onerror('Physical layout inspection requested a display outside this Run')
      onopen(listing)
      closeInspection()
    },
  })
  const publishInspection = (): void => {
    if (!inspectionReady || inspectionState === null || inspected === null || inspectionFrame?.contentWindow === null || inspectionFrame?.contentWindow === undefined) return
    const sample = snapshots.get(inspected.sceneId) ?? { phase: 'connecting' as const, latest: null, stamp: null, failure: null }
    inspectionFrame.contentWindow.postMessage(layoutInspectionSampleMessage(inspectionState, sample), location.origin)
  }
  $effect(() => { void snapshots; void inspectionState; void inspectionReady; void inspectionFrame; untrack(publishInspection) })
  const inspectionRoom = $derived.by(() => {
    void screenRevision
    const surfaceTop = controller?.surface.element.getBoundingClientRect().top ?? 0
    return layoutInspectionHostRoom(size, reservedPadding, clearTop - surfaceTop)
  })
  const inspectionWidth = $derived(Math.min(360, inspectionRoom.width))
  const allocatedInspectionHeight = $derived(Math.min(inspectionHeight ?? inspectionRoom.height, inspectionRoom.height))
  $effect(() => {
    const state = inspectionState, frame = inspectionFrame?.contentWindow, availableHeight = inspectionRoom.height
    if (inspectionReady && state !== null && frame !== null && frame !== undefined) frame.postMessage(layoutInspectionSpaceMessage(state, availableHeight), location.origin)
  })

  $effect(() => {
    const current = controller
    const sources = physicalLayoutSources({ bindings, objects, hiddenCategoryIds, presentationFor })
    untrack(() => current?.setSources(sources))
  })
  $effect(() => { void theme; const element = controller?.surface.element; if (!element) return; const palette = untrack(() => physicalLayoutPalette(element)); draftingPalette = palette; untrack(() => { controller?.setPalette(palette); overviewLayer?.setPalette(palette) }); const color = (role: string) => `rgb(${palette.materials[role]!.map(channel => channel * 255).join(' ')})`; draftingColors = { line: color('line'), allowance: color('outage'), access: color('access') } })
  $effect(() => {
    void screenRevision
    const current = controller, target = draftingCanvas, colors = draftingColors, palette = draftingPalette, width = size.width, height = size.height
    if (!target || !current || !colors || !palette) return
    const drafting = !active || suspended || !documentVisible ? [] : scenes.flatMap(presentation => {
      if (presentation.status !== 'ready' || presentation.view.mode !== '2d' || focusedId !== null && presentation.descriptor.id !== focusedId || focusedGroupId !== null && presentation.descriptor.group?.id !== focusedGroupId) return []
      const scene = current.scene(presentation.descriptor.id)
      return scene && (visiblePhysicalPlanDrawing(scene, presentation.view, focusedScopeId).length || visiblePhysicalPlanAnnotations(scene, presentation.view, focusedScopeId).length) ? [{ scene, view: presentation.view }] : []
    })
    if (!drafting.length && !flowMarks.length) { if (target.width || target.height) { target.width = 0; target.height = 0 }; return }
    const context = target.getContext('2d'); if (!context) { onerror('Architectural Plan annotations require a Canvas 2D context'); return }
    const ratio = window.devicePixelRatio || 1, pixelWidth = Math.round(width * ratio), pixelHeight = Math.round(height * ratio)
    if (target.width !== pixelWidth || target.height !== pixelHeight) { target.width = pixelWidth; target.height = pixelHeight }
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height)
    const style = getComputedStyle(target), fontSize = Number.parseFloat(style.fontSize), occupied: Array<{ x: number; y: number; width: number; height: number }> = []
    const covers = [toolsBox, cameraBox].filter((box): box is NonNullable<typeof box> => box !== null)
    for (const { scene, view } of drafting) {
      if (scene.planDrawing) drawPhysicalPlanDrawing(context, { scene, view, scopeId: focusedScopeId, project: points => current.projectPlanPoints(scene.id, points), width, height, ratio, palette, fontFamily: style.fontFamily, status: current.subjectStyles(scene.id), highlight: highlighted?.sceneId === scene.id && palette.materials.selection ? { ...highlighted, color: palette.materials.selection } : null })
      else drawPhysicalPlanAnnotations(context, { scene, view, scopeId: focusedScopeId, project: points => current.projectPlanPoints(scene.id, points), width, height, covers, ...colors, font: `${fontSize}px ${style.fontFamily}`, fontSize }, occupied)
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    const css = (color: readonly number[]) => `rgb(${color.map(channel => channel * 255).join(' ')})`
    for (const mark of flowMarks) drawPhysicalFlowMark(context, mark, { ink: css(palette.materials.dark!), paper: css(scenes.find(scene => scene.descriptor.id === mark.sceneId)?.view.mode === '2d' ? palette.planMaterials!.paper! : palette.materials.ground!), fontSize, fontFamily: style.fontFamily })
  })
  $effect(() => { overviewLayer?.update(!active || suspended ? [] : scenes) })
  $effect(() => { onDetailedOwners(!active || suspended ? [] : scenes.filter(scene => scene.status === 'ready').map(scene => scene.descriptor.targetObjectId)) })
  $effect(() => {
    void scenes; void objects; void runId; void perspectiveEpoch; void suspended; void documentVisible; void active; void inspected
    untrack(() => {
    const needed = new Set<string>()
    for (const [id, snapshot] of snapshots) {
      const descriptor = scenes.find(scene => scene.descriptor.id === id)?.descriptor
      if (descriptor === undefined || snapshot.latest !== null && (snapshot.latest.scope.revision !== descriptor.revision || snapshot.latest.scope.modelDigest !== descriptor.modelDigest)) snapshots = new Map([...snapshots].filter(([key]) => key !== id))
    }
    for (const scene of scenes) {
      // A floor/representation change retains the validated source and exact
      // owner scope. Keep its acquisition alive while only geometry prepares.
      if (!physicalExplorerNeedsLive({ active, documentVisible, suspended, sourceLoaded: Boolean(controller?.scene(scene.descriptor.id)), locationValid: scene.descriptor.locationValid, representation: scene.status, statusLayer: scene.view.live, sceneId: scene.descriptor.id, inspectedSceneId: inspected?.sceneId ?? null })) continue
      const owner = objects.find(object => object.id === scene.descriptor.targetObjectId)
      if (owner === undefined) continue
      const expected = { runId, layoutObjectId: objectIdSchema.parse(scene.descriptor.id), revision: scene.descriptor.revision, objectId: owner.id, packId: owner.packId, modelDigest: scene.descriptor.modelDigest }
      const key = JSON.stringify([expected, perspectiveEpoch])
      needed.add(scene.descriptor.id)
      if (sessions.get(scene.descriptor.id)?.key === key) continue
      sessions.get(scene.descriptor.id)?.session.close()
      const id = scene.descriptor.id
      snapshots = new Map([...snapshots].filter(([existing]) => existing !== id))
      const session = createLayoutLiveSession({ expected, subjectIds: scene.descriptor.subjectIds, routes: layoutLiveRoutes, onChange: snapshot => { snapshots = new Map(snapshots).set(id, snapshot); wallNow = Date.now() } })
      sessions.set(id, { key, session })
      session.start()
    }
    for (const [id, entry] of sessions) if (!needed.has(id)) {
      entry.session.close(); sessions.delete(id)
      const retained = snapshots.get(id)
      snapshots = scenes.some(scene => scene.descriptor.id === id) && retained !== undefined
        ? new Map(snapshots).set(id, { ...retained, phase: 'suspended' }) : new Map([...snapshots].filter(([key]) => key !== id))
    }
    })
  })
  $effect(() => {
    const current = controller
    if (!current) return
    const palette = theme === 'dark' ? 'dusk' : 'day'
    for (const scene of scenes) {
      const snapshot = snapshots.get(scene.descriptor.id)
      const stale = snapshot === undefined || layoutLiveFrozen(snapshot, wallNow)
      const reading = snapshot?.latest ?? undefined
      const previous = appliedStatus.get(scene.descriptor.id)
      if (previous?.reading === reading && previous?.stale === stale && previous?.palette === palette) continue
      const styles = new Map(reading ? [...statusesFor(reading, stale)].map(([id, status]) => [id, physicalSubjectStyle(status, palette)] as const) : [])
      untrack(() => current.setStatus(scene.descriptor.id, styles))
      appliedStatus.set(scene.descriptor.id, { reading, stale, palette })
    }
  })
  let inspectionPerspective = untrack(() => perspectiveEpoch)
  $effect(() => {
    const changedPerspective = inspectionPerspective !== perspectiveEpoch
    inspectionPerspective = perspectiveEpoch
    if (changedPerspective) {
      snapshots = new Map(); focusGeneration++; pendingFocus = null; pendingCameraFocus = null
      focusLocations = null; floorChoice = null; scopeFloorChoice = null; componentScope = null; componentsOpen = false; filter = ''
    }
    if (changedPerspective || !active || suspended || !documentVisible || (inspected !== null && activeInspection?.status !== 'ready')) { closeInspection(); hover = null; controller?.cancelCamera() }
  })

  $effect(() => { controller?.setActive(active && documentVisible); controller?.setCameraOwnership(!suspended); if (!active || suspended || !documentVisible) { focusGeneration++; pendingFocus = null; pendingCameraFocus = null; scopeFloorChoice = null; controller?.cancelCamera(); controller?.setNavigationTool('pan'); navigation = 'pan' } })

  const scopedOccurrences = $derived(annotationScenes.filter(scene => scene.status === 'ready').flatMap(scene => (controller?.scene(scene.descriptor.id)?.objects ?? []).filter(occurrence =>
    (focusedId === null || focusedId === scene.descriptor.id) && (focusedGroupId === null || scene.descriptor.group?.id === focusedGroupId) && physicalOccurrenceInScope(occurrence, focusedScopeId, scene.descriptor.scopes ?? []) && physicalOccurrenceOnLevel(occurrence, scene.view.levelId) && (occurrence.layerId === undefined || !(scene.view.hiddenLayerIds ?? scene.descriptor.layers?.filter(layer => !layer.defaultVisible).map(layer => layer.id) ?? []).includes(occurrence.layerId)),
  ).map(occurrence => ({ sceneId: scene.descriptor.id, occurrence }))))
  const scopedBySubject = $derived.by(() => {
    const index = new Map<string, Map<string, Array<typeof scopedOccurrences[number]['occurrence']>>>()
    for (const { sceneId, occurrence } of scopedOccurrences) {
      let bySubject = index.get(sceneId)
      if (!bySubject) { bySubject = new Map(); index.set(sceneId, bySubject) }
      for (const subjectId of occurrence.subjectIds) {
        const locations = bySubject.get(subjectId)
        if (locations) locations.push(occurrence); else bySubject.set(subjectId, [occurrence])
      }
    }
    return index
  })
  const statusSummary = $derived.by(() => {
    if (focused === null || latest?.latest === null || latest === null) return null
    const reading = latest.latest
    return physicalLayoutStatusSummary({ owners: [{ packId: reading.scope.packId, objectId: reading.scope.objectId }], alerts: reading.sample.alerts,
      occurrences: (controller?.scene(focused.descriptor.id)?.objects ?? []).map(occurrence => ({ id: occurrence.id, disposition: 'installed', subjects: occurrence.subjectIds.map(elementId => ({ packId: reading.scope.packId, objectId: reading.scope.objectId, elementId, label: occurrence.label })) })),
      visibleOccurrenceIds: new Set(scopedOccurrences.filter(entry => entry.sceneId === focused.descriptor.id).map(entry => entry.occurrence.id)),
    })
  })
  let showStateWords = $state(false)
  type Badge = { readonly kind: 'status'; readonly sceneId: string; readonly elementId: string; readonly label: string; readonly occurrenceId: string; readonly point: { readonly x: number; readonly y: number }; readonly width: number; readonly color: string; readonly word: string; readonly chip: string; readonly alarms: number; readonly rank: number }
  type FlowMark = { readonly kind: 'flow'; readonly key: string; readonly sceneId: string; readonly occurrenceId: string; readonly point: { readonly x: number; readonly y: number }; readonly angle: number; readonly glyph: PhysicalFlowGlyph; readonly rank: number }
  let testedBadges = $state.raw<ReadonlyArray<Badge>>([])
  let testedFlowMarks = $state.raw<ReadonlyArray<FlowMark>>([])
  let pendingBadges = $state(0)
  let annotationScheduler = $state.raw<ReturnType<typeof createPhysicalAnnotationScheduler<Badge | FlowMark>> | null>(null)
  const proposedBadges = $derived.by(() => {
    void screenRevision
    if (!active || suspended || !documentVisible) return []
    const proposals = annotationScenes.filter(scene => scene.status === 'ready' && scene.view.live).flatMap(scene => {
      const snapshot = snapshots.get(scene.descriptor.id)
      const reading = snapshot?.latest
      if (reading === undefined || reading === null) return []
      const stale = frozenScenes.has(scene.descriptor.id), operations = operationsFor(reading, stale)
      return reading.subjects.flatMap(subject => {
        const status = statusesFor(reading, stale).get(subject.elementId)!
        const operationWord = physicalOperationBadgeWord(operations.get(subject.elementId), showStateWords)
        if (!stale && status.quality === 'good' && status.census.total === 0 && !showStateWords && operationWord === null) return []
        return (scopedBySubject.get(scene.descriptor.id)?.get(subject.elementId) ?? []).flatMap(occurrence => {
          const point = controller?.cheapProject(scene.descriptor.id, occurrence.id)
          if (!point?.visible) return []
          const color = physicalSubjectStyle(status, theme === 'dark' ? 'dusk' : 'day').color
          const chip = stale ? '?' : operationWord ?? (status.quality !== 'good' ? '?' : status.word ?? ''), alarms = status.active + status.returned
          const text = alarms > 0 ? String(alarms) : chip
          // The chip uses 11px text, 10px horizontal padding and a 2px border.
          const width = Math.max(44, Math.min(96, badgeMeasure?.measureText(text).width ?? 96) + 12)
          return [{ kind: 'status' as const, sceneId: scene.descriptor.id, elementId: subject.elementId, label: subject.label, occurrenceId: occurrence.id, point,
            width,
            color: color === null ? 'var(--muted)' : `rgb(${color.map(channel => Math.round(channel * 255)).join(' ')})`,
            word: stale ? 'Not live' : operationWord ?? (status.quality !== 'good' ? `${status.quality} quality` : status.word ?? 'Live'),
            chip, alarms, rank: priorityRank(status.priority) }]
        })
      })
    })
    return proposals
  })
  // Readings change glyphs; only a changed connection roster changes which
  // physical paths need projection. Equal membership preserves screen geometry.
  const flowSubjectMembership = $derived.by(() => JSON.stringify(annotationScenes.map(scene => {
    const reading = snapshots.get(scene.descriptor.id)?.latest
    if (!scene.view.live || !reading) return [scene.descriptor.id, []]
    const operations = operationsFor(reading, frozenScenes.has(scene.descriptor.id))
    return [scene.descriptor.id, reading.subjects.filter(subject => operations.get(subject.elementId)?.connection).map(subject => subject.elementId)]
  })))
  const flowSubjectIndex = $derived(new Map((JSON.parse(flowSubjectMembership) as Array<[string, string[]]>).map(([sceneId, subjects]) => [sceneId, new Set(subjects)])))
  type ProjectedFlowMark = Omit<FlowMark, 'glyph'> & { readonly elementId: string }
  const flowScopeRegions = new WeakMap<PackPhysicalScene, { readonly scopeId: string | undefined; readonly regions: ReturnType<typeof physicalScopeRegions> }>()
  const projectedFlowMarks = $derived.by((): ReadonlyArray<ProjectedFlowMark> => {
    void screenRevision; void theme
    if (!active || suspended || !documentVisible || !controller || !draftingCanvas) return []
    const fontSize = Number.parseFloat(getComputedStyle(draftingCanvas).fontSize)
    const marks: ProjectedFlowMark[] = [], presentations = new Map(annotationScenes.map(scene => [scene.descriptor.id, scene]))
    const sceneContexts = new Map<string, { readonly source: PackPhysicalScene; readonly regions: ReturnType<typeof physicalScopeRegions> }>()
    const scopeId = focusedScopeId ?? undefined
    for (const { sceneId, occurrence } of scopedOccurrences) {
      if (!occurrence.spatialPath || occurrence.subjectIds.length !== 1 || !flowSubjectIndex.get(sceneId)?.has(occurrence.subjectIds[0]!)) continue
      const presentation = presentations.get(sceneId)
      if (!presentation?.view.live) continue
      let context = sceneContexts.get(sceneId)
      if (!context) {
        const source = controller.scene(sceneId); if (!source) continue
        let cached = flowScopeRegions.get(source)
        if (!cached || cached.scopeId !== scopeId) { cached = { scopeId, regions: physicalScopeRegions(source, scopeId) }; flowScopeRegions.set(source, cached) }
        context = { source, regions: cached.regions }; sceneContexts.set(sceneId, context)
      }
      let ordinal = 0
      for (const path of physicalRouteInspectionPaths(occurrence, context.regions, presentation.view)) {
        const projected = createPhysicalRouteScreenMarks(size, fontSize)
        controller.visitOccurrencePoints(sceneId, occurrence.id, path.points, projected.add, path.levelId)
        for (const mark of projected.marks) marks.push({ ...mark, kind: 'flow', key: `${sceneId}:${occurrence.id}:${ordinal++}`, sceneId, occurrenceId: occurrence.id, elementId: occurrence.subjectIds[0]!, rank: 0 })
      }
    }
    return marks
  })
  const proposedFlowMarks = $derived.by((): ReadonlyArray<FlowMark> => {
    const marks: FlowMark[] = []
    for (const mark of projectedFlowMarks) {
      const reading = snapshots.get(mark.sceneId)?.latest
      if (!reading) continue
      const operation = operationsFor(reading, frozenScenes.has(mark.sceneId)).get(mark.elementId)
      if (!operation?.connection) continue
      const flow = operation.flow, conducting = operation.conducting
      const glyph: PhysicalFlowGlyph = flow ? flow.direction === 'forward' || flow.direction === 'reverse' || flow.direction === 'stopped' ? flow.direction : 'unknown' : conducting?.active === true ? 'conducting' : conducting?.active === false ? 'deenergized' : 'unknown'
      marks.push({ ...mark, glyph })
    }
    return marks
  })
  $effect(() => {
    annotationScheduler?.setActive(active && !suspended && documentVisible)
    const generation = JSON.stringify([screenRevision, annotationSceneKey, focusedId, focusedScopeId, focusedGroupId])
    const candidates = sparseLayoutBadges(proposedBadges, size, [toolsBox, cameraBox].filter((box): box is NonNullable<typeof box> => box !== null))
    const marks = sparseLayoutBadges(proposedFlowMarks, size, [toolsBox, cameraBox].filter((box): box is NonNullable<typeof box> => box !== null))
    annotationScheduler?.update(generation, [...candidates.map(value => ({ key: `status:${value.sceneId}:${value.occurrenceId}:${value.elementId}`, priority: value.rank, value })), ...marks.map(value => ({ key: `flow:${value.key}`, priority: value.rank, value }))])
  })
  const flowMarks = $derived.by(() => { const visible = new Set(testedFlowMarks.map(mark => mark.key)); return proposedFlowMarks.filter(mark => visible.has(mark.key)) })
  const badges = $derived.by(() => {
    const visible = new Set(testedBadges.map(value => `${value.sceneId}:${value.occurrenceId}:${value.elementId}`))
    return sparseLayoutBadges(proposedBadges.filter(value => visible.has(`${value.sceneId}:${value.occurrenceId}:${value.elementId}`)), size, [toolsBox, cameraBox].filter((box): box is NonNullable<typeof box> => box !== null))
  })
  const cardPoint = $derived.by(() => {
    void screenRevision
    const projected = inspected?.occurrenceId ? controller?.project(inspected.sceneId, inspected.occurrenceId) : null
    const anchor = projected?.visible ? projected : null
    return { x: Math.max(inspectionRoom.x, Math.min(inspectionRoom.x + inspectionRoom.width - inspectionWidth, (anchor?.x ?? size.width / 2) + 24)), y: Math.max(inspectionRoom.y, Math.min(inspectionRoom.y + inspectionRoom.height - allocatedInspectionHeight, (anchor?.y ?? 80) - 30)) }
  })
  const baseStatusText = $derived(focusedId === null ? `${scenes.filter(scene => scene.status === 'ready').length} layouts ready · ${scenes.filter(scene => scene.status === 'loading').length} loading · ${scenes.filter(scene => scene.status === 'unavailable').length} unavailable · owner-qualified alarms remain in Run`
    : focused?.status === 'loading' ? 'Loading this physical layout…'
    : focused?.status === 'distant' ? 'Explore on map to load this physical layout'
    : focused?.status === 'hidden' ? 'Physical detail hidden by view settings'
    : focused?.status === 'unavailable' ? focused.reason ?? 'Layout unavailable'
    : latest?.failure ?? (latest?.phase === 'inactive' ? 'Run not loaded; layout is not live' : latest?.phase === 'missing' ? 'Run missing' : latest?.latest === null || latest === null ? 'Waiting for live owner status'
      : frozen ? `Not live · ${latest.phase === 'suspended' ? 'updates suspended' : latest.phase} · last acquired ${Math.max(0, Math.floor((wallNow - (latest.stamp?.receivedWallMs ?? wallNow)) / 1000))} s ago` : `${latest.latest.sample.at.paused ? 'Paused · fresh' : 'Live'} · ${latest.latest.subjects.length} modelled subjects · ${statusSummary?.census.total ?? 0} owner alerts`))
  const additionalLayerStatus = $derived((focusedId === null ? scenes.filter(scene => focusedGroupId === null || scene.descriptor.group?.id === focusedGroupId) : focused ? [focused] : []).map(physicalLayerPreparationText).filter((text): text is string => text !== null).join(' · '))
  const opacityStatus = $derived(physicalOpacityPreparationText(focusedId === null ? collectionScenes : focused ? [focused] : []))
  const statusText = $derived([baseStatusText, additionalLayerStatus, opacityStatus].filter(Boolean).join(' · '))
  const retryableLayouts = $derived(retryablePhysicalLayouts(scenes, focusedId, focusedGroupId))
  const retryLabel = $derived(`Retry physical layout: ${retryableLayouts.map(id => objects.find(object => object.id === scenes.find(scene => scene.descriptor.id === id)?.descriptor.targetObjectId)?.label ?? id).join(', ')}`)
  const retryFailedLayouts = (): void => {
    if (suspended) return
    for (const id of retryableLayouts) controller?.retry(id)
  }

  const chooseScope = (key: string | null, chosenLevel?: string): void => {
    if (suspended) return
    closeInspection(); hover = null; componentsOpen = false; componentScope = null; focusLocations = null; floorChoice = null; scopeFloorChoice = null; pendingFocus = null; pendingCameraFocus = null
    const choice = choices.find(candidate => candidate.key === key)
    if (choice?.sceneId) {
      const sceneId = choice.sceneId, scene = scenes.find(scene => scene.descriptor.id === sceneId)
      if (!scene) return
      const levels = choice.scopeId === undefined ? scene.descriptor.levels.map(level => level.id) : scene.descriptor.scopes?.find(scope => scope.id === choice.scopeId)?.levelIds ?? []
      const levelId = chosenLevel ?? levelForScopeFocus(levels, scene.view)
      if (levelId === null) { scopeFloorChoice = { key: choice.key, sceneId, label: choice.label, levelIds: levels }; return }
      collectionInspection = false; focusedId = sceneId; focusedScopeId = choice.scopeId ?? null; focusedGroupId = scene.descriptor.group?.id ?? null
      controller?.selectScope(sceneId, choice.scopeId)
      if (scene.view.levelId !== levelId) controller?.setView(sceneId, { ...requestedPhysicalLayoutView(scene), mode: levelId === 'all' ? '3d' : scene.view.mode, levelId })
      void afterPanels(() => controller?.focus(sceneId, { scopeId: choice.scopeId, levelId, preservePose: true }))
    }
    else { collectionInspection = true; focusedId = null; focusedScopeId = null; focusedGroupId = choice?.groupId ?? null; void afterPanels(() => controller?.fitAll(choice?.sceneIds)) }
  }
  const changeView = (next: PhysicalSceneView, requested?: Partial<PhysicalSceneView>): void => {
    if (suspended) return
    const scene = focused
    if (!scene) return
    const changedRepresentation = scene.view.mode !== next.mode, changedFloor = scene.view.levelId !== next.levelId
    const opacityOnly = requested !== undefined && Object.keys(requested).every(key => key === 'wallOpacity' || key === 'floorOpacity')
    pendingCameraFocus = null; if (!opacityOnly) closeInspection(); hover = null
    if (next.mode === '2d') { navigation = 'pan'; controller?.setNavigationTool('pan') }
    if (changedRepresentation) {
      const selected = new Set(collectionScenes.map(scene => scene.descriptor.id))
      for (const current of scenes) {
        if (current.view.mode === '2d') rememberedPlanFloor.set(current.descriptor.id, current.view.levelId)
        const levelId = next.mode === '2d' ? physicalPlanLevelAfterModeChange(current, rememberedPlanFloor.get(current.descriptor.id)) : focusedId === null && selected.has(current.descriptor.id) ? 'all' : current.view.levelId
        controller?.setView(current.descriptor.id, { ...requestedPhysicalLayoutView(current), mode: next.mode, levelId })
      }
    } else if (focusedId === null) {
      const patch = Object.fromEntries((['live', 'cutaway', 'detail', 'separation', 'wallOpacity', 'floorOpacity'] as const).filter(key => requested ? key in requested : next[key] !== requestedPhysicalLayoutView(scene)[key]).map(key => [key, next[key]]))
      for (const current of collectionScenes) controller?.setView(current.descriptor.id, { ...requestedPhysicalLayoutView(current), ...patch })
    } else {
      if (scene.view.mode === '2d') rememberedPlanFloor.set(scene.descriptor.id, scene.view.levelId)
      controller?.setView(scene.descriptor.id, next)
    }
    if ((changedRepresentation || changedFloor) && (focusedId !== null || collectionInspection)) {
      const sceneId = focusedId, scopeId = focusedScopeId, ids = groups.get(focusedGroupId ?? '')?.sceneIds
      void afterPanels(() => { if (sceneId === null) controller?.fitAll(ids, { preservePose: !changedRepresentation }); else controller?.focus(sceneId, { scopeId: scopeId ?? undefined, preservePose: !changedRepresentation }) })
    }
  }
  const changeCollectionFloor = (key: string, levelId: string): void => {
    if (suspended || focusedId !== null) return
    const group = collectionFloorGroups.find(group => group.key === key)
    if (!group) return
    pendingFocus = null; pendingCameraFocus = null; closeInspection(); hover = null; collectionInspection = true
    const ids = collectionScenes.map(scene => scene.descriptor.id), changes = physicalCollectionFloorChanges(group, levelId)
    controller?.selectCollection(ids)
    for (const change of changes) { controller?.setView(change.sceneId, change.view); if (change.view.mode === '2d') rememberedPlanFloor.set(change.sceneId, levelId) }
    void afterPanels(() => controller?.fitAll(ids))
  }
  const changeCollectionLayer = (key: string, visible: boolean): void => {
    if (suspended || focusedId !== null) return
    const choice = collectionLayerChoices.find(choice => choice.key === key)
    if (!choice) return
    for (const change of physicalCollectionLayerChanges(choice, visible)) controller?.setView(change.sceneId, change.view)
  }
  const fit = (): void => { if (suspended) return; controls?.dismiss(); cameraControls?.dismiss(); componentsOpen = false; pendingFocus = null; pendingCameraFocus = null; const sceneId = focusedId, scopeId = focusedScopeId, ids = groups.get(focusedGroupId ?? '')?.sceneIds; if (sceneId === null) collectionInspection = true; void afterPanels(() => { if (sceneId === null) controller?.fitAll(ids); else controller?.focus(sceneId, { scopeId: scopeId ?? undefined, preservePose: true }) }) }
  const home = (): void => { if (suspended) return; controls?.dismiss(); cameraControls?.dismiss(); componentsOpen = false; pendingFocus = null; pendingCameraFocus = null; const sceneId = focusedId, scopeId = focusedScopeId, ids = groups.get(focusedGroupId ?? '')?.sceneIds; if (sceneId === null) collectionInspection = true; void afterPanels(() => { if (sceneId === null) controller?.fitAll(ids, { preservePose: false }); else controller?.home(sceneId, scopeId ?? undefined) }) }
  const focusOccurrence = (sceneId: string, occurrenceId: string, chosenLevel?: string): void => {
    if (suspended) return
    const scene = scenes.find(value => value.descriptor.id === sceneId), occurrence = controller?.scene(sceneId)?.objects.find(value => value.id === occurrenceId)
    if (!scene || !occurrence) return
    const level = chosenLevel ?? levelForPhysicalFocus(occurrence, scene.view)
    if (level === null) { controlsOpen = true; floorChoice = { sceneId, occurrenceId, label: occurrence.label, levelIds: occurrence.levelIds ?? [occurrence.levelId] }; return }
    collectionInspection = false; focusedId = sceneId; focusedScopeId = null; focusedGroupId = scene.descriptor.group?.id ?? null; closeInspection(); floorChoice = null; focusLocations = null; componentsOpen = false
    const mode = level === 'all' ? '3d' : scene.view.mode
    pendingCameraFocus = { sceneId, occurrenceId, levelId: level, mode }
    if (scene.status !== 'ready') controller?.focus(sceneId, { preservePose: true })
    else controller?.selectScope(sceneId)
    controller?.setView(sceneId, { ...requestedPhysicalLayoutView(scene), mode, levelId: level })
  }
  const focusComponent = (sceneId: string, subjectId: string, label: string): void => {
    collectionInspection = false
    const scene = controller?.scene(sceneId)
    if (!scene) { pendingFocus = { sceneId, subjectId, label }; controller?.focus(sceneId, { preservePose: true }); return }
    const locations = scene.objects.filter(value => value.subjectIds.includes(subjectId))
    if (locations.length === 1) focusOccurrence(sceneId, locations[0]!.id)
    else { controlsOpen = true; focusLocations = { sceneId, subjectId, label, occurrenceIds: locations.map(value => value.id) } }
  }
  $effect(() => {
    const pending = pendingFocus
    if (pending && scenes.some(scene => scene.descriptor.id === pending.sceneId && scene.status === 'ready')) { pendingFocus = null; untrack(() => focusComponent(pending.sceneId, pending.subjectId, pending.label)) }
    else if (pending && scenes.some(scene => scene.descriptor.id === pending.sceneId && scene.status === 'unavailable')) pendingFocus = null
  })
  $effect(() => {
    const pending = pendingCameraFocus
    if (!pending) return
    const scene = scenes.find(scene => scene.descriptor.id === pending.sceneId)
    if (!scene || scene.status === 'unavailable') { pendingCameraFocus = null; return }
    if (scene.status !== 'ready' || scene.view.levelId !== pending.levelId || scene.view.mode !== pending.mode) return
    pendingCameraFocus = null
    untrack(() => { void afterPanels(() => controller?.focus(pending.sceneId, { occurrenceId: pending.occurrenceId, levelId: pending.levelId, preservePose: true })) })
  })
  const coverRight = $derived(reservedPadding.right)
  const toolsTop = $derived.by(() => { void screenRevision; return Math.max(8, clearTop - (controller?.surface.element.getBoundingClientRect().top ?? 0) + 8) })
  $effect(() => {
    const element = toolsElement
    if (element === null) { toolsBox = null; return }
    const measure = (): void => {
      const box = element.getBoundingClientRect(), parent = controller?.surface.element.getBoundingClientRect()
      if (!parent) return
      toolsBox = { x: box.left - parent.left, y: box.top - parent.top, width: box.width, height: box.height }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element); measure()
    return () => observer.disconnect()
  })
  $effect(() => {
    const element = cameraElement
    if (!element) { cameraBox = null; return }
    const measure = (): void => {
      const box = element.getBoundingClientRect(), parent = controller?.surface.element.getBoundingClientRect()
      if (parent) cameraBox = { x: box.left - parent.left, y: box.top - parent.top, width: box.width, height: box.height }
    }
    const observer = new ResizeObserver(measure); observer.observe(element); measure()
    return () => observer.disconnect()
  })

  runOnMount(() => {
    const element = map.getContainer()
    badgeMeasure = document.createElement('canvas').getContext('2d')
    if (badgeMeasure) badgeMeasure.font = `11px ${getComputedStyle(element).fontFamily}`
    const options = { palette: physicalLayoutPalette(element), planFontFamily: () => getComputedStyle(draftingCanvas ?? element).fontFamily, fitPadding, ...(suspendPickingForNavigation === undefined ? {} : { suspendPickingForNavigation }), onChange: (next: ReadonlyArray<PhysicalScenePresentation>) => { if (annotationKey(next) !== annotationKey(scenes)) overlayDirty = true; scenes = next }, reportError: (error: Error) => onerror(`Physical layout: ${error.message}`) }
    let next: PhysicalSceneController
    try {
      next = createPhysicalSceneController({ ...options, map, beforeId: () => physicalSceneLayerAnchorId(map.getStyle()) })
    } catch (error) {
      viewportFailure = error instanceof Error ? error.message : String(error)
      onerror(`Physical viewport unavailable: ${viewportFailure}`)
      return
    }
    controller = next
    size = next.surface.getSize()
    overviewLayer = createPhysicalSceneOverview({ map, palette: options.palette, beforeId: () => physicalSceneLayerAnchorId(map.getStyle()), reportError: error => onerror(`Physical overview: ${error.message}`) })
    annotationScheduler = createPhysicalAnnotationScheduler<Badge | FlowMark>({ test: value => next.visibleAt(value.sceneId, value.occurrenceId, value.point), onChange: value => { testedBadges = value.visible.filter((value): value is Badge => value.kind === 'status'); testedFlowMarks = value.visible.filter((value): value is FlowMark => value.kind === 'flow'); pendingBadges = value.pending } })
    let hoverTimer: ReturnType<typeof setTimeout> | null = null
    const changed = (): void => {
      const pose = next.cameraPose()
      const signature = JSON.stringify([pose.pitch, pose.bearing, pose.zoom, pose.center])
      if (!overlayDirty && cameraSignature === signature) return
      cameraSignature = signature; overlayDirty = false
      cameraReadout = { pitch: pose.pitch, bearing: pose.bearing }
      size = next.surface.getSize(); screenRevision += 1
    }
    const pointAt = (event: PointerEvent | MouseEvent) => { const box = next.surface.element.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top } }
    const leave = (): void => { retainHover(); hoverIntent.clear(); if (hoverTimer !== null) clearTimeout(hoverTimer); hoverTimer = null; hover = null }
    const moving = (): void => { leave(); overlayDirty = true }
    const move = (event: PointerEvent): void => {
      retainHover()
      const target = event.target instanceof Element ? event.target : null
      if (!active || suspended || event.buttons !== 0 || target && (overlayElement?.contains(target) || target.closest('.maplibregl-ctrl'))) { leave(); return }
      if (hoverTimer !== null) clearTimeout(hoverTimer)
      const point = pointAt(event)
      hoverTimer = setTimeout(() => { hoverTimer = null; const hit = next.pick(point); hover = hit !== null && hit.subjectIds.length > 0 ? hit : null }, 120)
    }
    const activate = (point: { x: number; y: number }): boolean => {
      if (!active || suspended) return false
      const hit = next.pick(point), sceneId = hit?.sceneId ?? overviewLayer?.sceneAt(point)
      if (hit !== null && hit.subjectIds.length > 0) { inspectHit(hit); leave(); return true }
      if (inspected !== null) { closeInspection(true); leave(); return true }
      const scene = scenes.find(value => value.descriptor.id === sceneId)
      if (!scene) return false
      overview(scene); return true
    }
    const cancel = (): void => leave()
    const visibility = (): void => { documentVisible = !document.hidden }
    const receive = (event: MessageEvent): void => {
      frameHost.receive(event)
      if (event.origin !== location.origin || event.source !== inspectionFrame?.contentWindow || inspected === null) return
      const message = layoutInspectionMessageSchema.safeParse(event.data)
      if (!message.success || message.data.layoutObjectId !== inspected.sceneId || message.data.elementId !== inspected.elementId) return
      if (message.data.type === 'world:layout-inspection-close') closeInspection(message.data.returnFocus)
      else if (message.data.type === 'world:layout-inspection-ready') { if (message.data.channel === inspected.channel) { inspectionReady = true; publishInspection() } }
      else inspectionHeight = message.data.height
    }
    const key = (event: KeyboardEvent): void => {
      if (!active || suspended) return
      // Keyboard editing/navigation takes intent away from a resting pointer.
      // A pending dwell must not later steal focus into an equipment card.
      leave()
      const path = event.composedPath()
      const route = physicalExplorerKeyboardRoute({ path, surface: next.surface.element, overlay: overlayElement, defaultPrevented: event.defaultPrevented, composing: event.isComposing,
        descendantOwnsKeys: path.some(node => node instanceof Element && node.matches('input, select, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], dialog, [role="dialog"], [role="alertdialog"]')) })
      if (route === null) return
      if (route === 'surface') {
        if (event.key === 'Home') { home(); event.preventDefault(); return }
        if (event.key === '+' || event.key === '=' || event.key === '-' || event.key === '_') { next.zoomBy(event.key === '+' || event.key === '=' ? 1 : -1); event.preventDefault(); return }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { const delta = event.key === 'ArrowLeft' ? -1 : 1; if (event.shiftKey) next.turnBy(delta * 10); else next.panBy(delta * 40, 0); event.preventDefault(); return }
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { const delta = event.key === 'ArrowUp' ? -1 : 1; if (event.shiftKey && focused?.view.mode === '3d') next.tiltBy(-delta * 10); else next.panBy(0, delta * 40); event.preventDefault(); return }
      }
      if (event.key !== 'Escape') return
      if (inspected !== null) closeInspection(true)
      else if (focusLocations !== null || floorChoice !== null || scopeFloorChoice !== null) { focusLocations = null; floorChoice = null; scopeFloorChoice = null }
      else if (componentsOpen) componentsOpen = false
      else if (controls?.dismiss() || cameraControls?.dismiss()) { /* the active disclosure consumed Escape */ }
      else return
      next.cancelCamera(); event.preventDefault(); event.stopPropagation()
    }
    const clock = setInterval(() => { wallNow = Date.now() }, 250)
    const disposers = [next.surface.on('render', changed), next.surface.on('resize', () => { overlayDirty = true; changed() }), next.surface.on('movestart', moving)]
    const surface = next.surface.element
    surface.addEventListener('pointermove', move); surface.addEventListener('pointerdown', cancel); surface.addEventListener('pointercancel', cancel); surface.addEventListener('pointerleave', dismissHoverSoon)
    document.addEventListener('visibilitychange', visibility); document.addEventListener('focusin', cancel); window.addEventListener('blur', cancel); window.addEventListener('message', receive); window.addEventListener('keydown', key)
    onconnect({ dismiss: () => { closeInspection(); leave() }, activate })
    return () => {
      onconnect(null); onDetailedOwners([]); leave(); clearInterval(clock); disposers.forEach(dispose => dispose())
      surface.removeEventListener('pointermove', move); surface.removeEventListener('pointerdown', cancel); surface.removeEventListener('pointercancel', cancel); surface.removeEventListener('pointerleave', dismissHoverSoon)
      document.removeEventListener('visibilitychange', visibility); document.removeEventListener('focusin', cancel); window.removeEventListener('blur', cancel); window.removeEventListener('message', receive); window.removeEventListener('keydown', key)
      for (const entry of sessions.values()) entry.session.close()
      sessions.clear(); annotationScheduler?.destroy(); annotationScheduler = null; overviewLayer?.destroy(); overviewLayer = null; next.destroy(); controller = null
    }
  })

</script>

<div class="explorer-overlay" bind:this={overlayElement} class:inactive={!active} aria-hidden={!active} inert={!active}>
  <canvas class="layout-plan-annotations" bind:this={draftingCanvas} aria-hidden="true"></canvas>
  {#if scenes.length > 0 && focused !== null}
    {#if controlsOpen}<div class="layout-tools" bind:this={toolsElement} style:right={`${coverRight + 12}px`} style:top={`${toolsTop}px`}>
      {#snippet cameraNavigation()}
        <CameraControls bind:this={cameraControls} bind:element={cameraElement} {navigation} pitch={cameraReadout.pitch} bearing={cameraReadout.bearing} onnavigation={tool => { if (!suspended) { navigation = tool; controller?.setNavigationTool(tool) } }} ontilt={degrees => { if (!suspended) controller?.tiltBy(degrees) }} onturn={degrees => { if (!suspended) controller?.turnBy(degrees) }} onzoom={delta => { if (!suspended) controller?.zoomBy(delta) }} onfit={fit} onhome={home} />
      {/snippet}
      <Controls bind:this={controls} title={scopeTitle} path={scopePath} {choices} {scopeKey} levels={scopeLevels} layers={focusedId === null ? [] : focused.descriptor.layers ?? []} {collectionLayerChoices} floorGroups={collectionFloorGroups} {mixedSettings} onfloorchange={changeCollectionFloor} oncollectionlayerchange={changeCollectionLayer} view={requestedPhysicalLayoutView(focused)} status={statusText} {suspended} {retryLabel} onretry={retryableLayouts.length > 0 ? retryFailedLayouts : undefined}
          onscope={chooseScope} onviewchange={changeView} onfit={fit} onhome={home} onoverview={focusedId === null ? undefined : () => overview(focused)} onfind={() => { componentsOpen = !componentsOpen; componentScope = null }}
          navigationControls={focused.view.mode === '3d' ? cameraNavigation : undefined} onclose={() => { controlsOpen = false; componentsOpen = false }} />
      {#if componentsOpen}
        <section class="layout-components" aria-label="Find physical equipment"><header><strong>Find equipment</strong><button type="button" aria-label="Close equipment search" onclick={() => componentsOpen = false}>×</button></header>
          <label>Find a component<input type="search" bind:value={filter} /></label>
          <label class="state-layer"><input type="checkbox" bind:checked={showStateWords} /> Ordinary operating-state labels</label>
          {#if componentScope !== null}<p>Subjects associated with {componentScope.label}.</p><button type="button" onclick={() => componentScope = null}>Show all components</button>{/if}
          {#if focusedId !== null && statusSummary !== null}<p>{focusedOwner?.label}: {frozen ? 'last known · ' : ''}{statusSummary.census.total} owner alerts · {statusSummary.unlocatedAlerts} unlocated · {statusSummary.hiddenLocations} affected locations outside the selected scope/floor.</p>{/if}
          {#if pendingBadges > 0}<p>{pendingBadges} location visibility checks pending. Owner alert counts remain complete.</p>{/if}
          {#if pendingFocus}<p role="status">Loading physical locations for {pendingFocus.label}…</p>{/if}
          {#each components.filter(subject => (componentScope === null || componentScope.sceneId !== subject.sceneId || componentScope.subjectIds.includes(subject.elementId)) && `${subject.label} ${subject.elementId} ${subject.owner}`.toLowerCase().includes(filter.toLowerCase())) as subject (`${subject.sceneId}:${subject.elementId}`)}
            <div class="component-row"><span title={`${subject.owner} / ${subject.label}`}><strong>{subject.label}</strong><small>{subject.owner}</small></span><button type="button" disabled={suspended} aria-label={`Focus ${subject.label} in physical layout`} onclick={() => focusComponent(subject.sceneId, subject.elementId, subject.label)}>Focus</button><button type="button" disabled={suspended} aria-label={`Inspect ${subject.label}`} onclick={() => inspect(subject.sceneId, subject.elementId, subject.label, null)}>Quick look</button></div>
          {/each}
        </section>
      {/if}
      {#if focusLocations}
        <section class="layout-components" aria-label="Choose physical occurrence"><header><strong>{focusLocations.label}</strong><button type="button" aria-label="Close physical occurrence choice" onclick={() => focusLocations = null}>×</button></header>
          {#if focusLocations.occurrenceIds.length === 0}<p>No admitted physical placement. The component remains available in its process display.</p>{:else}<p>Choose the physical part or housing to focus.</p>{#each focusLocations.occurrenceIds as occurrenceId (occurrenceId)}<button type="button" onclick={() => { if (focusLocations) focusOccurrence(focusLocations.sceneId, occurrenceId) }}>{controller?.scene(focusLocations.sceneId)?.objects.find(value => value.id === occurrenceId)?.label ?? occurrenceId}</button>{/each}{/if}
        </section>
      {/if}
      {#if floorChoice}<section class="layout-components" aria-label="Choose physical focus floor"><header><strong>{floorChoice.label}</strong><button type="button" aria-label="Close focus floor choice" onclick={() => floorChoice = null}>×</button></header><p>This equipment spans more than one floor. Choose a view.</p><button type="button" onclick={() => { if (floorChoice) focusOccurrence(floorChoice.sceneId, floorChoice.occurrenceId, 'all') }}>Show in 3D context</button>{#each floorChoice.levelIds as levelId (levelId)}<button type="button" onclick={() => { if (floorChoice) focusOccurrence(floorChoice.sceneId, floorChoice.occurrenceId, levelId) }}>{scenes.find(scene => scene.descriptor.id === floorChoice?.sceneId)?.descriptor.levels.find(level => level.id === levelId)?.label ?? levelId}</button>{/each}</section>{/if}
      {#if scopeFloorChoice}<section class="layout-components" aria-label="Choose area floor"><header><strong>{scopeFloorChoice.label}</strong><button type="button" aria-label="Close area floor choice" onclick={() => scopeFloorChoice = null}>×</button></header><p>The current floor does not intersect this area. Choose a floor or show its whole 3D context.</p><button type="button" onclick={() => { if (scopeFloorChoice) chooseScope(scopeFloorChoice.key, 'all') }}>Show whole area in 3D</button>{#each scopeFloorChoice.levelIds as levelId (levelId)}<button type="button" onclick={() => { if (scopeFloorChoice) chooseScope(scopeFloorChoice.key, levelId) }}>{scenes.find(scene => scene.descriptor.id === scopeFloorChoice?.sceneId)?.descriptor.levels.find(level => level.id === levelId)?.label ?? levelId}</button>{/each}</section>{/if}
    </div>{/if}

  {:else if viewportFailure !== null}
    <div class="layout-tools" style:top={`${toolsTop}px`}><p role="alert">{viewportFailure}</p></div>
  {/if}
  {#each badges as badge (`${badge.sceneId}:${badge.occurrenceId}:${badge.elementId}`)}
    <button class="layout-status" type="button" style:left={`${badge.point.x}px`} style:top={`${badge.point.y}px`} style:color={badge.color} title={`${badge.label}: ${badge.word}${badge.alarms > 0 ? ` · ${badge.alarms} alerts` : ''}`} aria-label={`Inspect ${badge.label}: ${badge.word}`} onclick={() => inspect(badge.sceneId, badge.elementId, badge.label, badge.occurrenceId)}><span>{badge.alarms > 0 ? badge.alarms : badge.chip}</span></button>
  {/each}
  {#if hover !== null && !suspended && inspected === null}<div bind:this={hoverLabelElement} class="layout-hover-label" style:left={`${hoverPoint.x}px`} style:top={`${hoverPoint.y}px`}><strong>{hover.label}</strong>{#each hoverContext as context}<small><b>{context.label}</b> {context.value}</small>{/each}<small>Click to inspect · pause here to open</small></div>{/if}
  {#if inspectionSource !== null && inspected !== null && !suspended}<div class="layout-inspection" style:left={`${cardPoint.x}px`} style:top={`${cardPoint.y}px`} style:width={`${inspectionWidth}px`} style:height={`${allocatedInspectionHeight}px`}>{#key inspectionSource}<iframe bind:this={inspectionFrame} title={`Inspect ${inspected.label}`} src={inspectionSource} allow="camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'" referrerpolicy="same-origin"></iframe>{/key}</div>{/if}
</div>

<style>
  .explorer-overlay { position: absolute; inset: 0; pointer-events: none; container-type: inline-size; }.explorer-overlay.inactive { visibility: hidden; }
  .layout-plan-annotations { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; font-size: 12px; }
  .layout-tools { position: absolute; left: 12px; z-index: 5; max-height: calc(100% - 24px); overflow-y: auto; overscroll-behavior: contain; pointer-events: none; color: var(--text); }.layout-tools > :global(*) { pointer-events: auto; }
  button, input { min-height: 44px; box-sizing: border-box; font: inherit; }button { color: var(--text); background: var(--panel); border: 1px solid var(--border); border-radius: 7px; padding: 7px 10px; cursor: pointer; }button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .layout-components { display: grid; gap: 6px; width: min(440px, 100%); margin-left: auto; max-height: min(52dvh, 560px); overflow: auto; box-sizing: border-box; margin-top: 6px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); font-size: 12px; }.layout-components header { display: flex; justify-content: space-between; align-items: center; gap: 8px; }.layout-components header button { min-width: 44px; padding: 0; font-size: 20px; }.layout-components > label { display: grid; gap: 4px; }.layout-components p { margin: 3px 0; color: var(--muted); line-height: 1.5; font-size: 11px; }.layout-components input[type="search"] { min-width: 0; width: 100%; color: var(--text); background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 8px; }.layout-components .state-layer { display: flex; align-items: center; gap: 8px; }.state-layer input { min-height: 18px; width: 18px; accent-color: var(--accent); }
  .component-row { display: flex; align-items: center; gap: 5px; border-top: 1px solid var(--border); padding-top: 4px; }.component-row > span { flex: 1; min-width: 0; display: grid; gap: 3px; }.component-row strong, .component-row small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.component-row small { color: var(--muted); font-size: 10px; }.component-row button { flex: none; padding: 6px; }
  .layout-status { position: absolute; z-index: 4; pointer-events: auto; min-width: 44px; min-height: 44px; font-size: 11px; transform: translate(-50%, -50%); padding: 0; background: transparent; border: 0; }.layout-status span { display: inline-block; max-width: 96px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; padding: 2px 5px; border: 1px solid var(--border); border-radius: 4px; background: var(--panel); }
  .layout-hover-label { position: absolute; z-index: 4; pointer-events: none; box-sizing: border-box; width: max-content; max-width: min(300px, calc(100% - 16px)); max-height: calc(100% - 16px); overflow: hidden; padding: 7px 10px; border: 1px solid var(--accent); border-radius: 6px; background: var(--panel); color: var(--text); font-size: 11px; box-shadow: var(--shadow-floating); }.layout-hover-label strong,.layout-hover-label small { display: block; overflow-wrap: anywhere; }.layout-hover-label small { color: var(--muted); margin-top: 3px; }
  .layout-inspection { position: absolute; z-index: 8; width: min(360px, calc(100% - 16px)); box-sizing: border-box; pointer-events: auto; background: var(--panel); border: 1px solid var(--border); border-radius: 9px; overflow: hidden; box-shadow: var(--shadow-floating); }.layout-inspection iframe { display: block; width: 100%; height: 100%; border: 0; }
  @container (max-width: 440px) { .layout-tools { left: 8px; right: 8px !important; }.component-row { flex-wrap: wrap; }.component-row > span { flex-basis: 100%; }.component-row button { flex: 1; } }
</style>
