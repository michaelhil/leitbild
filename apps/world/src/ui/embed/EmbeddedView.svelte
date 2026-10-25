<script lang="ts">
  import type { EmbeddedViewEnvelope } from '@leitbild/contracts'
  import { DASHBOARD_VIEW_TYPE, VIGNETTE_VIEW_TYPE } from '../process-display/display-window-messages.ts'
  import Vignette from './vignette/Vignette.svelte'
  import { LAYOUT_INSPECTION_VIEW_TYPE } from '../physical-layout/inspection.ts'

  let { envelope }: { envelope: EmbeddedViewEnvelope } = $props()

  const ofRun = $derived(envelope.subject.type === 'world.simulation-run')
  const vignette = $derived(envelope.viewType === VIGNETTE_VIEW_TYPE && ofRun)
  const dashboard = $derived(envelope.viewType === DASHBOARD_VIEW_TYPE && ofRun)
  const layoutInspection = $derived(envelope.viewType === LAYOUT_INSPECTION_VIEW_TYPE && ofRun)
</script>

{#if vignette}
  <Vignette {envelope} />
{:else if layoutInspection}
  {#await import('./physical-layout/Inspection.svelte') then { default: Inspection }}
    <Inspection {envelope} />
  {:catch error}
    <p class="embed-failure">This quick look cannot be shown: {error instanceof Error ? error.message : String(error)}</p>
  {/await}
{:else if dashboard}
  <!-- A dashboard's frame loads its own code: a display's frame never does (§5.8). -->
  {#await import('./dashboard/Dashboard.svelte') then { default: Dashboard }}
    <Dashboard {envelope} />
  {:catch error}
    <p class="embed-failure">This dashboard cannot be shown: {error instanceof Error ? error.message : String(error)}</p>
  {/await}
{:else}
  <p class="embed-failure">Unsupported view: {envelope.viewType} on {envelope.subject.type}.</p>
{/if}
