<script lang="ts">
  import type { ScenarioGuidance as ScenarioGuidanceModel } from '../core/model/index.ts'

  interface Props {
    readonly guidance: ScenarioGuidanceModel
    readonly close: () => void
  }

  const { guidance, close }: Props = $props()
</script>

<aside class="scenario-guidance" aria-live="polite">
  <div>
    <strong class:update-title={guidance.tone === 'update'}>{guidance.title}</strong>
    <p>{guidance.message}</p>
  </div>
  {#if guidance.dismissible}
    <button type="button" aria-label="Dismiss guidance" onclick={close}>×</button>
  {/if}
</aside>
