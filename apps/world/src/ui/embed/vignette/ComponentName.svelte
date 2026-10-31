<script lang="ts">
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { wholeWords } from './fit-words.ts'
  import { drawsElement, onDrawingsChange, requestElement } from './selection.ts'

  let { objectId, elementId, name, fullName = name }: { objectId: string | null; elementId: string; name: string; fullName?: string } = $props()
  let drawings = $state(0)
  runOnMount(() => onDrawingsChange(() => { drawings += 1 }))
  const inspectable = $derived(drawings >= 0 && objectId !== null && drawsElement(objectId, elementId))
</script>

{#if inspectable}
  <button type="button" class="component-name" aria-label={`Faceplate: ${fullName}`} aria-haspopup="dialog" title={fullName} use:wholeWords={name} onclick={() => { if (objectId !== null) requestElement({ objectId, elementId, how: 'select' }) }}></button>
{:else}<span class="component-name" title={fullName} use:wholeWords={name}></span>{/if}

<style>
  .component-name { display: block; width: 100%; min-width: 0; height: var(--row); line-height: var(--row); padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: inherit; white-space: nowrap; overflow: hidden; }
  button { cursor: pointer; }button:hover { background: var(--flat-hover-background-color); }button:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: -2px; }
</style>
