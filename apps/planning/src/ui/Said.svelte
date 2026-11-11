<script lang="ts">
  import type { NameKind, Part } from './explain-text.ts'

  // Words with named things in them; each name is a link that selects that job, crew, rule or item.
  let { parts, onPick }: { parts: readonly Part[]; onPick?: ((kind: NameKind, key: string) => void) | undefined } = $props()
</script>

{#each parts as part, index (index)}{#if typeof part === 'string'}{part}{:else if onPick}<button type="button" class="link name" onclick={() => onPick(part.kind, part.key)}>{part.name}</button>{:else}{part.name}{/if}{/each}
