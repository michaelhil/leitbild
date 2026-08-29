<script lang="ts">
  import { Copy, Search, X } from 'lucide-svelte'
  import { tick } from 'svelte'
  import type { ControlInstanceId } from '../../core/model/index.ts'
  import {
    readProcessPlantCatalog,
    readProcessPlantCatalogSource,
    type ProcessPlantCatalog,
    type ProcessPlantCatalogEntrySource,
    type ProcessPlantCatalogRefEntry,
    type ProcessPlantCatalogSectionId,
    type ProcessPlantCatalogSourceFile,
  } from './process-surface-client.ts'

  interface Props {
    readonly controlInstanceId: ControlInstanceId
    readonly close: () => void
  }

  interface CatalogRow {
    readonly id: string
    readonly value: string
    readonly detail?: string
    readonly source?: ProcessPlantCatalogEntrySource
  }

  interface CatalogSection {
    readonly id: ProcessPlantCatalogSectionId
    readonly title: string
    readonly rows: ReadonlyArray<CatalogRow>
  }

  interface CatalogSourcePanel {
    readonly sectionTitle: string
    readonly row: CatalogRow
    readonly source: ProcessPlantCatalogSourceFile | null
  }

  let { controlInstanceId, close }: Props = $props()

  let loading = $state(true)
  let error = $state<string | null>(null)
  let catalog = $state<ProcessPlantCatalog | null>(null)
  let query = $state('')
  let copyStatus = $state<string | null>(null)
  let sourcePanel = $state<CatalogSourcePanel | null>(null)
  let sourceLoading = $state(false)
  let sourceError = $state<string | null>(null)
  let sourceViewport = $state<HTMLElement | null>(null)
  let sourceRequestId = 0

  const rowsFor = (values: ReadonlyArray<ProcessPlantCatalogRefEntry>): ReadonlyArray<CatalogRow> =>
    values.map(entry => ({
      id: entry.id,
      value: entry.value,
      ...(entry.source === undefined ? {} : { source: entry.source }),
    }))

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
        ...(pattern.source === undefined ? {} : { source: pattern.source }),
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
        || (row.detail?.toLowerCase().includes(normalizedQuery) ?? false)
        || (row.source?.path.toLowerCase().includes(normalizedQuery) ?? false),
      ),
    })).filter(section => section.rows.length > 0))
  const entryCount = $derived(sections.reduce((count, section) => count + section.rows.length, 0))

  const sourceLinesFor = (content: string): ReadonlyArray<string> => content.split(/\r\n|\r|\n/)

  const scrollSourceToTarget = (): void => {
    const targetLineIndex = sourcePanel?.source?.targetLineIndex
    if (targetLineIndex === null || targetLineIndex === undefined) return
    const line = sourceViewport?.querySelector(`[data-catalog-source-line="${targetLineIndex}"]`)
    if (line instanceof HTMLElement) line.scrollIntoView({ block: 'center' })
  }

  const copyValue = async (value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      copyStatus = 'Copied'
    } catch (err) {
      copyStatus = err instanceof Error ? err.message : String(err)
    }
  }

  const openCatalogSource = async (section: CatalogSection, row: CatalogRow): Promise<void> => {
    if (row.source === undefined) return
    const requestId = sourceRequestId + 1
    sourceRequestId = requestId
    sourcePanel = {
      sectionTitle: section.title,
      row,
      source: null,
    }
    sourceLoading = true
    sourceError = null
    try {
      const source = await readProcessPlantCatalogSource(controlInstanceId, section.id, row.id)
      if (sourceRequestId !== requestId) return
      sourcePanel = {
        sectionTitle: section.title,
        row,
        source,
      }
      await tick()
      scrollSourceToTarget()
    } catch (err) {
      if (sourceRequestId === requestId) sourceError = err instanceof Error ? err.message : String(err)
    } finally {
      if (sourceRequestId === requestId) sourceLoading = false
    }
  }

  const closeCatalogSource = (): void => {
    sourceRequestId += 1
    sourcePanel = null
    sourceLoading = false
    sourceError = null
  }

  const closeCatalogSourceFromBackdrop = (event: MouseEvent): void => {
    if (event.target === event.currentTarget) closeCatalogSource()
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
        closeCatalogSource()
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
                      <button
                        type="button"
                        class="process-catalog-row-main"
                        disabled={row.source === undefined}
                        title={row.source === undefined ? 'No source file registered' : `Open ${row.source.path}`}
                        onclick={() => void openCatalogSource(section, row)}
                      >
                        <code>{row.value}</code>
                        {#if row.detail}
                          <span>{row.detail}</span>
                        {:else if row.source}
                          <span>{row.source.path}</span>
                        {/if}
                      </button>
                      <button class="process-catalog-copy-button" type="button" aria-label="Copy {row.value}" title="Copy" onclick={() => void copyValue(row.value)}>
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
  {#if sourcePanel}
    <div
      class="process-component-source-backdrop"
      role="presentation"
      onclick={closeCatalogSourceFromBackdrop}
    >
      <section
        class="process-component-source-modal process-catalog-source-modal"
        aria-label="Process plant catalog source"
      >
        <header>
          <div>
            <strong>{sourcePanel.row.value}</strong>
            <span>
              {sourcePanel.sectionTitle}
              {#if sourcePanel.source}
                · {sourcePanel.source.path}{#if sourcePanel.source.targetLineIndex !== null} · line {sourcePanel.source.targetLineIndex + 1}{/if}
              {:else if sourcePanel.row.source}
                · {sourcePanel.row.source.path}
              {/if}
            </span>
          </div>
          <button type="button" aria-label="Close catalog source" onclick={closeCatalogSource}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        {#if sourceLoading}
          <div class="process-surface-message">Loading source file...</div>
        {:else if sourceError}
          <div class="process-surface-error">{sourceError}</div>
        {:else if sourcePanel.source}
          <pre bind:this={sourceViewport}><code>{#each sourceLinesFor(sourcePanel.source.content) as line, lineIndex (`catalog-${sourcePanel.source.path}-${lineIndex}`)}<span data-catalog-source-line={lineIndex} class:active-line={sourcePanel.source.targetLineIndex === lineIndex}>{line}</span>{lineIndex + 1 < sourceLinesFor(sourcePanel.source.content).length ? '\n' : ''}{/each}</code></pre>
        {:else}
          <div class="process-surface-error">Catalog source file did not load.</div>
        {/if}
      </section>
    </div>
  {/if}
</div>
