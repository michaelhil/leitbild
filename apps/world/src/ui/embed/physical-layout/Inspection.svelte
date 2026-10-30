<script lang="ts">
  import type { EmbeddedViewEnvelope } from '@leitbild/contracts'
  import { simulationRunIdSchema } from '../../../core/model/ids.ts'
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { createLayoutLiveSession, layoutLiveFrozen, layoutLiveRoutes, type LayoutLiveSession, type LayoutLiveSnapshot } from '../../physical-layout/client.ts'
  import { layoutInspectionContentRoom, layoutInspectionExpected, readHostedLayoutInspectionSample, readHostedLayoutInspectionSpace, type LayoutInspectionState } from '../../physical-layout/inspection.ts'
  import type { LayoutLiveExpected } from '../../physical-layout/read-model.ts'
  import { physicalSubjectStatus } from '../../physical-layout/status.ts'
  import { admitPhysicalLiveStamp } from '../../physical-layout/status.ts'
  import { resolvePhysicalSubjectOperation } from '../../physical-layout/operation.ts'
  import { physicalOperationContext } from '../../physical-layout/operation-presentation.ts'
  import { createPageVisibility, embeddedDisplayFrame, trackVisibility, type DisplayOpening } from '../view-host.ts'
  import Faceplate from '../vignette/Faceplate.svelte'
  import ElementFaceplate from '../vignette/ElementFaceplate.svelte'
  import type { FaceplateReadings } from '../vignette/faceplate.ts'
  import { FACEPLATE_MARGIN } from '../vignette/popover.ts'
  import { provideOpening } from '../vignette/opening.svelte.ts'
  import '../vignette/openbridge.ts'

  let { envelope }: { envelope: EmbeddedViewEnvelope } = $props()
  let parsed = $state.raw<{ readonly state: LayoutInspectionState; readonly expected: LayoutLiveExpected } | null>(null)
  let failure = $state<string | null>(null)
  let snapshot = $state.raw<LayoutLiveSnapshot>({ phase: 'connecting', latest: null, stamp: null, failure: null })
  let wallNow = $state(Date.now())
  let viewport = $state.raw({ width: window.innerWidth, height: window.innerHeight })
  let hostAvailableHeight = $state<number | null>(null)
  let where = $state<DisplayOpening | null>(null)
  let activeElement = $state('')
  let activeName = $state('')
  let closed = $state(false)
  let failureElement = $state<HTMLElement | null>(null)
  let session: LayoutLiveSession | null = null
  const runId = $derived(simulationRunIdSchema.parse(envelope.subject.id))
  const frozen = $derived(layoutLiveFrozen(snapshot, wallNow))
  const subject = $derived(snapshot.latest?.subjects.find(subject => subject.elementId === activeElement))
  const context = $derived.by(() => {
    // Equipment uses the process display's shared card without added layout
    // lists. A connection card retains its actual endpoints and measured flow.
    if (subject?.topology?.kind !== 'connection' || !snapshot.latest) return []
    return physicalOperationContext(resolvePhysicalSubjectOperation(subject, snapshot.latest.sample.observations, frozen))
  })
  const readings = $derived<FaceplateReadings | null>(subject === undefined || snapshot.latest === null ? null : {
    values: subject.values, observations: snapshot.latest.sample.observations, devices: subject.devices,
    // The first map slice reads no extra history. The shared card explicitly
    // shows its current values without inventing a miniature trend.
    series: new Map(), now: Date.parse(snapshot.latest.sample.at.at),
  })
  const word = $derived(subject === undefined || parsed === null || snapshot.latest === null ? null : physicalSubjectStatus({
    subject: { packId: parsed.state.packId, objectId: parsed.state.objectId, elementId: subject.elementId, label: subject.label },
    values: subject.values, observations: snapshot.latest.sample.observations,
    operation: resolvePhysicalSubjectOperation(subject, snapshot.latest.sample.observations, frozen),
  }, snapshot.latest.sample.alerts, frozen).word)
  const { opening, stop } = provideOpening({ runId: () => runId, envelope: () => envelope, at: () => snapshot.latest?.sample.at })

  const hostMessage = (message: { readonly type: 'world:layout-inspection-close'; readonly returnFocus: boolean } | { readonly type: 'world:layout-inspection-size'; readonly height: number }): void => {
    if (window.parent === window || parsed === null) return
    window.parent.postMessage({ ...message, layoutObjectId: parsed.state.layoutObjectId, elementId: parsed.state.elementId }, location.origin)
  }
  const close = (returnFocus: boolean): void => { closed = true; session?.setVisible(false); hostMessage({ type: 'world:layout-inspection-close', returnFocus }) }
  const detail = (element: string): void => {
    if (parsed === null) return
    failure = null
    void opening.element(parsed.state.objectId, element, 'detail').then(reason => { failure = reason })
  }
  const inspect = (element: string, name: string): void => {
    activeElement = element; activeName = name; failure = null
  }
  $effect(() => {
    const element = failureElement
    if (element === null) return
    const measure = (): void => hostMessage({ type: 'world:layout-inspection-size', height: Math.ceil(element.getBoundingClientRect().bottom + Number.parseFloat(getComputedStyle(element).marginBottom)) })
    const observer = new ResizeObserver(measure)
    observer.observe(element); measure()
    return () => observer.disconnect()
  })

  runOnMount(() => {
    try { parsed = layoutInspectionExpected(envelope); activeElement = parsed.state.elementId; activeName = parsed.state.label } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      return stop
    }
    const hosted = parsed.state.delivery === 'host'
    if (hosted && window.parent === window) { failure = 'This inspection requires its authorized layout host'; return stop }
    const live = hosted ? null : createLayoutLiveSession({ expected: parsed.expected, requiredSubjectId: parsed.state.elementId, routes: layoutLiveRoutes, onChange: next => {
      snapshot = next; wallNow = Date.now()
    } })
    session = live
    const resize = (): void => { viewport = { width: window.innerWidth, height: window.innerHeight } }
    const host = embeddedDisplayFrame()
    const page = createPageVisibility({
      tabVisible: () => document.visibilityState === 'visible',
      viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
      onTabVisibility: changed => { document.addEventListener('visibilitychange', changed); return () => document.removeEventListener('visibilitychange', changed) },
      onResize: changed => { window.addEventListener('resize', changed); return () => window.removeEventListener('resize', changed) },
      observeIntersection: report => {
        const observer = new IntersectionObserver(entries => { const entry = entries.at(-1); if (entry !== undefined) report(entry.isIntersecting) })
        observer.observe(document.documentElement)
        return () => observer.disconnect()
      },
    })
    const untrack = trackVisibility({ host, documentVisible: page.visible, onDocumentVisibility: page.listen, setVisible: visible => live?.setVisible(visible && !closed) })
    const unsubscribe = host.subscribeOpening(next => { where = next })
    const unlisten = host.listen()
    window.addEventListener('resize', resize)
    const tick = setInterval(() => { wallNow = Date.now() }, 250)
    const receive = (event: MessageEvent): void => {
      if (!hosted || closed || event.source !== window.parent || event.origin !== location.origin || parsed === null) return
      if (event.data?.type === 'world:layout-inspection-space') {
        try { hostAvailableHeight = readHostedLayoutInspectionSpace(parsed.state, event.data) }
        catch (error) { failure = error instanceof Error ? error.message : String(error) }
        return
      }
      if (event.data?.type !== 'world:layout-inspection-sample') return
      try {
        const next = readHostedLayoutInspectionSample(parsed.state, parsed.expected, event.data)
        if (next.stamp !== null) admitPhysicalLiveStamp(parsed.expected, next.stamp.epoch, snapshot.stamp, next.stamp)
        snapshot = next; wallNow = Date.now()
      } catch (error) { snapshot = { ...snapshot, phase: 'failed', failure: error instanceof Error ? error.message : String(error) } }
    }
    if (hosted) {
      window.addEventListener('message', receive)
      window.parent.postMessage({ type: 'world:layout-inspection-ready', layoutObjectId: parsed.state.layoutObjectId, elementId: parsed.state.elementId, channel: parsed.state.channel }, location.origin)
    } else live!.start()
    return () => { live?.close(); session = null; clearInterval(tick); untrack(); unlisten(); unsubscribe(); stop(); window.removeEventListener('resize', resize); window.removeEventListener('message', receive) }
  })
