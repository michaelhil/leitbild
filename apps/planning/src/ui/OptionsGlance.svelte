<script lang="ts">
  import MarkTag from './MarkTag.svelte'
  import { sizeCautionMark } from './model.ts'
  import type { OptionsGlance } from './options-glance.ts'
  import { statusLegend } from './status-text.ts'

  // The options at a glance, above the timeline. Each option is two rows: its name and values, then its
  // status with any caution beside it, across the whole width, so the table fits its column at any width
  // and nothing in it is cut off. Choosing an option shows it on the timeline; the Options view keeps the detail.
  let { glance, selected = null, busy = false, onSelect }: {
    glance: OptionsGlance
    selected?: string | null
    busy?: boolean
    onSelect: (option: string) => void
  } = $props()
</script>

<section class="options-glance" aria-labelledby="glance-options-title">
  <h2 id="glance-options-title" class="sr-only">Options compared</h2>
  <div class="glance-scroll">
    <table>
      <thead>
        <tr>
          <th scope="col">Option</th>
          {#each glance.columns as column (column)}<th scope="col" class="number">{column}</th>{/each}
        </tr>
      </thead>
      {#each glance.rows as row (row.key)}
        <!-- The option's name is the button; a click anywhere on its rows does the same. -->
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
        <tbody class:selected={row.key === selected} class:refused={row.cells === null} onclick={() => { if (!busy && row.key !== selected) onSelect(row.key) }}>
          <tr class="values">
            <th scope="row">
              <button type="button" class="link option-name" disabled={busy} aria-pressed={row.key === selected} title={row.key === selected ? 'Shown on the timeline' : 'Show on the timeline'} onclick={(event) => { event.stopPropagation(); if (row.key !== selected) onSelect(row.key) }}>{row.label}</button>
              {#if row.recommended}<MarkTag mark={{ shape: '★', word: 'Recommended' }} tone="good" />{/if}
            </th>
            {#if row.cells === null}
              <td colspan={glance.columns.length} class="cause">{row.cause}</td>
            {:else}
              {#each row.cells as cell, index (index)}
                <td class="number">{#if cell}<strong>{cell.value}</strong>{#if cell.mark}<small class="goal-word"><span aria-hidden="true">{cell.mark.shape}</span> {cell.mark.word}</small>{/if}{:else}<span class="sr-only">No value</span>{/if}</td>
              {/each}
            {/if}
          </tr>
          <tr class="chips-row">
            <td colspan={glance.columns.length + 1}>
              <span class="chips">
                <MarkTag mark={row.mark} tone={row.tone} />
                {#if row.caution}<MarkTag mark={sizeCautionMark} tone="warning" title={row.caution} />{/if}
                {#if row.stale}<MarkTag mark={{ shape: '↻', word: 'Out of date' }} tone="warning" />{/if}
              </span>
              {#each row.warnings as warning (warning)}<p class="beside"><MarkTag mark={{ shape: '!', word: 'Warning' }} tone="warning" /> {warning}</p>{/each}
            </td>
          </tr>
        </tbody>
      {/each}
    </table>
  </div>
  <p class="legend">
    {#each statusLegend as entry, index (entry.word)}{index === 0 ? '' : ' · '}<span class="legend-word">{entry.word}</span>: {entry.means}{/each}
  </p>
</section>
