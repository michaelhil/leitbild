<script lang="ts">
  import { einsatzColors } from '../colors.ts'
  import { svgImageSource } from './einsatz-client.ts'
  import { dispatchWords, type OverviewView } from './presenters.ts'
  import type { ClickedObject } from './selection.ts'

  /**
   * The Dispatch panel's overview below the selection block: calls by
   * priority then age, units grouped by group (else type), and sites when
   * the configuration has receiving types. A row tap opens that object's
   * card, as a click on it on the map does. Conditions that need action sit
   * on their object's row while they hold. Columns follow the
   * configuration: a load column only with carriers, property columns only
   * for shown properties, each as "label value", so nothing needs a hover.
   * While a unit is armed the lists fold away and only the counts line
   * stays.
   */
  interface Props {
    readonly view: OverviewView
    readonly icon: (id: string) => string | undefined
    readonly open: (object: ClickedObject) => void
  }

  const props: Props = $props()
  const view = $derived(props.view)
</script>

{#snippet badge(id: string, colour: string)}
  {@const svg = props.icon(id)}
  <span class="badge" style:background={colour} aria-hidden="true">{#if svg !== undefined}<img src={svgImageSource(svg)} alt="" />{/if}</span>
{/snippet}

<p class="counts num" role="status">{view.counts}</p>
{#if !view.folded}
  <section aria-label={view.calls.heading}>
    <h3>{view.calls.heading}</h3>
    {#if view.calls.empty !== null}<p class="empty">{view.calls.empty}</p>{/if}
    <ol class="rows">
      {#each view.calls.rows as row (row.id)}
        <li>
          <button type="button" class="row" class:selected={row.selected} class:fresh={row.isNew} aria-pressed={row.selected} onclick={() => props.open({ id: row.id, kind: 'call' })}>
            {@render badge(row.icon, einsatzColors.task)}
            <span class="text">
              <span class="line"><span class="code">{row.code}</span><strong>{row.label}</strong>{#if row.isNew}<span class="new">{dispatchWords.newBadge}</span>{/if}{#if row.overdue}<span class="overdue">{dispatchWords.overdue}</span>{/if}<span class="num age">{row.waiting}</span></span>
              <span class="line sub">{row.needs}{#if row.assigned !== null} · {row.assigned}{/if}</span>
              {#each row.states as state, index (index)}<span class="line state">{state}</span>{/each}
            </span>
          </button>
        </li>
      {/each}
    </ol>
  </section>
  <section aria-label={view.units.heading}>
    <h3>{view.units.heading}</h3>
    {#if view.units.empty !== null}<p class="empty">{view.units.empty}</p>{/if}
    {#each view.units.groups as group (group.heading)}
      <h4>{group.heading}</h4>
      <ol class="rows">
        {#each group.rows as row (row.id)}
          <li>
            <button type="button" class="row" class:selected={row.selected} aria-pressed={row.selected} onclick={() => props.open({ id: row.id, kind: 'unit' })}>
              {@render badge(row.icon, einsatzColors.unit)}
              <span class="text">
                <span class="line"><strong>{row.label}</strong><span class="status" data-tone={row.status.tone}><span aria-hidden="true">●</span> {row.status.word}</span>{#if view.columns.carry && row.carry !== null}<span class="num cell">{row.carry}</span>{/if}{#each row.properties as property, index (index)}<span class="cell">{property}</span>{/each}</span>
                {#if row.current !== null || row.actor !== null}<span class="line sub">{row.current ?? ''}{#if row.actor !== null} <span class="by">{row.actor}</span>{/if}</span>{/if}
                {#each row.states as state, index (index)}<span class="line state">{state}</span>{/each}
              </span>
            </button>
          </li>
        {/each}
      </ol>
    {/each}
  </section>
  {#if view.sites !== null}
    <section aria-label={view.sites.heading}>
      <h3>{view.sites.heading}</h3>
      <ol class="rows">
        {#each view.sites.rows as row (row.id)}
          <li>
            <button type="button" class="row" class:selected={row.selected} aria-pressed={row.selected} onclick={() => props.open({ id: row.id, kind: 'site' })}>
              {@render badge(row.icon, einsatzColors.unit)}
              <span class="text">
                <span class="line"><strong>{row.label}</strong>{#if row.receiving !== null}<span class="sub">{row.receiving.accepting}</span><span class="num age">{row.receiving.slots}</span>{/if}</span>
                {#if row.inbound !== null}<span class="line sub">{row.inbound}</span>{/if}
                {#each row.states as state, index (index)}<span class="line state">{state}</span>{/each}
              </span>
            </button>
          </li>
        {/each}
      </ol>
    </section>
  {/if}
{/if}

<style>
  .counts { margin: 0; padding: 6px 8px; border-radius: 6px; background: var(--panel-strong); font-size: 12px; }
  section { display: grid; gap: 4px; }
  h3 { margin: 6px 0 0; color: var(--muted); font-size: 11px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
  h4 { margin: 4px 0 0; color: var(--muted); font-size: 11px; font-weight: 650; }
  .empty { margin: 0; color: var(--muted); }
  .rows { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
  .row { width: 100%; min-height: 44px; display: flex; gap: 8px; align-items: flex-start; padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: inherit; font: inherit; text-align: left; cursor: pointer; touch-action: manipulation; }
  .row.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .row.fresh { animation: fresh 1s ease-in-out 3; }
  @keyframes fresh { 50% { background: color-mix(in srgb, var(--warning) 22%, var(--panel)); } }
  .row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .badge { flex: none; width: 22px; height: 22px; display: inline-grid; place-items: center; border-radius: 50%; }
  .badge img { width: 15px; height: 15px; }
  .text { flex: 1; min-width: 0; display: grid; gap: 2px; }
  .line { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
  .sub, .by { color: var(--muted); font-size: 12px; }
  .state, .overdue { color: var(--critical); font-size: 12px; }
  .code { font-weight: 750; color: var(--critical); }
  .new { padding: 0 6px; border-radius: 6px; background: var(--warning); color: var(--panel); font-size: 11px; font-weight: 750; }
  .age { margin-left: auto; color: var(--muted); }
  .cell { color: var(--muted); font-size: 12px; }
  .status { font-size: 12px; }
  .status[data-tone='free'] span { color: var(--success); }
  .status[data-tone='busy'] span { color: var(--accent); }
  .status[data-tone='returning'] span { color: var(--muted); }
  .status[data-tone='attention'] span, .status[data-tone='out'] span { color: var(--critical); }
  .num { font-variant-numeric: tabular-nums; }
</style>
