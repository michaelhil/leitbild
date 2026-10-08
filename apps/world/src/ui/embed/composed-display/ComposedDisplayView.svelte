<script lang="ts">
  import type { EmbeddedViewEnvelope } from '@leitbild/contracts'
  import { simulationRunIdSchema } from '../../../core/model/index.ts'
  import { composedDisplayLayout, composedDisplayStateSchema } from '../../../packs/process-plant/displays/composition.ts'
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { composedDisplayClient } from './composed-display-client.ts'
  import { createComposedDisplaySession, type ComposedDisplaySnapshot } from './composed-display-session.ts'
  import AlarmsPanel from './AlarmsPanel.svelte'
  import ComparisonPanel from './ComparisonPanel.svelte'
  import PenLegend from './PenLegend.svelte'
  import ReadoutsPanel from './ReadoutsPanel.svelte'
  import TrendPanel from './TrendPanel.svelte'

  let { envelope }: { envelope: EmbeddedViewEnvelope } = $props()

  const parsed = $derived(composedDisplayStateSchema.parse(JSON.parse(envelope.state)))
  const composition = $derived(parsed.composition)

  // A sample older than this marks the view stale (polling is 1 Hz).
  const STALE_AFTER_MS = 5_000

  let snapshot = $state<ComposedDisplaySnapshot | null>(null)
  let wallNow = $state(Date.now())
  // Created once on mount; the envelope of an embedded view never changes.
  let session: ReturnType<typeof createComposedDisplaySession> | undefined

  runOnMount(() => {
    const active = createComposedDisplaySession({
      runId: simulationRunIdSchema.parse(envelope.subject.id),
      plantId: parsed.composition.plantId,
      state: envelope.state,
      client: composedDisplayClient,
      onChange: next => { snapshot = next },
    })
    session = active
    void active.start()
    const interacted = (): void => active.interacted()
    const visibility = (): void => active.setVisible(document.visibilityState === 'visible')
    const clock = setInterval(() => { wallNow = Date.now() }, 1_000)
    document.addEventListener('pointerdown', interacted)
    document.addEventListener('pointermove', interacted)
    document.addEventListener('keydown', interacted)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      active.close()
      clearInterval(clock)
      document.removeEventListener('pointerdown', interacted)
      document.removeEventListener('pointermove', interacted)
      document.removeEventListener('keydown', interacted)
      document.removeEventListener('visibilitychange', visibility)
    }
  })

  const view = $derived(snapshot?.view)
  const now = $derived(Date.parse(snapshot?.latest?.simulationTime ?? view?.simulationTime ?? parsed.issuedAt))
  const issuedAt = $derived(Date.parse(parsed.issuedAt))
  const stale = $derived(snapshot?.phase.kind === 'live'
    && (snapshot.sampleError !== null || (snapshot.lastSampleWallMs !== undefined && wallNow - snapshot.lastSampleWallMs > STALE_AFTER_MS)))

  const stateChip = $derived.by((): { text: string; tone: 'live' | 'quiet' | 'warn' } => {
    const phase = snapshot?.phase.kind ?? 'checking'
    if (phase === 'live' && stale) return { text: 'Stale', tone: 'warn' }
    if (phase === 'live') return snapshot?.playback === 'paused' ? { text: 'Paused', tone: 'quiet' } : { text: 'Live', tone: 'live' }
    if (phase === 'suspended') return { text: 'Updates paused', tone: 'quiet' }
    if (phase === 'inactive') return { text: 'Run not active', tone: 'quiet' }
    if (phase === 'missing') return { text: 'Run removed', tone: 'warn' }
    if (phase === 'failed') return { text: 'Unavailable', tone: 'warn' }
    return { text: 'Connecting', tone: 'quiet' }
  })

  const simulationClock = (ms: number): string => new Date(ms).toISOString().slice(11, 19)
</script>

