<script lang="ts">
  import type { Component } from 'svelte'
  import { loadUiPack } from './pack-loader.ts'
  import type { MapView } from './map-view.ts'
  const { packId, config, workspaceId, center, mapView, onchange }: { packId: string; config: unknown; workspaceId: string; center: readonly [number, number]; mapView: MapView | null; onchange: (value: Record<string, unknown>) => void } = $props()
  let Editor = $state<Component<any> | null>(null)
  let error = $state('')
  $effect(() => {
    const id = packId
    let active = true
    Editor = null; error = ''
    void loadUiPack(id).then(async pack => {
      const module = await pack.ui?.settingsEditor?.()
      if (active) Editor = module?.default ?? null
    }).catch(cause => { if (active) error = String(cause) })
    return () => { active = false }
  })
</script>
{#if error}<p role="alert">{error}</p>{/if}
{#if Editor}<Editor {config} {workspaceId} {center} {mapView} {onchange} />{/if}
