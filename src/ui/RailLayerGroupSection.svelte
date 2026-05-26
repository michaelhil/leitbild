<script lang="ts">
  import type { PackMapLayerGroup } from '../core/packs/protocol.ts'

  interface Props {
    readonly groups: ReadonlyArray<PackMapLayerGroup>
    readonly visibility: Readonly<Record<string, boolean>>
    readonly onToggle: (groupId: string) => void
  }

  const { groups, visibility, onToggle }: Props = $props()

  const isVisible = (group: PackMapLayerGroup): boolean =>
    visibility[group.id] ?? group.defaultVisible
</script>

{#if groups.length > 0}
  <section class="rail-layer-groups" aria-label="Map layers">
    <header class="rail-layer-groups-header">Map layers</header>
    <ul class="rail-layer-groups-list">
      {#each groups as group (group.id)}
        <li>
          <label>
            <input
              type="checkbox"
              checked={isVisible(group)}
              onchange={() => onToggle(group.id)}
            />
            <span>{group.label}</span>
          </label>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .rail-layer-groups {
    border-top: 1px solid rgba(15, 23, 42, 0.08);
    padding: 8px 12px 10px;
    background: rgba(248, 250, 252, 0.6);
    font-size: 12px;
    color: #0f172a;
  }
  .rail-layer-groups-header {
    font-weight: 600;
    letter-spacing: 0.02em;
    color: #475569;
    text-transform: uppercase;
    font-size: 10px;
    margin-bottom: 6px;
  }
  .rail-layer-groups-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .rail-layer-groups-list li {
    margin: 2px 0;
  }
  .rail-layer-groups-list label {
    display: flex;
    gap: 6px;
    align-items: center;
    cursor: pointer;
  }
  .rail-layer-groups-list input[type="checkbox"] {
    margin: 0;
  }
</style>
