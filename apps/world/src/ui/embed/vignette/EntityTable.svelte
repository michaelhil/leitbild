<script lang="ts">
  import { columnHead, entityCell } from './collection.ts'
  import type { EntityRow, VignetteSection } from '../../../features/displays/compose/model.ts'
  import { vignetteOpening } from './opening.svelte.ts'

  // Objects as a table (architecture B2): a column per core slot present,
  // rows as the composer sorted them (urgency, worst alert, Run order), the
  // last row counting those not shown. Urgency and status are words in a box;
  // only a row's worst alert takes its priority's colour. A press on a row
  // opens its object's World default after this display (W9.2, L3: its
  // slots, alerts and "Show on map"; Back returns), its name the row's button
  // for the keyboard; where no page can open a display, a row is no button.
  let { section, rows, more }: { section: Extract<VignetteSection, { kind: 'entity' }>; rows: ReadonlyArray<EntityRow>; more: number } = $props()

  const opening = vignetteOpening()
  const opens = $derived(opening !== undefined && opening.where !== null)
  let failure = $state<string | null>(null)
  const open = (row: EntityRow): void => {
    void opening?.subject(row.objectId).then(reason => { failure = reason === null ? null : `${row.label} cannot be opened: ${reason}` })
  }
</script>

<div class="scroll"><table class="entities" style:min-width={`${(section.columns.length + 1) * 88}px`}>
  <thead><tr><th scope="col">Object</th>{#each section.columns as column (column)}<th scope="col">{columnHead(column, section.near)}</th>{/each}</tr></thead>
  <tbody>
    {#each rows as row (row.objectId)}
      <!-- The row's name is its button for the keyboard; a press anywhere on the row is the same. -->
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
      <tr class:closed={row.closed === true} class:opens onclick={opens ? () => open(row) : undefined}>
        <th scope="row" title={row.label}>{#if opens}<button type="button" class="open" aria-label={`Open ${row.label}`} onclick={event => { event.stopPropagation(); open(row) }}>{row.label}</button>{:else}{row.label}{/if}</th>
        {#each section.columns as column (column)}
          {@const cell = entityCell(row, column)}
          <td class={cell.tone ?? ''} title={cell.title}>{#if cell.boxed}<span class="box">{cell.text}</span>{:else}{cell.text}{/if}</td>
        {/each}
      </tr>
    {/each}
    {#if rows.length === 0}<tr><td class="none" colspan={section.columns.length + 1}>None in this Run now</td></tr>{/if}
    {#if more > 0}<tr><td class="none" colspan={section.columns.length + 1}>+{more} more</td></tr>{/if}
  </tbody>
</table></div>
{#if failure !== null}<p class="notice" role="status">{failure}</p>{/if}

<style>
  /* Too narrow for its columns (a phone), the table scrolls sideways rather than cutting every cell. */
  .scroll { overflow-x: auto; }
  .entities { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { height: var(--row); padding: 0 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: left; font-weight: 400; }
  thead th { color: var(--element-neutral-color); font-size: 12px; }
  tbody tr + tr { border-top: 1px solid var(--border-divider-color); }
  .box { padding: 0 5px; border: 1px solid var(--border-outline-color); border-radius: 3px; }
  .closed { color: var(--element-neutral-color); }
  .none { color: var(--element-neutral-color); }
  /* A row that opens its object: OpenBridge's flat hover over the row, its name a button in the row's own words. */
  tr.opens { cursor: pointer; }
  tr.opens:hover { background: var(--flat-hover-background-color); }
  .open { display: block; width: 100%; height: var(--row); padding: 0; border: none; background: none; font: inherit; color: inherit; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
  .open:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: -2px; }
  .notice { margin: 0; font-size: 12px; color: var(--element-active-color); }
  td.caution, td.warning, td.alarm, td.critical { font-weight: 700; color: var(--display-alert-text); border-left: 3px solid; }
  td.caution { border-left-color: var(--display-caution-mark); }
  td.warning { border-left-color: var(--display-warning-mark); }
  td.alarm { border-left-color: var(--display-alarm-mark); }
  td.critical { border-left-color: var(--display-critical-mark); }
</style>
