<script lang="ts">
  import { untrack } from 'svelte'
  import { embeddedViewFragment, embeddedViewPath, type EmbeddedViewListing } from '@leitbild/contracts'
  import type { Map as MapLibreMap } from 'maplibre-gl'
  import type { OperationalObject, SimulationRunId } from '../../core/model/index.ts'
  import { objectIdSchema } from '../../core/model/index.ts'
  import type { PackObjectPresentation } from '../../core/packs/protocol.ts'
  import { createPhysicalSceneController } from '../map/physical-scene/controller.ts'
  import { createPhysicalSceneOverview } from '../map/physical-scene/overview.ts'
  import type { PhysicalSceneHit, PhysicalScenePresentation, PhysicalSceneView } from '../map/physical-scene/types.ts'
  import { physicalSceneLayerAnchorId } from '../map/physical-scene/order.ts'
  import { activeWorkspaceId } from '../workspace-context.ts'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import { createEmbeddedFrameHost } from '../process-display/embedded-frame-host.ts'
  import Controls from './Controls.svelte'
  import { createLayoutLiveSession, layoutLiveFrozen, layoutLiveRoutes, type LayoutLiveSnapshot } from './client.ts'
  import { layoutInspectionEnvelope, layoutInspectionMessageSchema } from './inspection.ts'
  import { physicalSubjectStatus, physicalSubjectStyle, physicalLayoutStatusSummary } from './status.ts'
  import { priorityRank } from '../../features/displays/alerts/rows.ts'
  import { sparseLayoutBadges } from './badges.ts'
  import { physicalLayoutPalette } from './palette.ts'
  import { physicalLayoutSources, type PhysicalLayoutBinding, type PhysicalLayoutMapInteraction } from './sources.ts'
  let { map, objects, bindings, hiddenCategoryIds, presentationFor, runId, perspectiveEpoch, suspended, theme, clearTop, onDetailedOwners, onoverview, onopen, onerror, onconnect }: {
    map: MapLibreMap
    objects: ReadonlyArray<OperationalObject>
    bindings: ReadonlyArray<PhysicalLayoutBinding>
    hiddenCategoryIds: ReadonlyArray<string>
    presentationFor: (object: OperationalObject) => PackObjectPresentation
    runId: SimulationRunId
    perspectiveEpoch: number
    suspended: boolean
    theme: 'light' | 'dark'
    clearTop: number
    onDetailedOwners: (ids: ReadonlyArray<string>) => void
    onoverview: (object: OperationalObject) => void
    onopen: (listing: EmbeddedViewListing) => void
    onerror: (message: string) => void
    onconnect: (interaction: PhysicalLayoutMapInteraction | null) => void
  } = $props()

  let scenes = $state.raw<ReadonlyArray<PhysicalScenePresentation>>([])
  let focusedId = $state<string | null>(null)
  let controlsOpen = $state(true)
  let componentsOpen = $state(false)
  let filter = $state('')
  let hover = $state<PhysicalSceneHit | null>(null)
  let inspected = $state<{ readonly sceneId: string; readonly occurrenceId: string | null; readonly elementId: string; readonly label: string } | null>(null)
  let inspectionFrame = $state<HTMLIFrameElement | null>(null)
  let inspectionHeight = $state(400)
  let toolsElement = $state<HTMLElement | null>(null)
  let toolsBox = $state<{ readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null>(null)
  let snapshots = $state.raw<ReadonlyMap<string, LayoutLiveSnapshot>>(new Map())
  let wallNow = $state(Date.now())
  let documentVisible = $state(!document.hidden)
  let screenRevision = $state(0)
  let size = $state(untrack(() => ({ width: map.getContainer().clientWidth, height: map.getContainer().clientHeight })))
  const sessions = new Map<string, { readonly key: string; readonly session: ReturnType<typeof createLayoutLiveSession> }>()
  let overviewLayer = $state.raw<ReturnType<typeof createPhysicalSceneOverview> | null>(null)
  const controller = untrack(() => createPhysicalSceneController({
    map, palette: physicalLayoutPalette(map.getContainer()),
    beforeId: () => physicalSceneLayerAnchorId(map.getStyle()),
    fitPadding: () => {
      const padding = map.getPadding()
      const controlsRight = controlsOpen && size.width > 850 ? toolsBox === null ? 450 : size.width - toolsBox.x + 24 : 24
      return { top: Math.max((padding.top ?? 0) + 70, clearTop - map.getContainer().getBoundingClientRect().top + 30), bottom: (padding.bottom ?? 0) + 30, left: (padding.left ?? 0) + 24, right: Math.max((padding.right ?? 0) + 24, controlsRight) }
    },
    onChange: next => { scenes = next },
    reportError: error => onerror(`Physical layout: ${error.message}`),
  }))
  const focused = $derived(scenes.find(scene => scene.descriptor.id === focusedId) ?? scenes.find(scene => scene.status === 'ready') ?? scenes[0] ?? null)
  const focusedOwner = $derived(objects.find(object => object.id === focused?.descriptor.targetObjectId) ?? null)
  const focusedLabel = $derived(objects.find(object => object.id === focused?.descriptor.id)?.label ?? focusedOwner?.label ?? 'Physical layout')
  const latest = $derived(focused === null ? null : snapshots.get(focused.descriptor.id) ?? null)
  const frozen = $derived(latest === null || layoutLiveFrozen(latest, wallNow))
  const components = $derived(focused === null ? [] : focused.descriptor.subjectIds.map(id => ({
    elementId: id, label: latest?.latest?.subjects.find(subject => subject.elementId === id)?.label
      ?? controller.scene(focused.descriptor.id)?.objects.find(object => object.subjectIds.includes(id))?.label ?? id,
  })))
  const activeInspection = $derived(scenes.find(scene => scene.descriptor.id === inspected?.sceneId) ?? null)
  const inspectedOwner = $derived(objects.find(object => object.id === activeInspection?.descriptor.targetObjectId) ?? null)
  const inspectionSource = $derived.by(() => {
    if (inspected === null || activeInspection === null || inspectedOwner === null) return null
    const envelope = layoutInspectionEnvelope({ workspaceId: activeWorkspaceId(), runId, state: {
      layoutObjectId: objectIdSchema.parse(activeInspection.descriptor.id), revision: activeInspection.descriptor.revision, objectId: inspectedOwner.id,
      packId: inspectedOwner.packId, modelDigest: activeInspection.descriptor.modelDigest, elementId: inspected.elementId, label: inspected.label,
    } })
    return `${embeddedViewPath(envelope)}${embeddedViewFragment(envelope)}`
  })
  const closeInspection = (returnFocus = false): void => {
    inspected = null
    if (returnFocus) map.getCanvas().focus({ preventScroll: true })
  }
  const overview = (scene: PhysicalScenePresentation): void => {
    focusedId = scene.descriptor.id
    closeInspection(); hover = null
    const owner = objects.find(object => object.id === scene.descriptor.targetObjectId)
    if (owner !== undefined) onoverview(owner)
  }
  const inspect = (sceneId: string, elementId: string, label: string, occurrenceId: string | null): void => {
    if (suspended) return
    focusedId = sceneId
    inspected = { sceneId, elementId, label, occurrenceId }
    hover = null
    inspectionHeight = 400
  }
  const inspectHit = (hit: PhysicalSceneHit): void => {
    if (hit.subjectIds.length === 1) inspect(hit.sceneId, hit.subjectIds[0]!, hit.label, hit.occurrenceId)
    else { focusedId = hit.sceneId; componentsOpen = true }
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

  $effect(() => {
    const sources = physicalLayoutSources({ bindings, objects, hiddenCategoryIds, presentationFor })
    untrack(() => controller.setSources(sources))
  })
  $effect(() => { void theme; const palette = untrack(() => physicalLayoutPalette(map.getContainer())); untrack(() => { controller.setPalette(palette); overviewLayer?.setPalette(palette) }) })
  $effect(() => { overviewLayer?.update(suspended ? [] : scenes) })
  $effect(() => { onDetailedOwners(suspended ? [] : scenes.filter(scene => scene.status === 'ready').map(scene => scene.descriptor.targetObjectId)) })
  $effect(() => {
    void scenes; void objects; void runId; void perspectiveEpoch; void suspended; void documentVisible
    untrack(() => {
    const needed = new Set<string>()
    for (const [id, snapshot] of snapshots) {
      const descriptor = scenes.find(scene => scene.descriptor.id === id)?.descriptor
      if (descriptor === undefined || snapshot.latest !== null && (snapshot.latest.scope.revision !== descriptor.revision || snapshot.latest.scope.modelDigest !== descriptor.modelDigest)) snapshots = new Map([...snapshots].filter(([key]) => key !== id))
    }
    for (const scene of scenes) {
      if (scene.status !== 'ready' || !scene.view.live || suspended || !documentVisible) continue
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
    const palette = theme === 'dark' ? 'dusk' : 'day'
    for (const scene of scenes) {
      const snapshot = snapshots.get(scene.descriptor.id)
      const stale = snapshot === undefined || layoutLiveFrozen(snapshot, wallNow)
      const reading = snapshot?.latest
      const styles = new Map((reading?.subjects ?? []).map(subject => {
        const status = physicalSubjectStatus({ subject: { packId: reading!.scope.packId, objectId: reading!.scope.objectId, elementId: subject.elementId, label: subject.label }, values: subject.values, observations: reading!.sample.observations }, reading!.sample.alerts, stale)
        return [subject.elementId, physicalSubjectStyle(status, palette)] as const
      }))
      untrack(() => controller.setStatus(scene.descriptor.id, styles))
    }
  })
  let inspectionPerspective = untrack(() => perspectiveEpoch)
  $effect(() => {
    const changedPerspective = inspectionPerspective !== perspectiveEpoch
    inspectionPerspective = perspectiveEpoch
    if (changedPerspective) snapshots = new Map()
    if (changedPerspective || suspended || !documentVisible || (inspected !== null && activeInspection?.status !== 'ready')) { closeInspection(); hover = null }
  })

  const visibleOccurrences = $derived.by(() => {
    void screenRevision
    if (suspended || !documentVisible) return []
    return scenes.filter(scene => scene.status === 'ready').flatMap(scene => (controller.scene(scene.descriptor.id)?.objects ?? []).flatMap(occurrence => {
      if (occurrence.subjectIds.length === 0) return []
      const point = controller.project(scene.descriptor.id, occurrence.id)
      return point?.visible ? [{ sceneId: scene.descriptor.id, occurrence, point }] : []
    }))
  })
  const statusSummary = $derived.by(() => {
    if (focused === null || latest?.latest === null || latest === null) return null
    const reading = latest.latest
    return physicalLayoutStatusSummary({ owners: [{ packId: reading.scope.packId, objectId: reading.scope.objectId }], alerts: reading.sample.alerts,
      occurrences: (controller.scene(focused.descriptor.id)?.objects ?? []).map(occurrence => ({ id: occurrence.id, disposition: 'installed', subjects: occurrence.subjectIds.map(elementId => ({ packId: reading.scope.packId, objectId: reading.scope.objectId, elementId, label: occurrence.label })) })),
      visibleOccurrenceIds: new Set(visibleOccurrences.filter(entry => entry.sceneId === focused.descriptor.id).map(entry => entry.occurrence.id)),
    })
  })
  const badges = $derived.by(() => {
    void wallNow
    if (suspended || !documentVisible) return []
    const proposals = scenes.filter(scene => scene.status === 'ready' && scene.view.live).flatMap(scene => {
      const snapshot = snapshots.get(scene.descriptor.id)
      const reading = snapshot?.latest
      if (reading === undefined || reading === null) return []
      const stale = layoutLiveFrozen(snapshot!, wallNow)
      return reading.subjects.flatMap(subject => {
        for (const { occurrence, point } of visibleOccurrences.filter(entry => entry.sceneId === scene.descriptor.id)) {
          if (!occurrence.subjectIds.includes(subject.elementId)) continue
          const status = physicalSubjectStatus({ subject: { packId: reading.scope.packId, objectId: reading.scope.objectId, elementId: subject.elementId, label: subject.label }, values: subject.values, observations: reading.sample.observations }, reading.sample.alerts, stale)
          if (!stale && status.quality === 'good' && status.word === null && status.census.total === 0) return []
          const color = physicalSubjectStyle(status, theme === 'dark' ? 'dusk' : 'day').color
          return [{ sceneId: scene.descriptor.id, elementId: subject.elementId, label: subject.label, occurrenceId: occurrence.id, point,
            color: color === null ? 'var(--muted)' : `rgb(${color.map(channel => Math.round(channel * 255)).join(' ')})`,
            word: stale ? 'Not live' : status.quality !== 'good' ? `${status.quality} quality` : status.word ?? 'Live',
            chip: stale || status.quality !== 'good' ? '?' : status.word ?? '', alarms: status.active + status.returned, rank: priorityRank(status.priority) }]
        }
        return []
      })
    })
    return sparseLayoutBadges(proposals, size, toolsBox === null ? [] : [toolsBox])
  })
  const cardPoint = $derived.by(() => {
    void screenRevision
    const projected = inspected?.occurrenceId ? controller.project(inspected.sceneId, inspected.occurrenceId) : null
    const anchor = projected?.visible ? projected : null
    return { x: Math.max(8, Math.min(size.width - Math.min(360, size.width - 16) - 8, (anchor?.x ?? size.width / 2) + 24)), y: Math.max(8, Math.min(size.height - inspectionHeight - 8, (anchor?.y ?? 80) - 30)) }
  })
  const statusText = $derived(focused?.status === 'unavailable' ? focused.reason ?? 'Layout unavailable'
    : latest?.failure ?? (latest?.phase === 'inactive' ? 'Run not loaded; layout is not live' : latest?.phase === 'missing' ? 'Run missing' : latest?.latest === null || latest === null ? 'Waiting for live owner status'
      : frozen ? `Not live · ${latest.phase === 'suspended' ? 'updates suspended' : latest.phase} · last acquired ${Math.max(0, Math.floor((wallNow - (latest.stamp?.receivedWallMs ?? wallNow)) / 1000))} s ago` : `${latest.latest.sample.at.paused ? 'Paused · fresh' : 'Live'} · ${latest.latest.subjects.length} modelled subjects · ${latest.latest.sample.alerts.length} plant alerts`))
  const claimFocus = (): PhysicalScenePresentation | null => { if (focused !== null) focusedId = focused.descriptor.id; return focused }
  const coverRight = $derived.by(() => { void screenRevision; return map.getPadding().right ?? 0 })
  const toolsTop = $derived.by(() => { void screenRevision; return Math.max(12, clearTop - map.getContainer().getBoundingClientRect().top + 8) })
  $effect(() => {
    const element = toolsElement
    if (element === null) { toolsBox = null; return }
    const measure = (): void => {
      const box = element.getBoundingClientRect(), parent = map.getContainer().getBoundingClientRect()
      toolsBox = { x: box.left - parent.left, y: box.top - parent.top, width: box.width, height: box.height }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element); measure()
    return () => observer.disconnect()
  })

  runOnMount(() => {
    overviewLayer = createPhysicalSceneOverview({ map, palette: physicalLayoutPalette(map.getContainer()), beforeId: () => physicalSceneLayerAnchorId(map.getStyle()), reportError: error => onerror(`Physical layout overview: ${error.message}`) })
    let hoverTimer: ReturnType<typeof setTimeout> | null = null
    let screenTimer: ReturnType<typeof setTimeout> | null = null
    const changed = (): void => {
      if (screenTimer !== null) return
      screenTimer = setTimeout(() => { screenTimer = null; size = { width: map.getContainer().clientWidth, height: map.getContainer().clientHeight }; screenRevision += 1 }, 100)
    }
    const move = (event: { readonly point: { readonly x: number; readonly y: number }; readonly originalEvent: MouseEvent }): void => {
      if (hoverTimer !== null) clearTimeout(hoverTimer)
      if (suspended || event.originalEvent.buttons !== 0 || inspected !== null) { hover = null; return }
      const point = { x: event.point.x, y: event.point.y }
      hoverTimer = setTimeout(() => { hoverTimer = null; const hit = controller.pick(point); hover = hit !== null && hit.subjectIds.length > 0 ? hit : null }, 120)
    }
    const leave = (): void => { if (hoverTimer !== null) clearTimeout(hoverTimer) }
    const moving = (): void => { leave(); hover = null }
    const visibility = (): void => { documentVisible = !document.hidden }
    const receive = (event: MessageEvent): void => {
      frameHost.receive(event)
      if (event.origin !== location.origin || event.source !== inspectionFrame?.contentWindow || inspected === null) return
      const message = layoutInspectionMessageSchema.safeParse(event.data)
      if (!message.success || message.data.layoutObjectId !== inspected.sceneId || message.data.elementId !== inspected.elementId) return
      if (message.data.type === 'world:layout-inspection-close') closeInspection(message.data.returnFocus)
      else inspectionHeight = Math.min(message.data.height, Math.max(120, size.height - 16))
    }
    const clock = setInterval(() => { wallNow = Date.now() }, 250)
    map.on('mousemove', move); map.on('move', changed); map.on('resize', changed); map.on('render', changed); map.on('movestart', moving)
    document.addEventListener('visibilitychange', visibility); window.addEventListener('message', receive)
    onconnect({ dismiss: () => { closeInspection(); hover = null }, activate: point => {
      if (suspended) return false
      if (inspected !== null) { closeInspection(true); return true }
      const hit = controller.pick(point)
      const sceneId = hit?.sceneId ?? overviewLayer?.sceneAt(point)
      if (sceneId === null || sceneId === undefined) return false
      const scene = scenes.find(candidate => candidate.descriptor.id === sceneId)
      if (scene === undefined) return false
      focusedId = sceneId; overview(scene); return true
    } })
    return () => {
      onconnect(null); onDetailedOwners([]); leave(); if (screenTimer !== null) clearTimeout(screenTimer); clearInterval(clock)
      map.off('mousemove', move); map.off('move', changed); map.off('resize', changed); map.off('render', changed); map.off('movestart', moving)
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('message', receive)
      for (const entry of sessions.values()) entry.session.close()
      sessions.clear(); overviewLayer?.destroy(); overviewLayer = null; controller.destroy()
    }
  })
</script>

{#if focused !== null}
  <div class="layout-tools" bind:this={toolsElement} style:--cover-right="{coverRight}px" style:top="{toolsTop}px" style:max-height="{Math.max(0, size.height - toolsTop - 24)}px">
    {#if scenes.length > 1}
      <select aria-label="Physical layout" value={focused.descriptor.id} onchange={event => { focusedId = event.currentTarget.value; controlsOpen = true; controller.fit(focusedId) }}>
        {#each scenes as scene (scene.descriptor.id)}<option value={scene.descriptor.id}>{objects.find(object => object.id === scene.descriptor.id)?.label ?? objects.find(object => object.id === scene.descriptor.targetObjectId)?.label ?? scene.descriptor.targetObjectId}</option>{/each}
      </select>
    {/if}
    {#if controlsOpen && focused.status !== 'distant'}
      <Controls title={focusedLabel} levels={focused.descriptor.levels} view={focused.view} status={statusText} {suspended}
        onviewchange={(view: PhysicalSceneView) => { hover = null; closeInspection(); const scene = claimFocus(); if (scene !== null) controller.setView(scene.descriptor.id, view) }}
        onfit={() => { const scene = claimFocus(); if (scene !== null) controller.fit(scene.descriptor.id) }} onreset={() => { hover = null; closeInspection(); const scene = claimFocus(); if (scene !== null) controller.reset(scene.descriptor.id) }}
        onoverview={() => { const scene = claimFocus(); if (scene !== null) overview(scene) }} oncomponents={() => { claimFocus(); componentsOpen = !componentsOpen }} onclose={() => { controlsOpen = false; componentsOpen = false }} />
    {:else}
      <button type="button" class="layout-entry" onclick={() => { controlsOpen = true; const scene = claimFocus(); if (scene !== null) controller.fit(scene.descriptor.id) }}>Explore physical layout</button>
    {/if}
    {#if componentsOpen}
      <section class="layout-components" aria-label="Modelled layout components">
        <label>Find a component <input type="search" bind:value={filter} /></label>
        <p>{focused?.descriptor.subjectIds.length ?? 0} operational subjects are modelled in this layout. Other plant equipment remains available in Overview.</p>
        {#if statusSummary !== null}<p>{frozen ? 'Last known: ' : ''}{statusSummary.census.total} plant alerts · {statusSummary.unlocatedAlerts} unlocated · {statusSummary.hiddenLocations} affected locations on hidden levels or outside this view.</p>{/if}
        {#each components.filter(subject => `${subject.label} ${subject.elementId}`.toLowerCase().includes(filter.toLowerCase())) as subject (subject.elementId)}
          <button type="button" disabled={suspended} onclick={() => { if (focused !== null) inspect(focused.descriptor.id, subject.elementId, subject.label, null) }}>{subject.label}<span>Quick look ›</span></button>
        {/each}
        {#if latest?.latest === null || latest === null}<p>{statusText}</p>{/if}
      </section>
    {/if}
  </div>
{/if}
{#each badges as badge (`${badge.sceneId}:${badge.elementId}`)}
  <button class="layout-status" type="button" style:left="{badge.point.x}px" style:top="{badge.point.y}px" style:color={badge.color}
    title={`${badge.label}: ${badge.word}${badge.alarms > 0 ? ` · ${badge.alarms} alerts` : ''}`} aria-label={`Inspect ${badge.label}: ${badge.word}`}
    onclick={() => inspect(badge.sceneId, badge.elementId, badge.label, badge.occurrenceId)}><span class="layout-status-chip">{badge.alarms > 0 ? badge.alarms : badge.chip}</span></button>
{/each}
{#if hover !== null && !suspended && inspected === null}
  <button class="layout-quick-look" type="button" style:left="{hover.screen.x + 16}px" style:top="{hover.screen.y - 24}px" onclick={() => { if (hover !== null) inspectHit(hover) }}>⌕ Quick look · {hover.label}</button>
{/if}
{#if inspectionSource !== null && inspected !== null && !suspended}
  <div class="layout-inspection" style:left="{cardPoint.x}px" style:top="{cardPoint.y}px" style:height="{inspectionHeight}px">
    {#key inspectionSource}<iframe bind:this={inspectionFrame} title={`Inspect ${inspected.label}`} src={inspectionSource} allow="camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'" referrerpolicy="same-origin"></iframe>{/key}
  </div>
{/if}

<style>
  .layout-tools { position: absolute; z-index: 5; top: 12px; right: calc(var(--cover-right, 0px) + 54px); display: grid; gap: 5px; max-width: calc(100% - 28px); overflow-y: auto; overscroll-behavior: contain; pointer-events: auto; }
  .layout-tools > select, .layout-entry, .layout-components { border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: var(--text); font: inherit; padding: 8px; }
  .layout-tools > select, button, input { min-height: 44px; }
  button { cursor: pointer; }
  .layout-components { width: min(390px, calc(100vw - 32px)); max-height: 42vh; overflow: auto; box-sizing: border-box; font-size: 12px; }
  .layout-components label { display: grid; gap: 4px; }
  .layout-components p { color: var(--muted); font-size: 11px; }
  .layout-components button { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 8px; color: var(--text); background: var(--panel); border: 0; border-top: 1px solid var(--border); text-align: left; font: inherit; }
  .layout-components button span { color: var(--muted); }
  .layout-status, .layout-quick-look { position: absolute; z-index: 4; border: 1px solid var(--border); background: var(--panel); border-radius: 8px; min-width: 44px; padding: 5px; font: inherit; }
  .layout-status { transform: translate(-50%, -50%); font-size: 11px; width: 44px; height: 44px; box-sizing: border-box; padding: 0; background: transparent; border: 0; }
  .layout-status-chip { display: inline-block; max-width: 96px; padding: 2px 5px; border: 1px solid var(--border); border-radius: 4px; background: var(--panel); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .layout-quick-look { color: var(--text); max-width: 260px; font-size: 12px; }
  .layout-inspection { position: absolute; z-index: 8; width: min(360px, calc(100% - 16px)); background: var(--panel); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow-floating, 0 4px 12px var(--border)); overflow: hidden; }
  iframe { display: block; width: 100%; height: 100%; border: 0; }
  button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  @media (max-width: 850px) { .layout-tools { top: 56px; right: 8px; } }
</style>
