<script lang="ts">
  import ModalShell from './components/ModalShell.svelte'
  import type { PackCreateObjectParameter } from '../core/packs/protocol.ts'
  import type { CreateDraft, CreateParameterValue } from './types.ts'

  interface Props {
    readonly createDraft: CreateDraft
    readonly createObject: (draft: CreateDraft) => Promise<void>
    readonly cancelCreate: () => void
  }

  let { createDraft, createObject, cancelCreate }: Props = $props()
  let label = $state('')
  let parameters = $state<Record<string, CreateParameterValue>>({})

  const parameterDefinitions = $derived(createDraft.objectType.parameters ?? [])

  $effect(() => {
    label = createDraft.label
    parameters = { ...createDraft.parameters }
  })

  const setParameter = (key: string, value: CreateParameterValue): void => {
    parameters = { ...parameters, [key]: value }
  }

  const parameterValue = (parameter: PackCreateObjectParameter): CreateParameterValue =>
    parameters[parameter.key] ?? parameter.defaultValue

  const submitDraft = async (): Promise<void> => {
    await createObject({
      ...createDraft,
      label,
      parameters,
    })
  }
</script>

<ModalShell title="Create new {createDraft.objectType.label}" close={cancelCreate} size="small">
  <form class="modal-form" id="create-object-form" onsubmit={(event) => { event.preventDefault(); void submitDraft() }}>
    <label>
      Name
      <input bind:value={label} />
    </label>
    {#each parameterDefinitions as parameter (parameter.key)}
      <label>
        {parameter.label}
        {#if parameter.kind === 'select'}
          <select
            value={String(parameterValue(parameter))}
            onchange={(event) => setParameter(parameter.key, event.currentTarget.value)}
          >
            {#each parameter.options as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        {:else if parameter.kind === 'number'}
          <input
            type="number"
            min={parameter.min}
            max={parameter.max}
            step={parameter.step}
            value={Number(parameterValue(parameter))}
            oninput={(event) => setParameter(parameter.key, Number(event.currentTarget.value))}
          />
        {:else}
          <input
            value={String(parameterValue(parameter))}
            oninput={(event) => setParameter(parameter.key, event.currentTarget.value)}
          />
        {/if}
      </label>
    {/each}
  </form>
  {#snippet footer()}
    <div class="modal-actions">
      <button type="button" onclick={cancelCreate}>Cancel</button>
      <button type="submit" form="create-object-form" class="primary">Create</button>
    </div>
  {/snippet}
</ModalShell>