</script>

{#if !closed && parsed !== null}
  <div class="state" role="status">{failure ?? snapshot.failure ?? (snapshot.phase === 'inactive' ? 'Not live · the Run is not loaded' : snapshot.phase === 'missing' ? 'Not live · the Run no longer exists' : frozen ? 'Not live · waiting for a fresh owner sample' : snapshot.latest?.sample.at.paused ? 'Paused · readings fresh' : 'Live owner readings')}</div>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <obc-button class="close" variant="flat" title="Close layout quick look" onclick={() => close(true)}>Close</obc-button>
  {#if snapshot.phase === 'failed' && snapshot.latest === null}
    <p bind:this={failureElement} class="failure" role="alert">No current owner sample is available. This quick look will retry while visible.</p>
  {:else if parsed.state.delivery !== 'host' || hostAvailableHeight !== null}
  {#key JSON.stringify([runId, parsed.state.objectId, parsed.state.packId, activeElement])}
  {#if subject === undefined && activeElement !== parsed.state.elementId}
    <!-- A related device is a new exact owner subject, not the housing's
         forwarded readings. One visible on-demand card reads it directly. -->
    <ElementFaceplate {runId} objectId={parsed.state.objectId} packId={parsed.state.packId} elementId={activeElement}
      name={activeName} title={activeName}
      alerts={snapshot.latest?.sample.alerts ?? []} {frozen} opening={where}
      zoom={1} room={layoutInspectionContentRoom(viewport.width, hostAvailableHeight ?? viewport.height)} anchor={null} item={() => []}
      showHistory={false} maxWidth={Math.max(240, viewport.width - 16)}
      onclose={close} ondetail={detail} oninspect={inspect}
      onsize={height => hostMessage({ type: 'world:layout-inspection-size', height: Math.ceil(height + 44 + 2 * FACEPLATE_MARGIN) })} />
  {:else}
  <Faceplate {runId} objectId={parsed.state.objectId} packId={parsed.state.packId} elementId={activeElement}
    name={subject?.label ?? parsed.state.label} {word} title={subject?.label ?? envelope.title} {readings} {context}
    alerts={snapshot.latest?.sample.alerts ?? []} alertElements={[activeElement]} group={false}
    related={subject === undefined || subject.devices.length === 0 ? null : { heading: 'Devices', entries: subject.devices.map(device => ({ element: device.id, name: device.label })) }}
    anchor={null} at={{ x: 0, y: 44 }} avoid={[]} zoom={1} room={layoutInspectionContentRoom(viewport.width, hostAvailableHeight ?? viewport.height)}
    {frozen} opening={where} pending={false} canPin={false} showHistory={false} maxWidth={Math.max(240, viewport.width - 16)}
    onclose={close} onpin={() => { throw new Error('This map faceplate has no pin canvas') }} onoverlay={() => { throw new Error('This map faceplate has no overlay canvas') }}
    ontouched={() => {}} onsize={height => hostMessage({ type: 'world:layout-inspection-size', height: Math.ceil(height + 44 + 2 * FACEPLATE_MARGIN) })}
    ondetail={detail} onfaceplate={inspect} />
  {/if}
  {/key}
  {/if}
{:else if failure !== null}
  <p bind:this={failureElement} class="failure" role="alert">This quick look cannot be shown: {failure}</p>
{/if}

<style>
  .state { position: fixed; left: 10px; top: 7px; right: 64px; min-height: 32px; display: flex; align-items: center; color: var(--element-neutral-color); font-size: 11px; line-height: 1.3; }
  .close { position: fixed; right: 8px; top: 0; min-width: 52px; min-height: 44px; padding: 6px; border: none; background: transparent; color: var(--element-active-color); font: inherit; font-size: 12px; cursor: pointer; }
  .close:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: -2px; }
  .failure { margin: 12px; padding-top: 44px; color: var(--element-active-color); font-size: 12px; line-height: 1.5; }
</style>
