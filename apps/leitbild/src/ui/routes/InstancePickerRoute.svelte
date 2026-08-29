<script lang="ts">
  import {
    deleteControlInstance,
    listControlInstances,
    listScenarios,
  } from '../control-instance-client.ts'
  import {
    pathForNewScenarioRun,
    pathForScenarioRun,
  } from '../control-instance-route.ts'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import InstancePicker from '../InstancePicker.svelte'
  import type { ControlInstanceSummary, ScenarioListItem } from '../types.ts'

  let instances = $state<ReadonlyArray<ControlInstanceSummary>>([])
  let scenarios = $state<ReadonlyArray<ScenarioListItem>>([])
  let status = $state('Loading')

  const loadInstances = async (): Promise<void> => {
    const body = await listControlInstances()
    instances = body.controlInstances
  }

  const loadScenarios = async (): Promise<void> => {
    const body = await listScenarios()
    scenarios = body.scenarios
  }

  const loadPickerData = async (): Promise<void> => {
    status = 'Loading'
    try {
      await Promise.all([loadScenarios(), loadInstances()])
      status = 'Ready'
    } catch (err) {
      status = err instanceof Error ? err.message : 'Unable to load scenarios'
    }
  }

  const deleteScenarioRun = async (controlInstance: ControlInstanceSummary): Promise<void> => {
    if (controlInstance.websocketClientCount > 0) {
      status = `Cannot delete ${controlInstance.runId ?? controlInstance.id}: users are connected`
      return
    }
    const confirmed = window.confirm(`Delete run ${controlInstance.runId ?? controlInstance.id}? This stops the run and removes its persisted state.`)
    if (!confirmed) return
    status = 'Deleting run'
    try {
      await deleteControlInstance(controlInstance.id)
      await loadInstances()
      status = 'Ready'
    } catch (err) {
      status = err instanceof Error ? err.message : 'control instance delete failed'
    }
  }

  runOnMount(() => {
    void loadPickerData()
  })
</script>

<InstancePicker
  {scenarios}
  {instances}
  {status}
  newScenarioRunPath={pathForNewScenarioRun}
  scenarioRunPath={pathForScenarioRun}
  {deleteScenarioRun}
/>
