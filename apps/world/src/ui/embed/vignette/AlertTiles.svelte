<script lang="ts">
  import { sameFilter, type AlertFilter, type AlertTile } from '../../../features/displays/alerts/census.ts'
  import { badgeType, priorityWords } from './alerts.ts'
  import { countedAs } from '../../../features/displays/alerts/census.ts'
  import { tileBadge } from './tile-fit.ts'
  import './openbridge.ts'

  // An alert list's tiles (plan v5 W2.2): one OpenBridge
  // obc-alert-subsystem-counter per category its Pack declares, all of them,
  // in their order (else per object or subject group), each with one obc-badge:
  // its news counted, lit by the worst of them, never by what is expected; a
  // tile with only expected, standing or advisory alerts counts them in a
  // neutral badge (tileBadge), its title saying which. A tile with alerts is a
  // button that narrows the list to them and, pressed again, widens it. Tiles
  // stand in the fewest rows their labels allow whole (tile-fit.ts): a narrow
  // tile writes its short label, the whole one in its title.
  let { tiles, layout, filter, onfilter }: {
    tiles: ReadonlyArray<AlertTile>
    /** Its columns and each tile's label (tileLayout). */
    layout: { readonly columns: number; readonly labels: ReadonlyArray<string> }
    filter: AlertFilter | null
    onfilter: (filter: AlertFilter | null) => void
  } = $props()
  const title = (tile: AlertTile): string => {
    const apart = (['expected', 'standing', 'advisory'] as const).flatMap(kind => {
      const count = tile.rows.filter(row => countedAs(row) === kind).length
      return count > 0 ? [`${count} ${kind}`] : []
    })
    const words = [...tile.news.map(entry => `${entry.count} ${priorityWords(entry.priority)}`), ...apart]
    return `${tile.label}: ${words.length === 0 ? 'no alerts' : words.join(', ')}`
  }
  const press = (tile: AlertTile) => (): void => {
    const next: AlertFilter = { kind: 'tile', key: tile.key }
    onfilter(sameFilter(filter, next) ? null : next)
  }
</script>

{#snippet counter(tile: AlertTile, label: string)}
  {@const badge = tileBadge(tile)}
  <obc-alert-subsystem-counter {label} hasAlert={badge !== null} emptyText="">
    {#if badge !== null}<obc-badge slot="badges" size="large" type={badge.priority === 'quiet' ? 'regular' : badgeType(badge.priority)} number={badge.count}></obc-badge>{/if}
  </obc-alert-subsystem-counter>
{/snippet}

<div class="tiles" role="group" aria-label="Alerts by system" style:grid-template-columns={`repeat(${layout.columns}, minmax(0, 1fr))`}>
  {#each tiles as tile, at (tile.key)}
    {#if tile.rows.length > 0}
      <button type="button" class="tile" aria-pressed={sameFilter(filter, { kind: 'tile', key: tile.key })} title={`${title(tile)}: show only these`} onclick={press(tile)}>{@render counter(tile, layout.labels[at]!)}</button>
    {:else}
      <div class="tile" title={title(tile)}>{@render counter(tile, layout.labels[at]!)}</div>
    {/if}
  {/each}
</div>

<style>
  .tiles { display: grid; gap: 4px; }
  .tile { display: block; min-width: 0; padding: 0; border: 0; border-radius: 6px; background: none; color: inherit; font: inherit; text-align: left; }
  button.tile { cursor: pointer; }
  button.tile:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: 1px; }
  /* The tile the list is narrowed to. */
  .tile[aria-pressed='true'] { outline: 2px solid var(--element-active-color); outline-offset: 1px; }
</style>
