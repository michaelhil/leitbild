<script lang="ts">
  import {
    createMapLayersPanel,
    type MapLayersPanelController,
    type MapLayersStorage,
  } from './map-layers-panel-state.ts'

  interface Props {
    readonly datasetId: string
    readonly categories: ReadonlyArray<string>
    readonly defaultsOn: ReadonlyArray<string>
    readonly simulationRunId: string | null
    readonly storage?: MapLayersStorage
    readonly onVisibilityChange?: (visibility: Readonly<Record<string, boolean>>) => void
    readonly title?: string
    readonly categoryLabels?: Readonly<Record<string, string>>
  }

  const props: Props = $props()

  let controller: MapLayersPanelController = $state(createMapLayersPanel({
    datasetId: props.datasetId,
    categories: props.categories,
    defaultsOn: props.defaultsOn,
    simulationRunId: props.simulationRunId,
    ...(props.storage ? { storage: props.storage } : {}),
  }))

  let collapsed = $state(false)

  const labelFor = (category: string): string => props.categoryLabels?.[category] ?? category.toUpperCase()

  const handleToggle = (category: string): void => {
    controller = controller.toggle(category)
    props.onVisibilityChange?.(controller.state.visibility)
  }

  const handleAll = (visible: boolean): void => {
    controller = controller.setAll(visible)
    props.onVisibilityChange?.(controller.state.visibility)
  }

  const visibleCount = $derived(
    Object.values(controller.state.visibility).filter(Boolean).length,
  )
</script>

<section class="layers-panel" aria-label="Map layers">
  <header class="layers-panel-header">
    <button
      type="button"
      class="layers-panel-toggle"
      aria-expanded={!collapsed}
      onclick={() => { collapsed = !collapsed }}
    >
      <span class="layers-panel-title">{props.title ?? 'Layers'}</span>
      <span class="layers-panel-count">{visibleCount}/{props.categories.length}</span>
    </button>
  </header>
  {#if !collapsed}
    <div class="layers-panel-body">
      <div class="layers-panel-actions">
        <button type="button" onclick={() => handleAll(true)}>All on</button>
        <button type="button" onclick={() => handleAll(false)}>All off</button>
      </div>
      <ul class="layers-panel-list">
        {#each props.categories as category (category)}
          <li>
            <label>
              <input
                type="checkbox"
                checked={controller.isVisible(category)}
                onchange={() => handleToggle(category)}
              />
              <span>{labelFor(category)}</span>
            </label>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</section>

<style>
  .layers-panel {
    background: rgba(255, 255, 255, 0.94);
    border: 1px solid rgba(15, 23, 42, 0.12);
    border-radius: 6px;
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
    font-size: 12px;
    line-height: 1.4;
    color: #0f172a;
    min-width: 180px;
    max-width: 240px;
  }
  .layers-panel-header {
    border-bottom: 1px solid rgba(15, 23, 42, 0.08);
  }
  .layers-panel-toggle {
    width: 100%;
    background: none;
    border: 0;
    padding: 6px 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    cursor: pointer;
    font: inherit;
    color: inherit;
  }
  .layers-panel-title {
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .layers-panel-count {
    font-variant-numeric: tabular-nums;
    color: #475569;
    font-size: 11px;
  }
  .layers-panel-body {
    padding: 6px 10px 8px;
  }
  .layers-panel-actions {
    display: flex;
    gap: 6px;
    margin-bottom: 6px;
  }
  .layers-panel-actions button {
    font: inherit;
    padding: 2px 6px;
    border: 1px solid rgba(15, 23, 42, 0.18);
    background: #f8fafc;
    border-radius: 4px;
    cursor: pointer;
    color: #1e293b;
  }
  .layers-panel-actions button:hover {
    background: #e2e8f0;
  }
  .layers-panel-list {
    list-style: none;
    padding: 0;
    margin: 0;
    max-height: 240px;
    overflow-y: auto;
  }
  .layers-panel-list li {
    margin: 2px 0;
  }
  .layers-panel-list label {
    display: flex;
    gap: 6px;
    align-items: center;
    cursor: pointer;
  }
  .layers-panel-list input[type="checkbox"] {
    margin: 0;
  }
</style>
