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
  // tile writes its short label, the whole one in its title. Where full tiles
  // would leave the list too few rows (a narrow display's band), they stand
  // as one compact row (`strip`, tileStrip): the worst first, each a chip of
  // its label and a regular obc-badge, the rest counted ("+2").
  let { tiles, layout, strip, filter, onfilter }: {
    tiles: ReadonlyArray<AlertTile>
    /** Its columns and each tile's label (tileLayout); or, as one compact row, the chips that row holds (tileStrip). */
    layout?: { readonly columns: number; readonly labels: ReadonlyArray<string> } | undefined
    strip?: { readonly shown: ReadonlyArray<{ readonly tile: AlertTile; readonly label: string }>; readonly more: ReadonlyArray<AlertTile> } | undefined
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

{#if layout !== undefined}
  <div class="tiles" role="group" aria-label="Alerts by system" style:grid-template-columns={`repeat(${layout.columns}, minmax(0, 1fr))`}>
    {#each tiles as tile, at (tile.key)}
      {#if tile.rows.length > 0}
        <button type="button" class="tile" aria-pressed={sameFilter(filter, { kind: 'tile', key: tile.key })} title={`${title(tile)}: show only these`} onclick={press(tile)}>{@render counter(tile, layout.labels[at]!)}</button>
      {:else}
        <div class="tile" title={title(tile)}>{@render counter(tile, layout.labels[at]!)}</div>
      {/if}
    {/each}
  </div>
{:else if strip !== undefined}
  <div class="strip" role="group" aria-label="Alerts by system, the worst first">
    {#each strip.shown as { tile, label } (tile.key)}
      {@const badge = tileBadge(tile)!}
      <button type="button" class="tile chip" class:lit={badge.priority !== 'quiet'} aria-pressed={sameFilter(filter, { kind: 'tile', key: tile.key })} title={`${title(tile)}: show only these`} onclick={press(tile)}>
        <span class="label">{label}</span><obc-badge type={badge.priority === 'quiet' ? 'regular' : badgeType(badge.priority)} number={badge.count}></obc-badge>
      </button>
    {/each}
    {#if strip.more.length > 0}<span class="more" title={strip.more.map(title).join(' · ')}>+{strip.more.length}</span>{/if}
  </div>
{/if}

<style>
  .tiles { display: grid; gap: 4px; }
  .tile { display: block; min-width: 0; padding: 0; border: 0; border-radius: 6px; background: none; color: inherit; font: inherit; text-align: left; }
  button.tile { cursor: pointer; }
  button.tile:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: 1px; }
  /* The tile the list is narrowed to. */
  .tile[aria-pressed='true'] { outline: 2px solid var(--element-active-color); outline-offset: 1px; }
  /* One compact row: chips of a label and a badge, never wrapping, never cut (tileStrip counts what does not stand). */
  .strip { display: flex; align-items: center; gap: 4px; height: var(--row); white-space: nowrap; overflow: hidden; }
  .chip { flex: none; display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 4px; border: 1px solid var(--border-outline-color); border-radius: 4px; background: var(--container-section-color); color: var(--element-neutral-color); font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; }
  .chip.lit { color: var(--element-active-color); }
  .chip:hover { background: var(--flat-hover-background-color); }
  .chip:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: 1px; }
  .chip[aria-pressed='true'] { border-color: var(--element-active-color); outline: 1px solid var(--element-active-color); outline-offset: 0; }
  .more { flex: none; font-size: 12px; font-weight: 700; color: var(--element-neutral-color); }
</style>
