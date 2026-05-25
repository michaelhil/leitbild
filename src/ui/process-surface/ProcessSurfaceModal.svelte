<script lang="ts">
  import type { ControlInstanceId, OperationalObject } from '../../core/model/index.ts'
  import type { CompiledProcessSurface, ProcessSurfaceValue } from '../../packs/process-plant/surfaces/index.ts'
  import ModalShell from '../components/ModalShell.svelte'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import ProcessSurfaceRenderer from './ProcessSurfaceRenderer.svelte'
  import { listProcessSurfaces, readProcessSurface, readProcessSurfaceSnapshot } from './process-surface-client.ts'
  import {
    readProcessSurfaceLayout,
    storeProcessSurfaceLayout,
    type ProcessSurfaceLayout,
    type ProcessSurfaceWidgetPosition,
  } from './process-surface-layout.ts'

  interface Props {
    readonly controlInstanceId: ControlInstanceId
    readonly object: OperationalObject
    readonly close: () => void
  }

  let { controlInstanceId, object, close }: Props = $props()

  let loading = $state(true)
  let error = $state<string | null>(null)
  let surface = $state<CompiledProcessSurface | null>(null)
  let values = $state<ReadonlyMap<string, ProcessSurfaceValue>>(new Map())
  let widgetPositions = $state<ProcessSurfaceLayout>({})
  let loadedSystemId = $state<string | null>(null)

  const systemIdFor = (candidate: OperationalObject): string => {
    const data = candidate.domainData
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('process display object has no domain data')
    const systemId = (data as Record<string, unknown>).systemId
    if (typeof systemId !== 'string' || systemId.length === 0) throw new Error('process display object has no system id')
    return systemId
  }

  const refreshSnapshot = async (systemId: string, surfaceId: string): Promise<void> => {
    const snapshot = await readProcessSurfaceSnapshot(controlInstanceId, systemId, surfaceId)
    values = new Map(snapshot.values.map(value => [value.path, value]))
  }

  const updateWidgetPosition = (
    widgetId: string,
    position: ProcessSurfaceWidgetPosition,
    commit: boolean,
  ): void => {
    const currentSurface = surface
    const systemId = loadedSystemId
    if (!currentSurface || !systemId) return
    const next = { ...widgetPositions, [widgetId]: position }
    widgetPositions = next
    if (commit) {
      storeProcessSurfaceLayout({
        controlInstanceId,
        systemId,
        surfaceId: currentSurface.id,
        layout: next,
      })
    }
  }

  runOnMount(() => {
    let cancelled = false
    let interval: ReturnType<typeof setInterval> | null = null

    const load = async (): Promise<void> => {
      try {
        loading = true
        error = null
        const systemId = systemIdFor(object)
        const surfaces = await listProcessSurfaces(controlInstanceId, systemId)
        const first = surfaces[0]
        if (!first) throw new Error(`no process displays are available for ${systemId}`)
        const nextSurface = await readProcessSurface(controlInstanceId, systemId, first.id)
        if (cancelled) return
        loadedSystemId = systemId
        surface = nextSurface
        widgetPositions = readProcessSurfaceLayout({
          controlInstanceId,
          systemId,
          surfaceId: nextSurface.id,
        })
        await refreshSnapshot(systemId, first.id)
        if (cancelled) return
        const refreshSafely = async (): Promise<void> => {
          try {
            await refreshSnapshot(systemId, first.id)
          } catch (err) {
            error = err instanceof Error ? err.message : String(err)
          }
        }
        interval = setInterval(() => {
          void refreshSafely()
        }, 1_000)
      } catch (err) {
        if (!cancelled) error = err instanceof Error ? err.message : String(err)
      } finally {
        if (!cancelled) loading = false
      }
    }

    void load()

    return () => {
      cancelled = true
      if (interval !== null) clearInterval(interval)
    }
  })
</script>

<ModalShell
  title="{object.label} Process Display"
  description="Live process overview assembled from the process-plant surface definition."
  {close}
  size="large"
>
  {#if loading}
    <div class="process-surface-message">Loading process display...</div>
  {:else if error}
    <div class="process-surface-error">{error}</div>
  {:else if surface}
    <ProcessSurfaceRenderer
      {surface}
      {values}
      {widgetPositions}
      onWidgetPositionChange={updateWidgetPosition}
    />
  {:else}
    <div class="process-surface-error">Process display did not load.</div>
  {/if}
</ModalShell>
