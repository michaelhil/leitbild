<script lang="ts">
  import { tick, untrack } from 'svelte'
  import { embeddedViewFragment, embeddedViewPath, type EmbeddedViewListing } from '@leitbild/contracts'
  import type { Map as MapLibreMap } from 'maplibre-gl'
  import type { OperationalObject, SimulationRunId } from '../../core/model/index.ts'
  import { objectIdSchema } from '../../core/model/index.ts'
  import type { PackObjectPresentation } from '../../core/packs/protocol.ts'
  import { createPhysicalSceneController, type PhysicalSceneController } from '../map/physical-scene/controller.ts'
  import { createPhysicalCanvasController } from '../map/physical-scene/canvas-controller.ts'
  import { createPhysicalAnnotationScheduler } from './annotation-scheduler.ts'
  import { explorerEntryTarget, explorerGroupKey, explorerLayoutKey, explorerScopeChoices, levelForPhysicalFocus, levelForScopeFocus, physicalOccurrenceInScope, physicalOccurrenceOnLevel, type ExplorerScopeChoice, type PhysicalExplorerTarget } from './explorer-model.ts'
  import { physicalExplorerFitPadding, type ExplorerViewportPadding } from './explorer-viewport.ts'
  import { physicalExplorerKeyboardRoute, physicalExplorerNeedsLive } from './explorer-interaction.ts'
  import { createPhysicalSceneOverview } from '../map/physical-scene/overview.ts'
  import type { PhysicalSceneHit, PhysicalScenePresentation, PhysicalSceneView } from '../map/physical-scene/types.ts'
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
  import { physicalLayoutSources, type PhysicalLayoutBinding, type PhysicalLayoutMapInteraction } from './sources.ts'
  let { map = null, host = 'map', active = true, initialTarget = { sceneId: null }, objects, bindings, hiddenCategoryIds, presentationFor, runId, perspectiveEpoch, suspended, theme, clearTop = 0, reservedPadding = { top: 0, right: 0, bottom: 0, left: 0 }, onDetailedOwners = () => {}, onoverview, onopen, onerror, onconnect = () => {}, onbrowser, onback }: {
    map?: MapLibreMap | null
    host?: 'map' | 'browser'
    active?: boolean
    initialTarget?: PhysicalExplorerTarget
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
    onbrowser?: ((target: PhysicalExplorerTarget) => void) | undefined
    onback?: (() => void) | undefined
  } = $props()

  let scenes = $state.raw<ReadonlyArray<PhysicalScenePresentation>>([])
  let focusedId = $state<string | null>(untrack(() => initialTarget.sceneId))
  let focusedScopeId = $state<string | null>(untrack(() => initialTarget.scopeId ?? null))
  let focusedGroupId = $state<string | null>(untrack(() => initialTarget.groupId ?? null))
  let navigation = $state<'pan' | 'orbit'>('pan')
  let canvas = $state<HTMLCanvasElement | null>(null)
  let controls = $state<{ dismiss: () => boolean } | null>(null)
  let cameraControls = $state<{ dismiss: () => boolean } | null>(null)
  let cameraElement = $state<HTMLElement | null>(null)
  let overlayElement = $state<HTMLElement | null>(null)
  let controller = $state.raw<PhysicalSceneController | null>(null)
  let viewportFailure = $state<string | null>(null)
  let controlsOpen = $state(true)
  let componentsOpen = $state(false)
  let componentScope = $state<{ readonly sceneId: string; readonly label: string; readonly subjectIds: ReadonlyArray<string> } | null>(null)
  let filter = $state('')
  let hover = $state<PhysicalSceneHit | null>(null)
  let hoverDismissTimer: ReturnType<typeof setTimeout> | null = null
  const retainHover = (): void => { if (hoverDismissTimer !== null) clearTimeout(hoverDismissTimer); hoverDismissTimer = null }
  const dismissHoverSoon = (): void => { retainHover(); hoverDismissTimer = setTimeout(() => { hoverDismissTimer = null; hover = null }, 200) }
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
  const initializedBrowserSources = new Set<string>()
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
  const fitPadding = () => {
    const padding = reservedPadding
    const surface = controller?.surface.element.getBoundingClientRect(), tools = toolsElement?.getBoundingClientRect(), camera = cameraElement?.getBoundingClientRect()
    if (!surface) return padding
    const covers = [tools, camera].filter((cover): cover is DOMRect => cover !== undefined).map(cover => ({ x: cover.left - surface.left, y: cover.top - surface.top, width: cover.width, height: cover.height }))
    if (inspected !== null) covers.push({ ...cardPoint, width: inspectionWidth, height: allocatedInspectionHeight })
    return physicalExplorerFitPadding(surface, { ...padding, top: Math.max(padding.top, clearTop > surface.top ? clearTop - surface.top + 8 : 0) }, covers)
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
    else { componentScope = { sceneId: hit.sceneId, label: hit.label, subjectIds: hit.subjectIds }; filter = ''; componentsOpen = true }
  }
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
  $effect(() => {
    const current = controller
    if (host !== 'browser' || !current) return
    const mode = scenes.find(scene => initializedBrowserSources.has(scene.descriptor.id))?.view.mode ?? initialTarget.view?.mode ?? '3d'
    for (const scene of scenes) if (!initializedBrowserSources.has(scene.descriptor.id)) {
      initializedBrowserSources.add(scene.descriptor.id)
      const view = scene.descriptor.id === initialTarget.sceneId && initialTarget.view !== undefined ? initialTarget.view : { ...scene.view, mode, levelId: mode === '3d' ? 'all' : scene.view.levelId }
      untrack(() => current.setView(scene.descriptor.id, view))
    }
  })
  $effect(() => { void theme; const element = controller?.surface.element; if (!element) return; const palette = untrack(() => physicalLayoutPalette(element)); untrack(() => { controller?.setPalette(palette); overviewLayer?.setPalette(palette) }) })
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
      if (!physicalExplorerNeedsLive({ active, documentVisible, suspended, ready: scene.status === 'ready', statusLayer: scene.view.live, sceneId: scene.descriptor.id, inspectedSceneId: inspected?.sceneId ?? null })) continue
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

  $effect(() => { controller?.setActive(active && documentVisible); if (!active || suspended || !documentVisible) { focusGeneration++; pendingFocus = null; pendingCameraFocus = null; scopeFloorChoice = null; controller?.cancelCamera(); controller?.setNavigationTool('pan'); navigation = 'pan' } })

  const scopedOccurrences = $derived(scenes.filter(scene => scene.status === 'ready').flatMap(scene => (controller?.scene(scene.descriptor.id)?.objects ?? []).filter(occurrence =>
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
  type Badge = { readonly sceneId: string; readonly elementId: string; readonly label: string; readonly occurrenceId: string; readonly point: { readonly x: number; readonly y: number }; readonly width: number; readonly color: string; readonly word: string; readonly chip: string; readonly alarms: number; readonly rank: number }
  let testedBadges = $state.raw<ReadonlyArray<Badge>>([])
  let pendingBadges = $state(0)
  let annotationScheduler = $state.raw<ReturnType<typeof createPhysicalAnnotationScheduler<Badge>> | null>(null)
  const proposedBadges = $derived.by(() => {
    void wallNow; void screenRevision
    if (!active || suspended || !documentVisible) return []
    const proposals = scenes.filter(scene => scene.status === 'ready' && scene.view.live).flatMap(scene => {
      const snapshot = snapshots.get(scene.descriptor.id)
      const reading = snapshot?.latest
      if (reading === undefined || reading === null) return []
      const stale = layoutLiveFrozen(snapshot!, wallNow)
      return reading.subjects.flatMap(subject => {
        const status = statusesFor(reading, stale).get(subject.elementId)!
        if (!stale && status.quality === 'good' && status.census.total === 0 && !showStateWords) return []
        return (scopedBySubject.get(scene.descriptor.id)?.get(subject.elementId) ?? []).flatMap(occurrence => {
          const point = controller?.cheapProject(scene.descriptor.id, occurrence.id)
          if (!point?.visible) return []
          const color = physicalSubjectStyle(status, theme === 'dark' ? 'dusk' : 'day').color
          const chip = stale || status.quality !== 'good' ? '?' : status.word ?? '', alarms = status.active + status.returned
          const text = alarms > 0 ? String(alarms) : chip
          // The chip uses 11px text, 10px horizontal padding and a 2px border.
          const width = Math.max(44, Math.min(96, badgeMeasure?.measureText(text).width ?? 96) + 12)
          return [{ sceneId: scene.descriptor.id, elementId: subject.elementId, label: subject.label, occurrenceId: occurrence.id, point,
            width,
            color: color === null ? 'var(--muted)' : `rgb(${color.map(channel => Math.round(channel * 255)).join(' ')})`,
            word: stale ? 'Not live' : status.quality !== 'good' ? `${status.quality} quality` : status.word ?? 'Live',
            chip, alarms, rank: priorityRank(status.priority) }]
        })
      })
    })
    return proposals
  })
  $effect(() => {
    annotationScheduler?.setActive(active && !suspended && documentVisible)
    const generation = JSON.stringify([screenRevision, scenes.map(scene => [scene.descriptor.revision, scene.view]), focusedId, focusedScopeId, focusedGroupId])
    const candidates = sparseLayoutBadges(proposedBadges, size, [toolsBox, cameraBox].filter((box): box is NonNullable<typeof box> => box !== null))
    annotationScheduler?.update(generation, candidates.map(value => ({ key: `${value.sceneId}:${value.occurrenceId}:${value.elementId}`, priority: value.rank, value })))
  })
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
  const statusText = $derived(focusedId === null ? `${scenes.filter(scene => scene.status === 'ready').length} layouts ready · ${scenes.filter(scene => scene.status === 'loading').length} loading · ${scenes.filter(scene => scene.status === 'unavailable').length} unavailable · owner-qualified alarms remain in Run`
    : focused?.status === 'loading' ? 'Loading this physical layout…'
    : focused?.status === 'distant' ? 'Explore on map to load this physical layout'
    : focused?.status === 'hidden' ? 'Physical detail hidden by view settings'
    : focused?.status === 'unavailable' ? focused.reason ?? 'Layout unavailable'
    : latest?.failure ?? (latest?.phase === 'inactive' ? 'Run not loaded; layout is not live' : latest?.phase === 'missing' ? 'Run missing' : latest?.latest === null || latest === null ? 'Waiting for live owner status'
      : frozen ? `Not live · ${latest.phase === 'suspended' ? 'updates suspended' : latest.phase} · last acquired ${Math.max(0, Math.floor((wallNow - (latest.stamp?.receivedWallMs ?? wallNow)) / 1000))} s ago` : `${latest.latest.sample.at.paused ? 'Paused · fresh' : 'Live'} · ${latest.latest.subjects.length} modelled subjects · ${statusSummary?.census.total ?? 0} owner alerts`))
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
      focusedId = sceneId; focusedScopeId = choice.scopeId ?? null; focusedGroupId = scene.descriptor.group?.id ?? null
      controller?.selectScope(sceneId, choice.scopeId)
      if (scene.view.levelId !== levelId) controller?.setView(sceneId, { ...scene.view, mode: levelId === 'all' ? '3d' : scene.view.mode, levelId })
      void afterPanels(() => controller?.focus(sceneId, { scopeId: choice.scopeId, levelId, preservePose: true }))
    }
    else { focusedId = null; focusedScopeId = null; focusedGroupId = choice?.groupId ?? null; void afterPanels(() => controller?.fitAll(choice?.sceneIds)) }
  }
  const changeView = (next: PhysicalSceneView): void => {
    if (suspended) return
    const scene = focused
    if (!scene) return
    pendingCameraFocus = null
    closeInspection(); hover = null
    if (next.mode === '2d') { navigation = 'pan'; controller?.setNavigationTool('pan') }
    if (scene.view.mode === '2d') rememberedPlanFloor.set(scene.descriptor.id, scene.view.levelId)
    if (next.mode === '2d' && scene.view.levelId === 'all') next = { ...next, levelId: rememberedPlanFloor.get(scene.descriptor.id) ?? scopeLevels[0]?.id ?? scene.descriptor.levels[0]!.id }
    controller?.setView(scene.descriptor.id, next)
  }
  const fit = (): void => { if (suspended) return; componentsOpen = false; pendingFocus = null; pendingCameraFocus = null; const sceneId = focusedId, scopeId = focusedScopeId, ids = groups.get(focusedGroupId ?? '')?.sceneIds; void afterPanels(() => { if (sceneId === null) controller?.fitAll(ids); else controller?.focus(sceneId, { scopeId: scopeId ?? undefined, preservePose: true }) }) }
  const home = (): void => { if (suspended) return; componentsOpen = false; pendingFocus = null; pendingCameraFocus = null; const sceneId = focusedId, scopeId = focusedScopeId, ids = groups.get(focusedGroupId ?? '')?.sceneIds; void afterPanels(() => { if (sceneId === null) controller?.fitAll(ids); else controller?.home(sceneId, scopeId ?? undefined) }) }
  const focusOccurrence = (sceneId: string, occurrenceId: string, chosenLevel?: string): void => {
    if (suspended) return
    const scene = scenes.find(value => value.descriptor.id === sceneId), occurrence = controller?.scene(sceneId)?.objects.find(value => value.id === occurrenceId)
    if (!scene || !occurrence) return
    const level = chosenLevel ?? levelForPhysicalFocus(occurrence, scene.view)
    if (level === null) { floorChoice = { sceneId, occurrenceId, label: occurrence.label, levelIds: occurrence.levelIds ?? [occurrence.levelId] }; return }
    focusedId = sceneId; focusedScopeId = null; focusedGroupId = scene.descriptor.group?.id ?? null; closeInspection(); floorChoice = null; focusLocations = null; componentsOpen = false
    const mode = level === 'all' ? '3d' : scene.view.mode
    pendingCameraFocus = { sceneId, occurrenceId, levelId: level, mode }
    if (scene.status !== 'ready') controller?.focus(sceneId, { preservePose: true })
    else controller?.selectScope(sceneId)
    controller?.setView(sceneId, { ...scene.view, mode, levelId: level })
  }
  const focusComponent = (sceneId: string, subjectId: string, label: string): void => {
    const scene = controller?.scene(sceneId)
    if (!scene) { pendingFocus = { sceneId, subjectId, label }; controller?.focus(sceneId, { preservePose: true }); return }
    const locations = scene.objects.filter(value => value.subjectIds.includes(subjectId))
    if (locations.length === 1) focusOccurrence(sceneId, locations[0]!.id)
    else focusLocations = { sceneId, subjectId, label, occurrenceIds: locations.map(value => value.id) }
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
    const element = host === 'map' ? map?.getContainer() : canvas
    if (!element) { onerror('The physical viewport has no mounted surface'); return }
    badgeMeasure = document.createElement('canvas').getContext('2d')
    if (badgeMeasure) badgeMeasure.font = `11px ${getComputedStyle(element).fontFamily}`
    const options = { palette: physicalLayoutPalette(element), fitPadding, onChange: (next: ReadonlyArray<PhysicalScenePresentation>) => { scenes = next; overlayDirty = true }, reportError: (error: Error) => onerror(`Physical layout: ${error.message}`) }
    let next: PhysicalSceneController
    try {
      next = host === 'map' && map !== null
        ? createPhysicalSceneController({ ...options, map, beforeId: () => physicalSceneLayerAnchorId(map.getStyle()) })
        : createPhysicalCanvasController({ ...options, canvas: canvas! })
    } catch (error) {
      viewportFailure = error instanceof Error ? error.message : String(error)
      onerror(`Physical viewport unavailable: ${viewportFailure}`)
      return
    }
    controller = next
    if (host === 'browser') next.surface.element.focus({ preventScroll: true })
    size = next.surface.getSize()
    if (map !== null && host === 'map') overviewLayer = createPhysicalSceneOverview({ map, palette: options.palette, beforeId: () => physicalSceneLayerAnchorId(map.getStyle()), reportError: error => onerror(`Physical overview: ${error.message}`) })
    annotationScheduler = createPhysicalAnnotationScheduler<Badge>({ test: value => next.visibleAt(value.sceneId, value.occurrenceId, value.point), onChange: value => { testedBadges = value.visible; pendingBadges = value.pending } })
    let hoverTimer: ReturnType<typeof setTimeout> | null = null
    let pressed: { x: number; y: number; pointerId: number; moved: boolean } | null = null
    let initialFit = false
    const changed = (): void => {
      const pose = next.cameraPose()
      const signature = JSON.stringify([pose.pitch, pose.bearing, pose.zoom, pose.center])
      if (!overlayDirty && cameraSignature === signature) return
      cameraSignature = signature; overlayDirty = false
      cameraReadout = { pitch: pose.pitch, bearing: pose.bearing }
      size = next.surface.getSize(); screenRevision += 1
      if (host === 'browser' && !initialFit && scenes.length > 0) {
        initialFit = true
        if (initialTarget.sceneId === null) next.fitAll(groups.get(initialTarget.groupId ?? '')?.sceneIds); else next.focus(initialTarget.sceneId, { scopeId: initialTarget.scopeId, preservePose: false })
      }
    }
    const pointAt = (event: PointerEvent | MouseEvent) => { const box = next.surface.element.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top } }
    const leave = (): void => { retainHover(); if (hoverTimer !== null) clearTimeout(hoverTimer); hoverTimer = null; hover = null }
    const moving = (): void => { leave(); overlayDirty = true }
    const move = (event: PointerEvent): void => {
      retainHover()
      if (pressed?.pointerId === event.pointerId) {
        const point = pointAt(event)
        if (Math.hypot(point.x - pressed.x, point.y - pressed.y) >= 4) pressed.moved = true
      }
      if (!active || suspended || event.buttons !== 0 || inspected !== null) { leave(); return }
      if (hoverTimer !== null) clearTimeout(hoverTimer)
      const point = pointAt(event)
      hoverTimer = setTimeout(() => { hoverTimer = null; const hit = next.pick(point); hover = hit !== null && hit.subjectIds.length > 0 ? hit : null }, 120)
    }
    const activate = (point: { x: number; y: number }): boolean => {
      if (!active || suspended) return false
      if (inspected !== null) { closeInspection(true); return true }
      const hit = next.pick(point), sceneId = hit?.sceneId ?? overviewLayer?.sceneAt(point)
      const scene = scenes.find(value => value.descriptor.id === sceneId)
      if (!scene) return false
      overview(scene); return true
    }
    const down = (event: PointerEvent): void => { if (active && !suspended && event.button === 0) pressed = { ...pointAt(event), pointerId: event.pointerId, moved: false } }
    const up = (event: PointerEvent): void => {
      if (pressed?.pointerId !== event.pointerId) return
      const before = pressed; pressed = null; const point = pointAt(event)
      if (!before.moved && Math.hypot(point.x - before.x, point.y - before.y) < 4 && host === 'browser') activate(point)
    }
    const cancel = (): void => { pressed = null; leave() }
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
      else if (host === 'browser') onback?.()
      else return
      next.cancelCamera(); event.preventDefault(); event.stopPropagation()
    }
    const clock = setInterval(() => { wallNow = Date.now() }, 250)
    const disposers = [next.surface.on('render', changed), next.surface.on('resize', () => { overlayDirty = true; changed() }), next.surface.on('movestart', moving)]
    const surface = next.surface.element
    surface.addEventListener('pointermove', move); surface.addEventListener('pointerdown', down); surface.addEventListener('pointerup', up); surface.addEventListener('pointercancel', cancel); surface.addEventListener('pointerleave', dismissHoverSoon)
    document.addEventListener('visibilitychange', visibility); window.addEventListener('message', receive); window.addEventListener('keydown', key)
    onconnect({ dismiss: () => { closeInspection(); leave() }, activate })
    return () => {
      onconnect(null); onDetailedOwners([]); leave(); clearInterval(clock); disposers.forEach(dispose => dispose())
      surface.removeEventListener('pointermove', move); surface.removeEventListener('pointerdown', down); surface.removeEventListener('pointerup', up); surface.removeEventListener('pointercancel', cancel); surface.removeEventListener('pointerleave', dismissHoverSoon)
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('message', receive); window.removeEventListener('keydown', key)
      for (const entry of sessions.values()) entry.session.close()
      sessions.clear(); annotationScheduler?.destroy(); annotationScheduler = null; overviewLayer?.destroy(); overviewLayer = null; next.destroy(); controller = null
    }
  })

