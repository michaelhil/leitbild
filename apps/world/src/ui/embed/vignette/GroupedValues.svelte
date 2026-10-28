<script lang="ts">
  import { unitSymbol, type Observation } from '../../../core/observation/model.ts'
  import type { VignetteSection } from '../../../features/displays/compose/model.ts'
  import { wholeWords } from './fit-words.ts'
  import { valueLook } from './readout.ts'
  import Readout from './Readout.svelte'
  import StateWord from './StateWord.svelte'
  import ComponentName from './ComponentName.svelte'
  import { componentValueOwner } from './component-activation.ts'

  // Parallel values as one table (architecture B): a column per quantity, a
  // line per element, as the composer grouped them; each cell reads as its
  // own readout or state, its limit chip shortened to the order word (and
  // giving way where the cell is short); in the low-integrity style while its
  // display is frozen. It stands in exactly the rows reserved for it, its
  // heading row then a row a line, and is never wider than a block of values.
  // Its values take the room they need first: a value is never cut (plan v5
  // §2 rule 2). The lines' names (their short labels) take what is left, up
  // to the longest name, giving way by whole words; then the values share the
  // rest, where their chips show; a heading is its
  // name over its unit and never widens its column, its name giving way by
  // whole words, its unit kept; the whole heading stays in its title.
  let { section, observations, frozen }: { section: Extract<VignetteSection, { kind: 'grouped' }>; observations: ReadonlyArray<Observation>; frozen: boolean } = $props()

  const headings = $derived(section.quantities.map(quantity => ({ name: quantity.label, unit: unitSymbol(quantity.unit) })))
</script>

<div class="grouped" role="table" style:--columns={section.quantities.length}>
  <div class="line" role="row">
    <span class="corner" role="columnheader"></span>
    {#each headings as heading, index (index)}
      {@const whole = heading.unit === '' ? heading.name : `${heading.name} (${heading.unit})`}
      <span class="heading" role="columnheader" title={whole} aria-label={whole}>
        <span class="name" use:wholeWords={heading.name}></span>{#if heading.unit !== ''}<span class="unit">{heading.unit}</span>{/if}
      </span>
    {/each}
  </div>
  {#each section.lines as line (JSON.stringify([componentValueOwner(line.values), line.element.id]))}
    {@const name = line.element.shortLabel ?? line.element.label}
    <div class="line" role="row">
      <!-- Its name as long as the column lets it be (the sizer asks for the whole), giving way by whole words. -->
      <span class="element" role="rowheader" title={line.element.label} aria-label={name}><span class="sizer" aria-hidden="true">{name}</span><ComponentName objectId={componentValueOwner(line.values)} elementId={line.element.id} {name} fullName={line.element.label} /></span>
      {#each line.values as value, index (index)}
        <span class="cell" role="cell">
          {#if value !== null}
            {@const read = valueLook(value, observations, value.ref)}
            {@const look = frozen ? { ...read, doubtful: true } : read}
            {#if look.kind === 'state'}<StateWord {look} />{:else}<Readout look={{ ...look, unit: '' }} />{/if}
          {/if}
        </span>
      {/each}
    </div>
  {/each}
</div>

<style>
  /*
   * Columns: each value's at least as wide as its widest value, the names' as wide as the longest name where the values
   * leave room (a name gives way by whole words, never cut while room remains), then the room left shared among the
   * values, where a limit chip shows.
   */
  .grouped { display: grid; grid-template-columns: minmax(0, max-content) repeat(var(--columns), minmax(min-content, 1fr)); max-width: 480px; }
  .line { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; height: var(--row); }
  /* A hairline inside the top of each line after the first: the table stands exactly in its rows. */
  .line + .line + .line { box-shadow: inset 0 1px 0 var(--border-divider-color); }
  .line > * { display: flex; align-items: center; min-width: 0; padding: 0 6px; white-space: nowrap; overflow: hidden; }
  .element { display: block; line-height: var(--row); color: var(--element-neutral-color); }
  /* The whole name sets how wide the names' column asks to be; the name shown fits the width it gets. */
  .sizer { display: block; height: 0; visibility: hidden; }
  .cell { justify-content: flex-end; }
  /* A heading in its row, right-aligned over its values: the name over the unit (a unitless name centred), never widening its column. */
  .heading { contain: inline-size; flex-direction: column; align-items: stretch; justify-content: center; line-height: 12px; text-align: right; color: var(--element-neutral-color); }
  .name { overflow: hidden; font-size: 12px; }
  .unit { font-size: 11px; }
</style>
