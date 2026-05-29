<script lang="ts">
  import type { OperationalObject } from '../../core/model/index.ts'
  import { electricGridPackDataSchema } from '../../packs/electric-grid/model.ts'

  interface Props {
    readonly objects: ReadonlyArray<OperationalObject>
  }

  const { objects }: Props = $props()

  const gridItems = $derived(objects.flatMap(object => {
    const parsed = electricGridPackDataSchema.safeParse(object.packData)
    return parsed.success ? [{ object, data: parsed.data }] : []
  }))
  const system = $derived(gridItems.find(item => item.data.type === 'grid_system')?.data)
  const branches = $derived(gridItems
    .filter(item => item.data.type === 'grid_branch')
    .map(item => ({ object: item.object, data: item.data }))
    .sort((left, right) => right.data.loadingPercent - left.data.loadingPercent)
    .slice(0, 4))
  const generators = $derived(gridItems
    .filter(item => item.data.type === 'grid_generator')
    .map(item => ({ object: item.object, data: item.data }))
    .sort((left, right) => right.data.dispatchMw - left.data.dispatchMw))
  const loads = $derived(gridItems
    .filter(item => item.data.type === 'grid_load')
    .map(item => ({ object: item.object, data: item.data }))
    .sort((left, right) => right.data.shedMw - left.data.shedMw)
    .slice(0, 4))

  const frequencyClass = $derived(!system
    ? 'idle'
    : system.frequencyHz < 49.85 || system.frequencyHz > 50.15
      ? 'alert'
      : system.frequencyHz < 49.95 || system.frequencyHz > 50.05
        ? 'watch'
        : 'normal')

  const mw = (value: number): string =>
    value.toLocaleString(undefined, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })
</script>

{#if system}
  <section class="grid-overview" aria-label="Electric grid overview">
    <header>
      <div>
        <p class="eyebrow">Electric grid</p>
        <h2>Norway operating overview</h2>
      </div>
      <div class="frequency" class:alert={frequencyClass === 'alert'} class:watch={frequencyClass === 'watch'}>
        <span>{system.frequencyHz.toFixed(3)}</span>
        <small>Hz</small>
      </div>
    </header>

    <div class="metric-grid">
      <div class="metric">
        <span>Generation</span>
        <strong>{mw(system.totalGenerationMw)} MW</strong>
      </div>
      <div class="metric">
        <span>Served load</span>
        <strong>{mw(system.servedLoadMw)} MW</strong>
      </div>
      <div class="metric">
        <span>Reserve</span>
        <strong>{mw(system.reserveMarginMw)} MW</strong>
      </div>
      <div class="metric">
        <span>Lowest voltage</span>
        <strong>{system.lowestVoltagePu.toFixed(3)} pu</strong>
      </div>
    </div>

    <div class="split">
      <div>
        <h3>Constrained corridors</h3>
        {#each branches as branch}
          <div class="row">
            <span>{branch.object.label}</span>
            <strong>{Math.round(branch.data.loadingPercent)}%</strong>
          </div>
        {/each}
      </div>
      <div>
        <h3>Generation stack</h3>
        {#each generators as generator}
          <div class="row">
            <span>{generator.object.label}</span>
            <strong>{mw(generator.data.dispatchMw)} MW</strong>
          </div>
        {/each}
      </div>
    </div>

    <div class="supply">
      <h3>Consumer supply</h3>
      {#each loads as load}
        <div class="row" class:problem={load.data.serviceState !== 'normal'}>
          <span>{load.object.label}</span>
          <strong>{Math.round(load.data.shedMw)} MW shed</strong>
        </div>
      {/each}
    </div>
  </section>
{/if}

<style>
  .grid-overview {
    position: absolute;
    top: 18px;
    right: 18px;
    z-index: 12;
    width: min(470px, calc(100vw - 380px));
    max-height: calc(100vh - 48px);
    overflow: auto;
    color: #0f172a;
    background: rgba(248, 250, 252, 0.94);
    border: 1px solid rgba(148, 163, 184, 0.55);
    box-shadow: 0 18px 44px rgba(15, 23, 42, 0.18);
    backdrop-filter: blur(14px);
    border-radius: 6px;
    padding: 16px;
  }

  :global(.dark) .grid-overview {
    color: #e5e7eb;
    background: rgba(15, 23, 42, 0.92);
    border-color: rgba(71, 85, 105, 0.85);
  }

  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 18px;
    margin-bottom: 14px;
  }

  .eyebrow {
    margin: 0 0 3px;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0;
    text-transform: uppercase;
    color: #64748b;
  }

  h2, h3 {
    margin: 0;
    letter-spacing: 0;
  }

  h2 {
    font-size: 19px;
    line-height: 1.15;
  }

  h3 {
    font-size: 12px;
    text-transform: uppercase;
    color: #475569;
    margin-bottom: 8px;
  }

  :global(.dark) h3,
  :global(.dark) .eyebrow {
    color: #94a3b8;
  }

  .frequency {
    min-width: 108px;
    text-align: right;
    color: #047857;
  }

  .frequency.watch {
    color: #b45309;
  }

  .frequency.alert {
    color: #dc2626;
  }

  .frequency span {
    display: block;
    font-size: 32px;
    line-height: 0.95;
    font-weight: 800;
  }

  .frequency small {
    font-weight: 800;
    font-size: 12px;
  }

  .metric-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
    margin-bottom: 14px;
  }

  .metric {
    border: 1px solid rgba(148, 163, 184, 0.35);
    border-radius: 4px;
    padding: 8px;
    min-width: 0;
  }

  .metric span,
  .row span {
    display: block;
    font-size: 11px;
    color: #64748b;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  :global(.dark) .metric span,
  :global(.dark) .row span {
    color: #94a3b8;
  }

  .metric strong {
    display: block;
    margin-top: 4px;
    font-size: 13px;
  }

  .split {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    margin-bottom: 14px;
  }

  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    align-items: baseline;
    padding: 5px 0;
    border-top: 1px solid rgba(148, 163, 184, 0.22);
  }

  .row strong {
    font-size: 12px;
  }

  .row.problem strong {
    color: #dc2626;
  }

  @media (max-width: 900px) {
    .grid-overview {
      left: 12px;
      right: 12px;
      top: 12px;
      width: auto;
    }

    .metric-grid,
    .split {
      grid-template-columns: 1fr 1fr;
    }
  }
</style>