<article class="card" aria-label={`AI-composed view: ${composition.title}`}>
  <header>
    <h1 title={composition.title}>{composition.title}</h1>
    <span class="unit">{view?.plantLabel ?? composition.plantId}</span>
    <span class={`chip ${stateChip.tone}`}>{stateChip.text}</span>
    <span class="clock">sim {simulationClock(now)}</span>
  </header>
  <p class="caption" title={`${composition.question} — ${composition.need}`}>
    <strong>Why this view:</strong> {composition.question} <span class="need">{composition.need}</span>
  </p>

  <!-- One reserved notice line; the most consequential notice wins. -->
  <p class="banner" class:quiet={!snapshot?.resetSinceAdvice && !view?.modelChanged}>
    {#if snapshot?.resetSinceAdvice}
      The Run was reset after this advice. The advice may no longer apply.
    {:else if view?.modelChanged}
      The Plant model changed after this advice was composed.
    {:else if snapshot?.phase.kind === 'suspended'}
      Updates paused after 15 minutes without interaction. <button type="button" onclick={() => session?.resume()}>Resume</button>
    {:else if snapshot?.phase.kind === 'live' && snapshot.sampleError !== null}
      Showing the last received values. {snapshot.sampleError}
    {:else if snapshot?.phase.kind === 'live'}
      Advice issued at sim {simulationClock(issuedAt)} · {Math.max(0, Math.round((now - issuedAt) / 60_000))} min ago
    {/if}
  </p>

  {#if snapshot === null || snapshot.phase.kind === 'checking' || snapshot.phase.kind === 'starting'}
    <p class="status">Connecting to the Run…</p>
  {:else if snapshot.phase.kind === 'missing'}
    <p class="status">This Run no longer exists. The advice above referred to it.</p>
  {:else if snapshot.phase.kind === 'inactive'}
    <div class="status">
      <p>The Run is not active, so nothing is updating.</p>
      <button type="button" onclick={() => { void session?.loadRun() }}>Load run</button>
      <p class="hint">Loading starts the Run's simulation runtime.</p>
    </div>
  {:else if snapshot.phase.kind === 'failed'}
    <p class="status">This view cannot be shown: {snapshot.phase.message}</p>
  {:else if view}
    <div class="panels" style={`gap:${composedDisplayLayout.panelGap}px`}>
      {#each view.display.panels as panel, index (index)}
        {#if panel.kind === 'trend'}
          <div style={`height:${composedDisplayLayout.trend}px`}>
            <TrendPanel {panel} series={snapshot.series} range={snapshot.ranges[index] ?? null} {now} {issuedAt} height={composedDisplayLayout.trendChart} />
            <PenLegend pens={panel.pens} latest={snapshot.latest} historyMissing={snapshot.historyMissing} />
          </div>
        {:else if panel.kind === 'comparison'}
          <ComparisonPanel {panel} latest={snapshot.latest} range={snapshot.ranges[index] ?? null} />
        {:else if panel.kind === 'readouts'}
          <ReadoutsPanel {panel} latest={snapshot.latest} />
        {:else}
          <AlarmsPanel {panel} latest={snapshot.latest} />
        {/if}
      {/each}
    </div>
  {/if}

  <footer>AI-composed view · thresholds from the Plant's I&amp;C rules · not an operating display</footer>
</article>

<style>
  .card { display: flex; flex-direction: column; gap: 4px; height: 100vh; padding: 8px 10px 6px; overflow: hidden; }
  header { display: flex; align-items: center; gap: 8px; min-width: 0; }
  h1 { margin: 0; font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1 1 auto; }
  .unit, .clock { font-size: 11.5px; color: var(--element-neutral-color); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .chip { font-size: 11px; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase; padding: 1px 7px; border-radius: 9px; border: 1px solid var(--border-outline-color); white-space: nowrap; }
  .chip.live { color: var(--element-active-color); }
  .chip.quiet { color: var(--element-neutral-color); }
  .chip.warn { color: var(--alert-caution-color); border-color: var(--alert-caution-color); }
  .caption { margin: 0; font-size: 12px; color: var(--element-active-color); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .need { color: var(--element-neutral-color); }
  .banner { margin: 0; height: 22px; padding: 0 8px; display: flex; align-items: center; gap: 8px; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: var(--container-section-color); border-left: 3px solid var(--alert-caution-color); }
  .banner.quiet { background: none; border-left-color: transparent; color: var(--element-neutral-color); padding-left: 0; }
  .status { margin: 8px 0; color: var(--element-neutral-color); }
  .status p { margin: 4px 0; }
  .hint { font-size: 11.5px; }
  button { font: inherit; font-size: 12px; padding: 1px 10px; border: 1px solid var(--border-outline-color); border-radius: 4px; background: var(--container-section-color); color: var(--element-active-color); cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: 1px; }
  .panels { display: flex; flex-direction: column; }
  footer { margin-top: auto; font-size: 10.5px; color: var(--element-neutral-color); }
</style>
