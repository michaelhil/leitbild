<script lang="ts">
  import type { Mark } from './format.ts'

  // A shape and a word, so a mark never depends on colour.
  let { mark, tone = 'plain' }: { mark: Mark; tone?: 'plain' | 'rule' | 'estimate' | 'unknown' | 'assumption' | 'world' | 'refusal' | 'good' | 'warning' } = $props()
</script>

<span class="mark mark-{tone}"><span aria-hidden="true">{mark.shape}</span> {mark.word}</span>
