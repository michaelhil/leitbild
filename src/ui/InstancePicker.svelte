<script lang="ts">
  import type { ControlInstanceSummary } from './types.ts'

  export let instances: ReadonlyArray<ControlInstanceSummary>
  export let status: string
  export let createInstance: () => Promise<void>
  export let openInstance: (id: string) => void
</script>

<main class="instance-page">
  <section class="instance-panel">
    <header>
      <div>
        <div class="brand">Leitbild</div>
        <div class="object-meta">{status}</div>
      </div>
      <button class="command-button" on:click={createInstance}>Create Control Instance</button>
    </header>

    {#if instances.length === 0}
      <div class="empty-row">No Control Instances yet</div>
    {:else}
      <div class="instance-list">
        {#each instances as instance (instance.id)}
          <button class="instance-row" on:click={() => openInstance(instance.id)}>
            <span>
              <strong>{instance.id}</strong>
              <span class="object-meta">
                {instance.loaded ? 'Loaded' : 'Persisted'}
                {#if instance.objectCount !== null} · {instance.objectCount} objects{/if}
                {#if instance.snapshotSeq !== null} · seq {instance.snapshotSeq}{/if}
              </span>
            </span>
            <span>Open</span>
          </button>
        {/each}
      </div>
    {/if}
  </section>
</main>
