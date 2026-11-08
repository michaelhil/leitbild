<script lang="ts">
  import type { EmbeddedViewEnvelope, EngineeringContinuationReceipt } from '@leitbild/contracts'
  import { untrack } from 'svelte'
  import '@oicl/openbridge-webcomponents/dist/components/button/button.js'
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { embeddedDisplayFrame } from '../view-host.ts'
  import { alignedContinuationSamples, continuationActive, continuationClient, continuationJobId, continuationLocation } from './continuation.ts'

  let { envelope }: { envelope: EmbeddedViewEnvelope } = $props()
  let receipt = $state.raw<EngineeringContinuationReceipt | null>(null)
  let failure = $state<string | null>(null)
  let acknowledgement = $state<string | null>(null)
  let busy = $state(false)
  let offset = $state(0)
  let original = $state('')
  let current = $state('')
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let pendingSubmit: { readonly key: string; readonly receipt: EngineeringContinuationReceipt; readonly refresh: boolean } | null = null
  const client = untrack(() => continuationClient(envelope))
  const rows = $derived(receipt === null ? [] : alignedContinuationSamples(receipt))
  const active = $derived(receipt !== null && continuationActive(receipt))
  const maxSamples = $derived(Math.max(0, ...(receipt?.cases.map(item => item.sampleCount) ?? [])))
  const permalink = $derived(receipt === null ? null : continuationLocation(envelope, receipt.jobId))
  const number = (value: number): string => value.toLocaleString(undefined, { maximumSignificantDigits: 6 })
  const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
  const schedule = (): void => {
    clearTimeout(timer)
    if (!closed && receipt !== null && continuationActive(receipt)) timer = setTimeout(() => { void load() }, 2000)
  }
  const load = async (): Promise<void> => {
    if (busy || closed) return
    busy = true
    try { const next = await client.inspect(current, offset); if (!closed) { receipt = next; failure = null; history.replaceState(null, '', continuationLocation(envelope, next.jobId)) } }
    catch (error) { if (!closed) { receipt = null; failure = errorText(error) } }
    finally { busy = false; schedule() }
  }
  const act = async (action: 'cancel' | 'rerun' | 'refresh'): Promise<void> => {
    if (busy || (receipt === null && action !== 'cancel')) return
    busy = true; failure = null; clearTimeout(timer)
    try {
      if (action !== 'cancel' && pendingSubmit !== null && pendingSubmit.refresh !== (action === 'refresh')) throw new Error(`A previous ${pendingSubmit.refresh ? 'refresh' : 'rerun'} has an unknown outcome. Retry that same action to resolve it before submitting another.`)
      if (action !== 'cancel' && pendingSubmit === null) pendingSubmit = { key: crypto.randomUUID(), receipt: receipt!, refresh: action === 'refresh' }
      const next = action === 'cancel' ? await client.cancel(current) : await client.submit(pendingSubmit!.receipt, pendingSubmit!.refresh, pendingSubmit!.key)
      pendingSubmit = null
      if (!closed) {
        if ('evidenceAvailable' in next) { receipt = null; acknowledgement = `Continuation ${next.status}. The work has stopped. Its source evidence is unavailable with current access.` }
        else { receipt = next; current = next.jobId; offset = 0; acknowledgement = null; history.replaceState(null, '', continuationLocation(envelope, next.jobId)) }
      }
    } catch (error) { if (!closed) failure = `${errorText(error)}${pendingSubmit === null ? '' : ' Retry the same action; its submission key is retained.'}` }
    finally { busy = false; schedule() }
  }
  const page = (next: number): void => { offset = next; void load() }
  runOnMount(() => {
    const host = embeddedDisplayFrame()
    const stop = host.listen()
    try { original = continuationJobId(envelope); current = original; void load() }
    catch (error) { failure = errorText(error) }
    return () => { closed = true; clearTimeout(timer); stop() }
  })
</script>

<!-- A new fragment identifies different evidence; reload through owner checks. -->
<svelte:window onhashchange={() => location.reload()} />

