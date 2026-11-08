<script lang="ts">
  import type { Snippet } from 'svelte'
  import { procedureFoldoutItems } from './procedure-view.ts'

  // A procedure's standing duties, kept in view: a side column, or a strip of headlines
  // whose items open over the page, so reading one never moves the step below it.

  interface Props {
    readonly heading: string
    readonly text: string
    readonly tagIds: ReadonlyArray<string>
    readonly layout: 'side' | 'strip'
    readonly line: Snippet<[string, readonly string[]]>
  }

  let { heading, text, tagIds, layout, line }: Props = $props()

  const items = $derived(procedureFoldoutItems(text))
  let openIndex = $state<number | null>(null)
  let root = $state<HTMLElement | null>(null)
  const opened = $derived(openIndex === null ? undefined : items[openIndex])

  $effect(() => {
    if (openIndex === null) return
    const pressElsewhere = (event: PointerEvent): void => {
      if (!root?.contains(event.target as Node)) openIndex = null
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      const index = openIndex
      openIndex = null
      root?.querySelectorAll<HTMLButtonElement>('.procedure-foldout-item')[index ?? 0]?.focus({ preventScroll: true })
    }
    window.addEventListener('pointerdown', pressElsewhere, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', pressElsewhere, true)
      window.removeEventListener('keydown', key, true)
    }
  })
</script>

{#if layout === 'side'}
  <aside class="procedure-foldout-side" aria-label={heading}>
    <h3>{heading}</h3>
    {#each items as item, index (index)}
      <p>{#if item.name}<b>{item.name}</b>{' '}{/if}{@render line(item.text, tagIds)}</p>
    {/each}
  </aside>
{:else}
  <div bind:this={root} class="procedure-foldout-strip" role="group" aria-label={heading}>
    <div class="procedure-foldout-items">
      <span class="procedure-foldout-label">{heading}</span>
      {#each items as item, index (index)}
        <button
          type="button"
          class="procedure-foldout-item"
          aria-expanded={openIndex === index}
          onclick={() => { openIndex = openIndex === index ? null : index }}
        >{item.name?.replace(/\.$/, '') ?? `Item ${index + 1}`}</button>
      {/each}
    </div>
    {#if opened}
      <div class="procedure-foldout-open" role="dialog" aria-label={opened.name ?? heading}>
        <p>{#if opened.name}<b>{opened.name}</b>{' '}{/if}{@render line(opened.text, tagIds)}</p>
      </div>
    {/if}
  </div>
{/if}
