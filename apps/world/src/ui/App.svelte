<script lang="ts">
  import type { Component } from 'svelte'
  import { parseControlSurfaceRoute } from './simulation-run-route.ts'
  import { runOnMount } from './svelte-lifecycle.svelte.ts'
  import { configureActiveWorkspace } from './workspace-context.ts'

  type RouteComponent = Component

  let Route = $state<RouteComponent | null>(null)
  let status = $state('Starting')

  const loadRoute = async (): Promise<void> => {
    try {
      const route = parseControlSurfaceRoute(location.pathname)
      configureActiveWorkspace(route.workspaceId)
      if (route.mode === 'run-picker') {
        const module = await import('./routes/RunPickerRoute.svelte')
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

<a class="workspace-back" href="/">Workspaces</a>

{#if Route}
  <Route />
{:else}
  <div class="boot-shell">{status}</div>
{/if}
