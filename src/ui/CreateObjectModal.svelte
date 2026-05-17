<script lang="ts">
  import type { CreateDraft } from './types.ts'

  export let createDraft: CreateDraft
  export let createObject: () => Promise<void>
  export let cancelCreate: () => void

  const isTrafficDraft = (): boolean =>
    createDraft.objectType.id === 'traffic_road_segment' || createDraft.objectType.id === 'traffic_area'
</script>

<div class="modal-backdrop">
  <form class="modal" on:submit|preventDefault={createObject}>
    <h2>Create new {createDraft.objectType.label}</h2>
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
    <div class="modal-actions">
      <button type="button" on:click={cancelCreate}>Cancel</button>
      <button type="submit" class="primary">Create</button>
    </div>
  </form>
</div>
