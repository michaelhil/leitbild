<script lang="ts">
  import { failureDetail, refusalText } from './api.ts'

  // A failure on the plan screen, in planner words. When the screen could not read an answer (its contract
  // refused it), the raw detail is kept behind "Details for support", never shown in the notice itself.
  let { text = null, cause = null }: { text?: string | null; cause?: unknown } = $props()
  const words = $derived(text ?? refusalText(cause))
  const detail = $derived(failureDetail(cause))
</script>

<div class="error" role="alert">
  <p class="error-words">{words}</p>
  {#if detail}<details class="error-detail"><summary>Details for support</summary><pre>{detail}</pre></details>{/if}
</div>
