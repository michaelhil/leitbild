<script lang="ts">
  import type { EmbeddedViewEnvelope } from '@leitbild/contracts'
  import ComposedDisplayView from './composed-display/ComposedDisplayView.svelte'

  let { envelope }: { envelope: EmbeddedViewEnvelope } = $props()
</script>

{#if envelope.viewType === 'process-plant.display' && envelope.subject.type === 'world.simulation-run'}
  <ComposedDisplayView {envelope} />
{:else}
  <p class="embed-failure">Unsupported view: {envelope.viewType} on {envelope.subject.type}.</p>
{/if}
