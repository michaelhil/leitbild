<script lang="ts">
  import type { Mark } from './format.ts'

  // A shape and a word, so a mark never depends on colour. `title` holds the sentence a chip stands for.
  let { mark, tone = 'plain', title = undefined }: { mark: Mark; tone?: 'plain' | 'rule' | 'estimate' | 'unknown' | 'assumption' | 'world' | 'refusal' | 'good' | 'warning'; title?: string | undefined } = $props()
</script>

<span class="mark mark-{tone}" {title}><span aria-hidden="true">{mark.shape}</span> {mark.word}</span>
