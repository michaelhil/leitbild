<script lang="ts">
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { faceplatePlacement, type Box } from './popover.ts'
  import './openbridge.ts'

  // What a press on a continuation opens where it names several targets
  // (far ends in a flow or a network drawing): a
  // short list beside the item, each entry opening its own. It takes focus on
  // its first entry as it opens; Esc closes it first (before a faceplate or
  // Back) and returns focus to the item; a press outside it and its item, or
  // the window losing focus, closes it.
  let { name, entries, box, room, zoom, item, onchoose, onclose }: {
    /** The item's name: the list is "<name>: open which". */
    name: string
    entries: ReadonlyArray<{ readonly element: string; readonly name: string }>
    /** The item as the page shows it, in page px: the list stands beside it. */
    box: Box
    /** The part of the page a person sees. */
    room: Box
    zoom: number
    /** The item's own nodes: a press on them is the item's, not one outside the list. */
    item: () => ReadonlyArray<Element>
    onchoose: (entry: { readonly element: string; readonly name: string }) => void
    /** Closed without a choice; `returnFocus` by Esc. */
    onclose: (returnFocus: boolean) => void
  } = $props()

  const WIDTH = 260
  /** Each entry is a 40 px row: a touch target, as OpenBridge's list items are. */
  const ROW = 40
  const place = $derived(faceplatePlacement(box, { width: WIDTH, height: entries.length * ROW + 12 }, room, zoom))
  let list = $state<HTMLElement | undefined>()

  runOnMount(() => {
    requestAnimationFrame(() => list?.querySelector('button')?.focus())
    const down = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || list?.contains(event.target) === true) return
      if (item().some(node => node.contains(event.target as Node))) return
      onclose(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onclose(true)
    }
    const blurred = (): void => onclose(false)
    document.addEventListener('pointerdown', down, { capture: true })
    window.addEventListener('keydown', escape, { capture: true })
    window.addEventListener('blur', blurred)
    return () => {
      document.removeEventListener('pointerdown', down, { capture: true })
      window.removeEventListener('keydown', escape, { capture: true })
      window.removeEventListener('blur', blurred)
    }
  })
</script>

<div class="chooser" bind:this={list} data-chooser role="dialog" aria-label={`${name}: open which`} style:left={`${place.x}px`} style:top={`${place.y}px`} style:width={`${WIDTH}px`} style:transform={`scale(${1 / zoom})`}>
  <obc-card showTitle={false}>
    <ul>
      {#each entries as entry (entry.element)}
        <li><button type="button" onclick={() => onchoose(entry)}>{entry.name} ›</button></li>
      {/each}
    </ul>
  </obc-card>
</div>

<style>
  .chooser { position: fixed; z-index: 11; transform-origin: 0 0; box-shadow: var(--shadow-floating); border-radius: var(--ui-components-card-border-radius-regular, 8px); }
  .chooser ul { width: 100%; margin: 0; padding: 6px 0; list-style: none; }
  .chooser button { display: block; width: 100%; height: 40px; padding: 0 12px; border: none; background: none; font: inherit; font-size: 13px; text-align: left; color: var(--element-active-color); cursor: pointer; }
  .chooser button:hover { background: var(--flat-hover-background-color); }
  .chooser button:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: -2px; }
</style>
