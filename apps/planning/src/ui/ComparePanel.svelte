<script lang="ts">
  import type { Answer, CompareView } from './why-text.ts'

  // What differs from the earlier options, beside the timeline: the shown option now, against the same
  // option in the set made before the latest change, in the Module's words (planning.plan.explain, versus).
  let { view, answer, onClose }: { view: CompareView; answer: Answer; onClose: () => void } = $props()
</script>

<section class="compare-panel" aria-labelledby="compare-title">
  <div class="panel-heading">
    <h2 id="compare-title" tabindex="-1">{view.title}</h2>
    <button type="button" class="quiet" onclick={onClose}>Close</button>
  </div>
  <p class="hint">{view.against}</p>
  {#if answer.state === 'loading'}
    <p class="hint" aria-live="polite">Asking Planning…</p>
  {:else if answer.state === 'not-built'}
    <p class="not-yet">{view.missing}</p>
  {:else if answer.state === 'refused'}
    <p class="error" role="alert">{answer.text}</p>
  {:else if answer.lines.length === 0}
    <p class="hint">Planning names no difference.</p>
  {:else}
    <ul class="why-lines">{#each answer.lines as line, index (index)}<li>{line}</li>{/each}</ul>
  {/if}
</section>
