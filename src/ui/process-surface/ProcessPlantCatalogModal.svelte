<script lang="ts">
  import { Copy, Search, X } from 'lucide-svelte'
  import type { ControlInstanceId } from '../../core/model/index.ts'
  import {
    readProcessPlantCatalog,
    type ProcessPlantCatalog,
  } from './process-surface-client.ts'

  interface Props {
    readonly controlInstanceId: ControlInstanceId
    readonly close: () => void
  }

  interface CatalogRow {
    readonly id: string
    readonly value: string
    readonly detail?: string
  }

  interface CatalogSection {
    readonly id: string
    readonly title: string
    readonly rows: ReadonlyArray<CatalogRow>
  }

  let { controlInstanceId, close }: Props = $props()

  let loading = $state(true)
  let error = $state<string | null>(null)
  let catalog = $state<ProcessPlantCatalog | null>(null)
  let query = $state('')
  let copyStatus = $state<string | null>(null)

  const rowsFor = (values: ReadonlyArray<string>): ReadonlyArray<CatalogRow> =>
    values.map(value => ({ id: value, value }))

  const sections = $derived<CatalogSection[]>(catalog === null ? [] : [
    { id: 'graphRefs', title: 'Graph refs', rows: rowsFor(catalog.graphRefs) },
    { id: 'assemblyRefs', title: 'Assembly refs', rows: rowsFor(catalog.assemblyRefs) },
    { id: 'graphFragmentRefs', title: 'Graph fragments', rows: rowsFor(catalog.graphFragmentRefs) },
    { id: 'graphFragmentInstancePresetRefs', title: 'Fragment presets', rows: rowsFor(catalog.graphFragmentInstancePresetRefs) },
    { id: 'icRefs', title: 'I&C refs', rows: rowsFor(catalog.icRefs) },
    {
      id: 'dynamicIcRefPatterns',
      title: 'Dynamic I&C patterns',
      rows: catalog.dynamicIcRefPatterns.map(pattern => ({
        id: pattern.id,
        value: pattern.pattern,
        detail: pattern.description ?? pattern.id,
      })),
    },
    { id: 'surfaceIds', title: 'Surface ids', rows: rowsFor(catalog.surfaceIds) },
  ])

  const normalizedQuery = $derived(query.trim().toLowerCase())
  const visibleSections = $derived<CatalogSection[]>(normalizedQuery.length === 0
    ? sections
    : sections.map(section => ({
      ...section,
      rows: section.rows.filter(row =>
        row.value.toLowerCase().includes(normalizedQuery)
        || row.id.toLowerCase().includes(normalizedQuery)
        || (row.detail?.toLowerCase().includes(normalizedQuery) ?? false),
      ),
    })).filter(section => section.rows.length > 0))
  const entryCount = $derived(sections.reduce((count, section) => count + section.rows.length, 0))

  const copyValue = async (value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      copyStatus = 'Copied'
    } catch (err) {
      copyStatus = err instanceof Error ? err.message : String(err)
    }
  }

  $effect(() => {
    const instanceId = controlInstanceId
    let cancelled = false

    const load = async (): Promise<void> => {
      try {
        loading = true
        error = null
        catalog = null
        copyStatus = null
        const next = await readProcessPlantCatalog(instanceId)
        if (!cancelled) catalog = next
      } catch (err) {
        if (!cancelled) error = err instanceof Error ? err.message : String(err)
      } finally {
        if (!cancelled) loading = false
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  })
</script>

<div class="process-artifact-backdrop" role="presentation">
  <section class="process-artifact-modal process-catalog-modal" aria-label="Process plant catalog">
    <header class="process-artifact-header">
      <div>
        <strong>Process plant catalog</strong>
        {#if catalog}
          <span>{entryCount} refs</span>
        {/if}
      </div>
      <div class="process-artifact-actions">
        <label class="process-artifact-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            placeholder="Search catalog"
            value={query}
            oninput={(event) => { query = event.currentTarget.value }}
          />
        </label>
        <button type="button" aria-label="Close catalog" onclick={close}>
          <X size={17} aria-hidden="true" />
        </button>
      </div>
    </header>
    {#if copyStatus}
      <div class="process-artifact-copy-status">{copyStatus}</div>
    {/if}
    <div class="process-artifact-body process-catalog-body">
      {#if loading}
        <div class="process-surface-message">Loading process plant catalog...</div>
      {:else if error}
        <div class="process-surface-error">{error}</div>
      {:else if catalog}
        {#if visibleSections.length === 0}
          <div class="process-surface-message">No catalog refs match.</div>
        {:else}
          <div class="process-catalog-sections">
            {#each visibleSections as section (section.id)}
              <section class="process-catalog-section" aria-label={section.title}>
                <header>
                  <strong>{section.title}</strong>
                  <span>{section.rows.length}</span>
                </header>
                <div class="process-catalog-rows">
                  {#each section.rows as row (row.id)}
                    <div class="process-catalog-row">
                      <div>
                        <code>{row.value}</code>
                        {#if row.detail}
                          <span>{row.detail}</span>
                        {/if}
                      </div>
                      <button type="button" aria-label="Copy {row.value}" title="Copy" onclick={() => void copyValue(row.value)}>
                        <Copy size={15} aria-hidden="true" />
                      </button>
                    </div>
                  {/each}
                </div>
              </section>
            {/each}
          </div>
        {/if}
      {:else}
        <div class="process-surface-error">Process plant catalog did not load.</div>
      {/if}
    </div>
  </section>
</div>
