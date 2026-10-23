<script lang="ts">
  import type { Observation } from '../../../core/observation/model.ts'
  import { bareLabel } from '../../../features/displays/compose/element-groups.ts'
  import type { ValueBlock, VignetteValue, VignetteView } from '../../../features/displays/compose/model.ts'
  import { wholeWords } from './fit-words.ts'
  import { underTitle } from './format.ts'
  import { valueLook, type ReadingLook } from './readout.ts'
  import CriterionRow from './CriterionRow.svelte'
  import GroupedValues from './GroupedValues.svelte'
  import Readout from './Readout.svelte'
  import StateWord from './StateWord.svelte'

  // An answer's values grouped by element (plan v5 W7.4): an element's values
  // under its name, each labelled without the object and the element its
  // heading names; parallel elements as one table; a value alone on its
  // element as a row whose label names it. Frozen, the readings are doubtful.
  let { blocks, view, observations, frozen }: {
    blocks: ReadonlyArray<ValueBlock>
    view: VignetteView
    observations: ReadonlyArray<Observation>
    frozen: boolean
  } = $props()

  const shown = (look: ReadingLook): ReadingLook => (frozen ? { ...look, doubtful: true } : look)
  /** Under its element's name a row drops the object and that name; otherwise only what the title or subject names. */
  const label = (value: VignetteValue, named: boolean): string => named ? bareLabel(value, view.subject?.object) : underTitle(value.label, view.title, view.subject)
</script>

{#each blocks as block, index (index)}
  {#if block.kind === 'table'}
    <GroupedValues section={block.table} {observations} {frozen} />
  {:else}
    <!-- The element's name gives way by whole words where its row is short; its whole label stays in the title. -->
    {#if block.element !== null}<div class="element" role="heading" aria-level={3} title={block.element.label} aria-label={block.element.label} use:wholeWords={block.element.shortLabel ?? block.element.label}></div>{/if}
    {#each block.values as value (value.ref)}
      {@const look = shown(valueLook(value, observations, value.ref))}
      {#if look.kind === 'criterion'}<CriterionRow {look} label={label(value, block.element !== null)} />{:else if look.kind === 'state'}<StateWord {look} label={label(value, block.element !== null)} />{:else}<Readout {look} label={label(value, block.element !== null)} />{/if}
    {/each}
  {/if}
{/each}

<style>
  /* An element's name over its rows: one row, neutral, the weight of a heading. */
  .element { height: var(--row); line-height: var(--row); overflow: hidden; white-space: nowrap; font-size: 12px; font-weight: 600; letter-spacing: 0.02em; color: var(--element-neutral-color); }
</style>
