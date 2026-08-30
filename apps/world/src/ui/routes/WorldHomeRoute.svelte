<script lang="ts">
  import { parseControlSurfaceRoute } from '../simulation-run-route.ts'
  const route = parseControlSurfaceRoute(location.pathname)
  if (route.mode !== 'workspace-home') throw new Error('World Workspace route expected')
</script>

<main class="run-page">
  <section class="run-panel empty-world">
    <h1>World</h1>
    <p>Choose a Scenario or existing Simulation Run from the Workspace home.</p>
    <a class="command-button" href={`/workspaces/${encodeURIComponent(route.workspaceId)}`}>Workspace home</a>
  </section>
</main>
