<script lang="ts">
  import type { EmbeddedViewEnvelope } from '@leitbild/contracts'
  import { simulationRunIdSchema } from '../../../core/model/ids.ts'
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { createLayoutLiveSession, layoutLiveFrozen, layoutLiveRoutes, type LayoutLiveSession, type LayoutLiveSnapshot } from '../../physical-layout/client.ts'
  import { layoutInspectionExpected, type LayoutInspectionState } from '../../physical-layout/inspection.ts'
  import type { LayoutLiveExpected } from '../../physical-layout/read-model.ts'
  import { physicalSubjectStatus } from '../../physical-layout/status.ts'
  import { createPageVisibility, embeddedDisplayFrame, trackVisibility, type DisplayOpening } from '../view-host.ts'
  import Faceplate from '../vignette/Faceplate.svelte'
  import type { FaceplateReadings } from '../vignette/faceplate.ts'
  import { provideOpening } from '../vignette/opening.svelte.ts'
  import '../vignette/openbridge.ts'

  let { envelope }: { envelope: EmbeddedViewEnvelope } = $props()
  let parsed = $state.raw<{ readonly state: LayoutInspectionState; readonly expected: LayoutLiveExpected } | null>(null)
  let failure = $state<string | null>(null)
  let snapshot = $state.raw<LayoutLiveSnapshot>({ phase: 'connecting', latest: null, stamp: null, failure: null })
  let wallNow = $state(Date.now())
  let viewport = $state.raw({ width: window.innerWidth, height: window.innerHeight })
  let where = $state<DisplayOpening | null>(null)
  let activeElement = $state('')
  let closed = $state(false)
  let session: LayoutLiveSession | null = null
  const runId = $derived(simulationRunIdSchema.parse(envelope.subject.id))
  const frozen = $derived(layoutLiveFrozen(snapshot, wallNow))
  const subject = $derived(snapshot.latest?.subjects.find(subject => subject.elementId === activeElement))
  const readings = $derived<FaceplateReadings | null>(subject === undefined || snapshot.latest === null ? null : {
    values: subject.values, observations: snapshot.latest.sample.observations, devices: subject.devices,
    // The first map slice reads no extra history. The shared card explicitly
    // shows its current values without inventing a miniature trend.
    series: new Map(), now: Date.parse(snapshot.latest.sample.at.at),
  })
  const word = $derived(subject === undefined || parsed === null || snapshot.latest === null ? null : physicalSubjectStatus({
    subject: { packId: parsed.state.packId, objectId: parsed.state.objectId, elementId: subject.elementId, label: subject.label },
    values: subject.values, observations: snapshot.latest.sample.observations,
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
  const inspect = (element: string): void => {
    if (snapshot.latest?.subjects.some(subject => subject.elementId === element)) activeElement = element
    else detail(element)
  }

  runOnMount(() => {
    try { parsed = layoutInspectionExpected(envelope); activeElement = parsed.state.elementId } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      return stop
    }
    const live = createLayoutLiveSession({ expected: parsed.expected, requiredSubjectId: parsed.state.elementId, routes: layoutLiveRoutes, onChange: next => {
      snapshot = next; wallNow = Date.now()
      if (next.phase === 'failed' && next.latest === null) hostMessage({ type: 'world:layout-inspection-size', height: 160 })
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
    const untrack = trackVisibility({ host, documentVisible: page.visible, onDocumentVisibility: page.listen, setVisible: visible => live.setVisible(visible && !closed) })
    const unsubscribe = host.subscribeOpening(next => { where = next })
    const unlisten = host.listen()
    window.addEventListener('resize', resize)
    const tick = setInterval(() => { wallNow = Date.now() }, 250)
    live.start()
    return () => { live.close(); session = null; clearInterval(tick); untrack(); unlisten(); unsubscribe(); stop(); window.removeEventListener('resize', resize) }
  })
</script>

{#if !closed && parsed !== null}
  <div class="state" role="status">{failure ?? snapshot.failure ?? (snapshot.phase === 'inactive' ? 'Not live · the Run is not loaded' : snapshot.phase === 'missing' ? 'Not live · the Run no longer exists' : frozen ? 'Not live · waiting for a fresh owner sample' : snapshot.latest?.sample.at.paused ? 'Paused · readings fresh' : 'Live owner readings')}</div>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <obc-button class="close" variant="flat" title="Close layout quick look" onclick={() => close(true)}>Close</obc-button>
  {#if snapshot.phase === 'failed' && snapshot.latest === null}
    <p class="failure" role="alert">No current owner sample is available. This quick look will retry while visible.</p>
  {:else}
  <Faceplate {runId} objectId={parsed.state.objectId} packId={parsed.state.packId} elementId={activeElement}
    name={subject?.label ?? parsed.state.label} {word} title={envelope.title} {readings}
    alerts={snapshot.latest?.sample.alerts ?? []} alertElements={[activeElement]} group={false}
    related={subject === undefined || subject.devices.length === 0 ? null : { heading: 'Devices', entries: subject.devices.map(device => ({ element: device.id, name: device.label })) }}
    anchor={null} at={{ x: 0, y: 44 }} avoid={[]} zoom={1} room={{ x: 0, y: 44, width: viewport.width, height: Math.max(0, viewport.height - 44) }}
    {frozen} opening={where} pending={false} canPin={false} maxWidth={Math.max(240, viewport.width - 16)}
    onclose={close} onpin={() => { throw new Error('This map faceplate has no pin canvas') }} onoverlay={() => { throw new Error('This map faceplate has no overlay canvas') }}
    ontouched={() => {}} onsize={height => hostMessage({ type: 'world:layout-inspection-size', height: Math.min(960, Math.max(120, Math.ceil(height + 60))) })}
    ondetail={detail} onfaceplate={inspect} />
  {/if}
{:else if failure !== null}
  <p class="failure" role="alert">This quick look cannot be shown: {failure}</p>
{/if}

<style>
  .state { position: fixed; left: 10px; top: 7px; right: 64px; min-height: 32px; display: flex; align-items: center; color: var(--element-neutral-color); font-size: 11px; line-height: 1.3; }
  .close { position: fixed; right: 8px; top: 0; min-width: 52px; min-height: 44px; padding: 6px; border: none; background: transparent; color: var(--element-active-color); font: inherit; font-size: 12px; cursor: pointer; }
  .close:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: -2px; }
  .failure { margin: 12px; padding-top: 44px; color: var(--element-active-color); font-size: 12px; line-height: 1.5; }
</style>
