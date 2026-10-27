<script lang="ts">
  import type { Observation } from '../../../core/observation/model.ts'
  import { bareLabel } from '../../../features/displays/compose/element-groups.ts'
  import type { ValueBlock, VignetteValue, VignetteView } from '../../../features/displays/compose/model.ts'
  import type { DrawnSeries } from './trend.ts'
  import ComponentName from './ComponentName.svelte'
  import { componentValueOwner } from './component-activation.ts'
  import { valueRows, type ValueRow } from './value-rows.ts'
  import GroupedValues from './GroupedValues.svelte'
  import ValueRows from './ValueRows.svelte'

  // An answer's values grouped by element (plan v5 W7.4), in the column's
  // rows (W4.2: sparkline, rate, margin): an element's values under its name,
  // each labelled without the object and the element its heading names;
  // parallel elements as one table; a value alone on its element as a row
  // whose label names it. Frozen, the readings are doubtful.
  let { blocks, view, observations, series, now, frozen }: {
    blocks: ReadonlyArray<ValueBlock>
    view: VignetteView
    observations: ReadonlyArray<Observation>
    series: ReadonlyMap<string, DrawnSeries>
    now: number
    frozen: boolean
  } = $props()

  /** A row's name under its element's heading: its short label without the element's short name ("RTB A closed" reads "Closed"), else its label without the object and the element. */
  const underHeading = (value: VignetteValue): string => {
    const short = value.shortLabel
    if (short === undefined) return bareLabel(value, view.subject?.object)
    const prefix = value.element?.shortLabel === undefined ? undefined : `${value.element.shortLabel} `
    if (prefix === undefined || !short.toLowerCase().startsWith(prefix.toLowerCase()) || short.length === prefix.length) return short
    const rest = short.slice(prefix.length)
    return `${rest.charAt(0).toUpperCase()}${rest.slice(1)}`
  }
  /** A block's rows; under its element's name a row drops what the heading says. */
  const rowsOf = (block: Extract<ValueBlock, { kind: 'element' }>): ReadonlyArray<ValueRow> => {
    const rows = valueRows({ values: block.values, observations, series, now, title: view.title, ...(view.subject === undefined ? {} : { subject: view.subject }), frozen })
    return block.element === null ? rows : rows.map((row, at) => ({ ...row, label: underHeading(block.values[at]!) }))
  }
</script>

{#each blocks as block, index (index)}
  {#if block.kind === 'table'}
    <GroupedValues section={block.table} {observations} {frozen} />
  {:else}
    <!-- The element's name gives way by whole words where its row is short; its whole label stays in the title. -->
    {#if block.element !== null}<div class="element" role="heading" aria-level={3}><ComponentName objectId={componentValueOwner(block.values)} elementId={block.element.id} name={block.element.shortLabel ?? block.element.label} fullName={block.element.label} /></div>{/if}
    <ValueRows rows={rowsOf(block)} {now} />
  {/if}
{/each}

<style>
  /* An element's name over its rows: one row, neutral, the weight of a heading. */
  .element { height: var(--row); line-height: var(--row); overflow: hidden; white-space: nowrap; font-size: 12px; font-weight: 600; letter-spacing: 0.02em; color: var(--element-neutral-color); }
</style>
