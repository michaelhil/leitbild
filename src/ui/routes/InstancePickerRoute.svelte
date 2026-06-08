<script lang="ts">
  import {
    createControlInstance,
    deleteControlInstance,
    listControlInstances,
    listScenarios,
  } from '../control-instance-client.ts'
  import {
    controlInstanceIdForScenarioRun,
    createGeneratedRunId,
    pathForScenarioRun,
  } from '../control-instance-route.ts'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import InstancePicker from '../InstancePicker.svelte'
  import type { ControlInstanceSummary, ScenarioListItem } from '../types.ts'

  let instances = $state<ReadonlyArray<ControlInstanceSummary>>([])
  let scenarios = $state<ReadonlyArray<ScenarioListItem>>([])
  let status = $state('Loading')
  let creatingScenarioId = $state<string | null>(null)

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

  const createScenarioRun = async (scenarioId: string, navigation: 'assign' | 'replace' = 'assign'): Promise<void> => {
    if (creatingScenarioId !== null) return
    creatingScenarioId = scenarioId
    status = 'Creating Control Instance'
    try {
      const runId = createGeneratedRunId()
      const id = controlInstanceIdForScenarioRun(scenarioId, runId)
      const body = await createControlInstance({ id, scenarioId })
      if (body.id !== id) throw new Error(`created control instance ${body.id}, expected ${id}`)
      const nextPath = pathForScenarioRun(scenarioId, runId)
      if (navigation === 'replace') {
        location.replace(nextPath)
        return
      }
      location.href = nextPath
    } catch (err) {
      status = err instanceof Error ? err.message : 'control instance create failed'
      creatingScenarioId = null
    }
  }

  const openScenarioRun = (scenarioId: string, runId: string): void => {
    location.href = pathForScenarioRun(scenarioId, runId)
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
  {creatingScenarioId}
  {createScenarioRun}
  {openScenarioRun}
  {deleteScenarioRun}
/>
