<script lang="ts">
  // Pack-rail source picker. A pack can pass an onSelect callback when source
  // switching is live; otherwise the component renders as read-only status.

  interface SourceOption {
    readonly id: string
    readonly label: string
    readonly disabled?: boolean
    readonly hint?: string
  }

  interface Props {
    readonly title?: string
    readonly sources: ReadonlyArray<SourceOption>
    readonly activeId: string | null
    readonly onSelect?: (sourceId: string) => void
  }

  const { title = 'Source', sources, activeId, onSelect }: Props = $props()

  const readOnly = $derived(onSelect === undefined)
</script>

{#if sources.length > 0}
  <section class="rail-source-picker" aria-label={title}>
    <header class="rail-source-picker-header">{title}</header>
    <ul class="rail-source-picker-list">
      {#each sources as source (source.id)}
        <li>
          <label class:disabled={source.disabled || readOnly}>
            <input
              type="radio"
              name="rail-source-picker-{title}"
              value={source.id}
              checked={activeId === source.id}
              disabled={source.disabled || readOnly}
              onchange={() => onSelect?.(source.id)}
            />
            <span class="rail-source-picker-label">{source.label}</span>
            {#if source.hint}
              <span class="rail-source-picker-hint">{source.hint}</span>
            {/if}
          </label>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .rail-source-picker {
    border-top: 1px solid rgba(15, 23, 42, 0.08);
    padding: 8px 12px 10px;
    background: rgba(248, 250, 252, 0.6);
    font-size: 12px;
    color: #0f172a;
  }
  .rail-source-picker-header {
    font-weight: 600;
    letter-spacing: 0.02em;
    color: #475569;
    text-transform: uppercase;
    font-size: 10px;
    margin-bottom: 6px;
  }
  .rail-source-picker-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .rail-source-picker-list li {
    margin: 2px 0;
  }
  .rail-source-picker-list label {
    display: flex;
    gap: 6px;
    align-items: baseline;
    cursor: pointer;
  }
  .rail-source-picker-list label.disabled {
    cursor: not-allowed;
    color: #94a3b8;
  }
  .rail-source-picker-list input[type="radio"] {
    margin: 0;
  }
  .rail-source-picker-hint {
    margin-left: auto;
    font-size: 10px;
    color: #94a3b8;
    letter-spacing: 0.02em;
  }
</style>
