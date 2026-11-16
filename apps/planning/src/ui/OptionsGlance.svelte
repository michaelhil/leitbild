<script lang="ts">
  import MarkTag from './MarkTag.svelte'
  import { sizeCautionMark } from './model.ts'
  import type { ChoosePanel, OptionsGlance } from './options-glance.ts'
  import { statusLegend } from './status-text.ts'
  import { unpricedMark } from './unpriced.ts'

  // The options at a glance, above the timeline. Each option is two rows: its name and values, then its
  // status with any caution beside it, across the whole width, so the table fits its column at any width
  // and nothing in it is cut off. Choosing an option shows it on the timeline; the Options view keeps the detail.
  // What-ifs are never rows here; one shown on the timeline is named under the table.
  let { glance, selected = null, busy = false, shownWhatIf = null, choices = [], open = null, onSelect, onChoose }: {
    glance: OptionsGlance
    selected?: string | null
    busy?: boolean
    /** The label of the what-if shown on the timeline, when one is. */
    shownWhatIf?: string | null
    /** The questions offered under the table, in order, with their words. */
    choices?: ReadonlyArray<{ readonly panel: ChoosePanel; readonly word: string }>
    open?: ChoosePanel | null
    onSelect: (option: string) => void
    onChoose?: ((panel: ChoosePanel) => void) | undefined
  } = $props()

  // A dominated option is folded: under the table, one line says how many, and opens them. The option shown on
  // the timeline is never hidden.
  let unfolded = $state(false)
  const dominated = $derived(glance.rows.filter(row => row.dominatedBy !== null))
  const rows = $derived(glance.rows.filter(row => row.dominatedBy === null || unfolded || row.key === selected))
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
      {#each rows as row (row.key)}
        <!-- The option's name is the button; a click anywhere on its rows does the same. -->
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
        <tbody class:selected={row.key === selected} class:refused={row.cells === null} onclick={() => { if (!busy && row.key !== selected) onSelect(row.key) }}>
          <tr class="values">
            <th scope="row">
              <button type="button" class="link option-name" disabled={busy} aria-pressed={row.key === selected} title={row.key === selected ? 'Shown on the timeline' : 'Show on the timeline'} onclick={(event) => { event.stopPropagation(); if (row.key !== selected) onSelect(row.key) }}>{row.label}</button>
              <!-- While the plan is out of date, the star says so, as "Why recommended" does (re-walk N5). -->
              {#if row.recommended}<MarkTag mark={{ shape: '★', word: row.stale ? 'Recommended before your latest change' : 'Recommended' }} tone={row.stale ? 'warning' : 'good'} />{/if}
              {#if row.dominatedBy}<small class="dominated-by">Dominated by “{row.dominatedBy}”</small>{/if}
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
              {#each row.unpriced as line (line)}<p class="beside"><MarkTag mark={unpricedMark} tone="assumption" /> {line}</p>{/each}
            </td>
          </tr>
        </tbody>
      {/each}
    </table>
  </div>
  {#if dominated.length > 0}
    <p class="dominated-line">
      <button type="button" class="link" aria-expanded={unfolded} onclick={() => { unfolded = !unfolded }}>{unfolded ? `Fold the dominated ${dominated.length === 1 ? 'option' : 'options'}` : `Show ${dominated.length} dominated ${dominated.length === 1 ? 'option' : 'options'}`}</button>
      <span class="hint"> Dominated: another option is no worse on every goal and better on one.</span>
    </p>
  {/if}
  {#if shownWhatIf}<p class="shown-what-if"><MarkTag mark={{ shape: '◇', word: 'What-if' }} tone="estimate" /> Shown on the timeline: {shownWhatIf}, a what-if, not one of the plan's options.</p>{/if}
  <p class="legend">
    {#each statusLegend as entry, index (entry.word)}{index === 0 ? '' : ' · '}<span class="legend-word">{entry.word}</span>: {entry.means}{/each}
  </p>
  {#if choices.length > 0 && onChoose}
    <div class="choose" role="group" aria-label="Ask about the options">
      {#each choices as choice (choice.panel)}
        <button type="button" class="quiet" class:current={open === choice.panel} aria-pressed={open === choice.panel} disabled={busy} onclick={() => onChoose?.(choice.panel)}>{choice.word}</button>
      {/each}
    </div>
  {/if}
</section>
