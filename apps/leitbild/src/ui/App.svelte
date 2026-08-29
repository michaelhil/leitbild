<script lang="ts">
  import type { Component } from 'svelte'
  import { parseControlSurfaceRoute } from './control-instance-route.ts'
  import { runOnMount } from './svelte-lifecycle.svelte.ts'

  type RouteComponent = Component

  let Route = $state<RouteComponent | null>(null)
  let status = $state('Starting')

  const loadRoute = async (): Promise<void> => {
    try {
      const route = parseControlSurfaceRoute(location.pathname)
      if (route.mode === 'picker') {
        const module = await import('./routes/InstancePickerRoute.svelte')
        Route = module.default
        return
      }
      const module = await import('./routes/ControlSurfaceRoute.svelte')
      Route = module.default
    } catch (err) {
      status = err instanceof Error ? err.message : 'Unable to read route'
    }
  }

  runOnMount(() => {
    void loadRoute()
  })
</script>

{#if Route}
  <Route />
{:else}
  <div class="boot-shell">{status}</div>
{/if}