</script>

{#if host === 'browser'}<canvas class="layout-canvas" bind:this={canvas} tabindex="0" aria-label="Interactive physical layout browser"></canvas>{/if}
<div class="explorer-overlay" bind:this={overlayElement} class:inactive={!active} aria-hidden={!active} inert={!active}>
  {#if scenes.length > 0 && focused !== null}
    <div class="layout-tools" bind:this={toolsElement} style:right={`${coverRight + 12}px`} style:top={`${toolsTop}px`}>
      {#if controlsOpen}
        <Controls bind:this={controls} title={scopeTitle} path={scopePath} {choices} {scopeKey} levels={scopeLevels} layers={focused.descriptor.layers ?? []} view={focused.view} status={statusText} {host} {suspended}
          onscope={chooseScope} onviewchange={changeView} onfit={fit} onoverview={focusedId === null ? undefined : () => overview(focused)} onfind={() => { componentsOpen = !componentsOpen; componentScope = null }}
          onbrowser={onbrowser === undefined ? undefined : target => { if (!suspended) onbrowser?.(target) }} {onback} onclose={() => { controlsOpen = false; componentsOpen = false }} />
      {:else}
        <div class="entry-actions"><button type="button" onclick={() => controlsOpen = true}>Layout controls</button>{#if host === 'map' && onbrowser}<button type="button" disabled={suspended} onclick={() => onbrowser?.(explorerEntryTarget(choices.find(choice => choice.key === scopeKey), focused.view))}>Open layout browser</button>{:else if host === 'browser'}<button type="button" onclick={onback}>Back to map</button>{/if}</div>
      {/if}
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
    </div>
    {#if controlsOpen && focused.view.mode === '3d'}<CameraControls bind:this={cameraControls} bind:element={cameraElement} {navigation} pitch={cameraReadout.pitch} bearing={cameraReadout.bearing} onnavigation={tool => { if (!suspended) { navigation = tool; controller?.setNavigationTool(tool) } }} ontilt={degrees => { if (!suspended) controller?.tiltBy(degrees) }} onturn={degrees => { if (!suspended) controller?.turnBy(degrees) }} onzoom={delta => { if (!suspended) controller?.zoomBy(delta) }} onfit={fit} onhome={home} />{/if}
  {:else if host === 'browser'}
    <div class="layout-tools empty-browser" style:top={`${toolsTop}px`}><button type="button" onclick={onback}>Back to map</button><p role={viewportFailure === null ? 'status' : 'alert'}>{viewportFailure ?? 'No physical layouts are available in the current Run and visible categories.'}</p></div>
  {/if}
  {#each badges as badge (`${badge.sceneId}:${badge.occurrenceId}:${badge.elementId}`)}
    <button class="layout-status" type="button" style:left={`${badge.point.x}px`} style:top={`${badge.point.y}px`} style:color={badge.color} title={`${badge.label}: ${badge.word}${badge.alarms > 0 ? ` · ${badge.alarms} alerts` : ''}`} aria-label={`Inspect ${badge.label}: ${badge.word}`} onclick={() => inspect(badge.sceneId, badge.elementId, badge.label, badge.occurrenceId)}><span>{badge.alarms > 0 ? badge.alarms : badge.chip}</span></button>
  {/each}
  {#if hover !== null && !suspended && inspected === null}<button class="layout-quick-look" type="button" style:left={`${Math.max(8, Math.min(size.width - Math.min(260, size.width - 16) - 8, hover.screen.x + 16))}px`} style:top={`${Math.max(8, hover.screen.y - 24)}px`} onpointerenter={retainHover} onpointerleave={dismissHoverSoon} onfocus={retainHover} onblur={dismissHoverSoon} onclick={() => { if (hover !== null) inspectHit(hover) }}>⌕ Quick look · {hover.label}</button>{/if}
  {#if inspectionSource !== null && inspected !== null && !suspended}<div class="layout-inspection" style:left={`${cardPoint.x}px`} style:top={`${cardPoint.y}px`} style:width={`${inspectionWidth}px`} style:height={`${allocatedInspectionHeight}px`}>{#key inspectionSource}<iframe bind:this={inspectionFrame} title={`Inspect ${inspected.label}`} src={inspectionSource} allow="camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'" referrerpolicy="same-origin"></iframe>{/key}</div>{/if}
</div>

<style>
  .layout-canvas { position: absolute; inset: 0; display: block; width: 100%; height: 100%; touch-action: none; outline-offset: -3px; }
  .explorer-overlay { position: absolute; inset: 0; pointer-events: none; container-type: inline-size; }.explorer-overlay.inactive { visibility: hidden; }
  .layout-tools { position: absolute; z-index: 5; width: min(380px, calc(100% - 24px)); max-height: calc(100% - 24px); overflow-y: auto; overscroll-behavior: contain; pointer-events: auto; color: var(--text); }
  .entry-actions { display: flex; gap: 6px; }.entry-actions button { flex: 1; }
  button, input { min-height: 44px; box-sizing: border-box; font: inherit; }button { color: var(--text); background: var(--panel); border: 1px solid var(--border); border-radius: 7px; padding: 7px 10px; cursor: pointer; }button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .layout-components { display: grid; gap: 6px; max-height: min(52dvh, 560px); overflow: auto; box-sizing: border-box; margin-top: 6px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); font-size: 12px; }.layout-components header { display: flex; justify-content: space-between; align-items: center; gap: 8px; }.layout-components header button { min-width: 44px; padding: 0; font-size: 20px; }.layout-components > label { display: grid; gap: 4px; }.layout-components p { margin: 3px 0; color: var(--muted); line-height: 1.5; font-size: 11px; }.layout-components input[type="search"] { min-width: 0; width: 100%; color: var(--text); background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 8px; }.layout-components .state-layer { display: flex; align-items: center; gap: 8px; }.state-layer input { min-height: 18px; width: 18px; accent-color: var(--accent); }
  .component-row { display: flex; align-items: center; gap: 5px; border-top: 1px solid var(--border); padding-top: 4px; }.component-row > span { flex: 1; min-width: 0; display: grid; gap: 3px; }.component-row strong, .component-row small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.component-row small { color: var(--muted); font-size: 10px; }.component-row button { flex: none; padding: 6px; }
  .layout-status, .layout-quick-look { position: absolute; z-index: 4; pointer-events: auto; min-width: 44px; min-height: 44px; font-size: 11px; }.layout-status { transform: translate(-50%, -50%); padding: 0; background: transparent; border: 0; }.layout-status span { display: inline-block; max-width: 96px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; padding: 2px 5px; border: 1px solid var(--border); border-radius: 4px; background: var(--panel); }.layout-quick-look { max-width: min(260px, calc(100% - 16px)); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .layout-inspection { position: absolute; z-index: 8; width: min(360px, calc(100% - 16px)); box-sizing: border-box; pointer-events: auto; background: var(--panel); border: 1px solid var(--border); border-radius: 9px; overflow: hidden; box-shadow: var(--shadow-floating); }.layout-inspection iframe { display: block; width: 100%; height: 100%; border: 0; }
  @container (max-width: 440px) { .layout-tools { right: 8px !important; width: calc(100% - 16px); }.component-row { flex-wrap: wrap; }.component-row > span { flex-basis: 100%; }.component-row button { flex: 1; } }
</style>
