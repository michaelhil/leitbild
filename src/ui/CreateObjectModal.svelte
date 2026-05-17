<script lang="ts">
  import ModalShell from './components/ModalShell.svelte'
  import type { CreateDraft } from './types.ts'

  export let createDraft: CreateDraft
  export let createObject: () => Promise<void>
  export let cancelCreate: () => void

  const isTrafficDraft = (): boolean =>
    createDraft.objectType.id === 'traffic_road_segment' || createDraft.objectType.id === 'traffic_area'
</script>

<ModalShell title="Create new {createDraft.objectType.label}" close={cancelCreate} size="small">
  <form class="modal-form" id="create-object-form" on:submit|preventDefault={createObject}>
    <label>
      Name
      <input bind:value={createDraft.label} />
    </label>
    {#if isTrafficDraft()}
      <label>
        Severity
        <select bind:value={createDraft.trafficSeverity}>
          <option value="low">Low</option>
          <option value="moderate">Moderate</option>
          <option value="high">High</option>
          <option value="blocked">Blocked</option>
        </select>
      </label>
      <label>
        Speed factor
        <input type="number" min="0.05" max="1" step="0.05" bind:value={createDraft.trafficSpeedFactor} />
      </label>
      <label>
        Reason
        <input bind:value={createDraft.trafficReason} />
      </label>
    {/if}
  </form>
  <svelte:fragment slot="footer">
    <div class="modal-actions">
      <button type="button" on:click={cancelCreate}>Cancel</button>
      <button type="submit" form="create-object-form" class="primary">Create</button>
    </div>
  </svelte:fragment>
</ModalShell>
