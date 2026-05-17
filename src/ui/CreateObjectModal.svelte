<script lang="ts">
  import ModalShell from './components/ModalShell.svelte'
  import type { CreateDraft } from './types.ts'

  interface Props {
    readonly createDraft: CreateDraft
    readonly createObject: (draft: CreateDraft) => Promise<void>
    readonly cancelCreate: () => void
  }

  let { createDraft, createObject, cancelCreate }: Props = $props()
  let label = $state('')
  let trafficSeverity = $state<CreateDraft['trafficSeverity']>(undefined)
  let trafficSpeedFactor = $state<CreateDraft['trafficSpeedFactor']>(undefined)
  let trafficReason = $state<CreateDraft['trafficReason']>(undefined)

  const isTrafficDraft = $derived(
    createDraft.objectType.id === 'traffic_road_segment' || createDraft.objectType.id === 'traffic_area'
  )

  $effect(() => {
    label = createDraft.label
    trafficSeverity = createDraft.trafficSeverity
    trafficSpeedFactor = createDraft.trafficSpeedFactor
    trafficReason = createDraft.trafficReason
  })

  const submitDraft = async (): Promise<void> => {
    await createObject({
      ...createDraft,
      label,
      trafficSeverity,
      trafficSpeedFactor,
      trafficReason,
    })
  }
</script>

<ModalShell title="Create new {createDraft.objectType.label}" close={cancelCreate} size="small">
  <form class="modal-form" id="create-object-form" onsubmit={(event) => { event.preventDefault(); void submitDraft() }}>
    <label>
      Name
      <input bind:value={label} />
    </label>
    {#if isTrafficDraft}
      <label>
        Severity
        <select bind:value={trafficSeverity}>
          <option value="low">Low</option>
          <option value="moderate">Moderate</option>
          <option value="high">High</option>
          <option value="blocked">Blocked</option>
        </select>
      </label>
      <label>
        Speed factor
        <input type="number" min="0.05" max="1" step="0.05" bind:value={trafficSpeedFactor} />
      </label>
      <label>
        Reason
        <input bind:value={trafficReason} />
      </label>
    {/if}
  </form>
  {#snippet footer()}
    <div class="modal-actions">
      <button type="button" onclick={cancelCreate}>Cancel</button>
      <button type="submit" form="create-object-form" class="primary">Create</button>
    </div>
  {/snippet}
</ModalShell>
