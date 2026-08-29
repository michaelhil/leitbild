<script lang="ts">
  import {
    deleteSimulationRun,
    listSimulationRuns,
    listScenarios,
  } from '../simulation-run-client.ts'
  import {
    pathForNewSimulationRun,
    pathForSimulationRun,
  } from '../simulation-run-route.ts'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import RunPicker from '../RunPicker.svelte'
  import type { SimulationRunSummary, ScenarioListItem } from '../types.ts'
  import { parseControlSurfaceRoute } from '../simulation-run-route.ts'

  const route = parseControlSurfaceRoute(location.pathname)
  if (route.mode !== 'run-picker') throw new Error('Workspace run picker route expected')
  const workspaceId = route.workspaceId

  let runs = $state<ReadonlyArray<SimulationRunSummary>>([])
  let scenarios = $state<ReadonlyArray<ScenarioListItem>>([])
  let status = $state('Loading')

  const loadRuns = async (): Promise<void> => {
    const body = await listSimulationRuns()
    runs = body.simulationRuns
  }

  const loadScenarios = async (): Promise<void> => {
    const body = await listScenarios()
    scenarios = body.scenarios
  }

  const loadPickerData = async (): Promise<void> => {
    status = 'Loading'
    try {
      await Promise.all([loadScenarios(), loadRuns()])
      status = 'Ready'
    } catch (err) {
      status = err instanceof Error ? err.message : 'Unable to load scenarios'
    }
  }

  const deleteScenarioRun = async (simulationRun: SimulationRunSummary): Promise<void> => {
    if (simulationRun.websocketClientCount > 0) {
      status = `Cannot delete ${simulationRun.id}: users are connected`
      return
    }
    const confirmed = window.confirm(`Delete run ${simulationRun.id}? This stops the run and removes its persisted state.`)
    if (!confirmed) return
    status = 'Deleting run'
    try {
      await deleteSimulationRun(simulationRun.id)
      await loadRuns()
      status = 'Ready'
    } catch (err) {
      status = err instanceof Error ? err.message : 'simulation run delete failed'
    }
  }

  runOnMount(() => {
    void loadPickerData()
  })
</script>

<RunPicker
  {scenarios}
  {runs}
  {status}
  newSimulationRunPath={(scenarioId) => pathForNewSimulationRun(workspaceId, scenarioId)}
  simulationRunPath={(simulationRunId) => pathForSimulationRun(workspaceId, simulationRunId)}
  deleteSimulationRun={deleteScenarioRun}
/>