<main>
  <header><p class="eyebrow">Private model continuation · research only</p><h1>{envelope.title}</h1>
    <p>The cases start from one captured Run state. Their results are conditional model evidence.</p>
    {#if permalink !== null}<a href={permalink} target="_blank" rel="noopener">Open this result</a>{/if}</header>
  {#if failure}<p role="alert" class="failure">{failure}</p>{#if receipt === null && current !== ''}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <obc-button disabled={busy} onclick={() => void load()}>Retry reading</obc-button>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <obc-button disabled={busy} onclick={() => void act('cancel')}>Cancel continuation</obc-button>
  {/if}{/if}
  {#if acknowledgement}<p role="status">{acknowledgement}</p>{/if}
  {#if receipt}
    <section aria-label="Coverage">
      <h2>{receipt.status.replaceAll('-', ' ')} · requested {receipt.request.horizonSeconds} s</h2>
      {#if receipt.reason}<p>{receipt.reason}</p>{/if}
      <p>Source simulation time: <strong>{receipt.origin.frame.simulationAt}</strong><br/>Captured: {receipt.origin.frame.observedAt}</p>
      <div class="table-scroll"><table><caption>Achieved coverage, independently for each case</caption><thead><tr><th>Case</th><th>State</th><th>Run time reached</th><th>Model time reached</th></tr></thead>
      <tbody>{#each receipt.cases as item}<tr><th>{item.label}</th><td>{item.status}{#if item.reason}<small>{item.reason}</small>{/if}</td><td>{number(item.reachedSeconds)} / {receipt.request.horizonSeconds} s</td><td>{number(item.modelElapsedMs / 1000)} s</td></tr>{/each}</tbody></table></div>
      <p class="note">Missing time has no established result. Compared values below share the same elapsed time; no remainder is extrapolated.</p>
    </section>
    <div class="actions">
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <obc-button disabled={busy} onclick={() => void load()}>Check status</obc-button>
      {#if active}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <obc-button disabled={busy || receipt.status === 'cancellation-requested'} onclick={() => void act('cancel')}>Cancel continuation</obc-button>
      {:else}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <obc-button disabled={busy} onclick={() => void act('rerun')}>Rerun captured state</obc-button>
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <obc-button disabled={busy} onclick={() => void act('refresh')}>Refresh from current Run</obc-button>
      {/if}
    </div>
    <p class="note">Rerun creates a new attempt from the retained origin. Refresh captures a new origin. These controls affect private cases.</p>
    {#if current !== original}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <obc-button disabled={busy} onclick={() => { current = original; offset = 0; void load() }}>Return to original result</obc-button>
    {/if}
    <section aria-label="Compared traces"><h2>Aligned model traces</h2>
      {#if rows.length === 0}<p>No matching samples are established in this page.</p>
      {:else}<div class="table-scroll"><table><thead><tr><th>Elapsed</th><th>Quantity</th><th>Baseline</th><th>Variant</th><th>Variant − baseline</th></tr></thead><tbody>
        {#each rows as row}<tr><td>{row.elapsedSeconds} s</td><th>{row.label} ({row.unit})</th><td>{number(row.baseline)}</td><td>{number(row.variant)}</td><td>{row.difference === null ? 'Unknown quality' : number(row.difference)}</td></tr>{/each}
      </tbody></table></div>{/if}
      <div class="actions">
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <obc-button disabled={busy || offset === 0} onclick={() => page(Math.max(0, offset - 20))}>Previous samples</obc-button>
        <span>Samples {maxSamples === 0 ? 0 : offset + 1}–{Math.min(offset + 20, maxSamples)} of {maxSamples}</span>
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <obc-button disabled={busy || offset + 20 >= maxSamples} onclick={() => page(offset + 20)}>Next samples</obc-button>
      </div>
    </section>
    <details><summary>Scheduled interventions and accepted writes</summary>
      <p>Acceptance records a queued owner write. It does not establish the physical effect.</p>
      {#each receipt.cases as item}<h3>{item.label}</h3>{#if item.interventions.length === 0}<p>No interventions.</p>{/if}
        {#each item.interventions as intervention}<p>{intervention.atSeconds} s · {intervention.path} = {String(intervention.value)} · {intervention.status}{#if intervention.reason} · {intervention.reason}{/if}<small>Accepted at: {intervention.acceptedAt ?? 'Not established'}</small></p>{/each}
      {/each}
    </details>
    <details><summary>Source, configuration and full receipt</summary><p>Retained until {receipt.expiresAt}</p><pre>{JSON.stringify(receipt, null, 2)}</pre></details>
  {:else if !failure && !acknowledgement}<p role="status">Reading the retained continuation…</p>{/if}
  <p role="status" aria-live="polite">{busy ? 'Working…' : active ? 'Checking progress every two seconds.' : ''}</p>
</main>

<style>
  main { min-height: 100vh; padding: 20px; color: var(--element-active-color); background: var(--container-background-color); font-size: 14px; line-height: 1.5; }
  h1 { font-size: 22px; margin: 4px 0; } h2 { font-size: 17px; } h3 { font-size: 14px; }
  .eyebrow, .note, small { color: var(--element-neutral-color); font-size: 12px; } small { display: block; }
  section, details { margin: 20px 0; } .table-scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; text-align: left; font-variant-numeric: tabular-nums; }
  caption { text-align: left; margin-bottom: 8px; } th, td { padding: 8px; border-bottom: 1px solid var(--border-divider-color); vertical-align: top; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .failure { padding: 12px; border: 1px solid var(--border-divider-color); font-weight: 600; }
  a { color: var(--element-active-color); text-underline-offset: 3px; }
  summary { cursor: pointer; font-weight: 600; } pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
</style>
