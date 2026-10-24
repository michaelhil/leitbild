<script lang="ts">
  import type { EmbeddedViewEnvelope } from '@leitbild/contracts'
  import { DASHBOARD_VIEW_TYPE, VIGNETTE_VIEW_TYPE } from '../process-display/display-window-messages.ts'
  import Dashboard from './dashboard/Dashboard.svelte'
  import Vignette from './vignette/Vignette.svelte'

  let { envelope }: { envelope: EmbeddedViewEnvelope } = $props()

  const ofRun = $derived(envelope.subject.type === 'world.simulation-run')
  const vignette = $derived(envelope.viewType === VIGNETTE_VIEW_TYPE && ofRun)
  const dashboard = $derived(envelope.viewType === DASHBOARD_VIEW_TYPE && ofRun)
</script>

{#if vignette}
  <Vignette {envelope} />
{:else if dashboard}
  <Dashboard {envelope} />
{:else}
  <p class="embed-failure">Unsupported view: {envelope.viewType} on {envelope.subject.type}.</p>
{/if}
