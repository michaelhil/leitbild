<script lang="ts">
  import type { Shift } from './shift-list.ts'

  // At phone width the schedule is a list, shift by shift: when, what and who.
  let { shifts }: { shifts: readonly Shift[] } = $props()
</script>

<section class="shift-list" aria-labelledby="shift-title">
  <h2 id="shift-title">Shift by shift</h2>
  {#if shifts.length === 0}<p class="hint">Nothing planned yet.</p>{/if}
  {#each shifts as shift, index (index)}
    <h3>{shift.title}</h3>
    <ul>
      {#each shift.entries as entry, entryIndex (entryIndex)}
        <li><span class="when">{entry.when}</span> <span class="what">{entry.mark}: {entry.title}</span> <span class="who">{entry.who}</span></li>
      {/each}
    </ul>
  {/each}
</section>
