<script lang="ts">
  import type { CreateDraft } from './types.ts'

  export let createDraft: CreateDraft
  export let createObject: () => Promise<void>
  export let cancelCreate: () => void
</script>

<div class="modal-backdrop">
  <form class="modal" on:submit|preventDefault={createObject}>
    <h2>Create new {createDraft.objectType.label}</h2>
    <label>
      Name
      <input bind:value={createDraft.label} />
    </label>
    <div class="modal-actions">
      <button type="button" on:click={cancelCreate}>Cancel</button>
      <button type="submit" class="primary">Create</button>
    </div>
  </form>
</div>
