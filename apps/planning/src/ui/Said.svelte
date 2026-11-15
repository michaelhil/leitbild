<script lang="ts">
  import type { NameKind, Part } from './explain-text.ts'

  // Words with named things in them; each name is a link that selects that job, crew, rule or item.
  // Links are inline, so a long name wraps with its sentence and never moves a list number or a quote
  // mark onto another line (maint's walk 4, N-D-01, N4-4-01). `quiet` names read as plain words that
  // can still be selected: a sentence of causes is not a row of underlines.
  let { parts, onPick, quiet = false }: { parts: readonly Part[]; onPick?: ((kind: NameKind, key: string) => void) | undefined; quiet?: boolean } = $props()
</script>

{#each parts as part, index (index)}{#if typeof part === 'string'}{part}{:else if onPick}<a class="name" class:quiet href="#item-{part.kind}-{part.key}" onclick={(event) => { event.preventDefault(); onPick(part.kind, part.key) }}>{part.name}</a>{:else}{part.name}{/if}{/each}
