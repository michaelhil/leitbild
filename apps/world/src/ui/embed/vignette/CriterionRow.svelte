<script lang="ts">
  import { wholeWords } from './fit-words.ts'
  import type { ReadingLook } from './readout.ts'
  import StateWord from './StateWord.svelte'

  // A criterion on one row (W1.4): its name, those of its checks not yet met,
  // and at the row's end, where every value stands, how many of those that
  // apply are met ("2/5") or its comparison ("113 ≥ 27.8 kg/s") as a state
  // word, active while every check that applies is met. Never coloured: a
  // check not met is what the procedure verifies next, not an alarm. Where
  // room is short the list of those not met gives way first, by whole words
  // (its whole in the row's title and for assistive technology), then the
  // name; the count never does.
  let { look, label }: { look: ReadingLook; label: string } = $props()
</script>

<span class="criterion" title={look.title}>
  <span class="label" aria-label={label} use:wholeWords={label}></span>
  <span class="detail" aria-hidden="true" use:wholeWords={look.detail ?? ''}></span>
  {#if look.detail !== null}<span class="full">{look.detail}</span>{/if}
  <span class="word"><StateWord {look} /></span>
</span>

<style>
  .criterion { display: flex; align-items: center; gap: 6px; min-width: 0; height: var(--row); white-space: nowrap; }
  .label { flex: 0 1 auto; min-width: 3em; overflow: hidden; color: var(--element-neutral-color); }
  .word { flex: none; }
  .detail { flex: 1 1 0; min-width: 0; overflow: hidden; color: var(--element-neutral-color); }
  /* The whole list, read by assistive technology, not shown. */
  .full { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
</style>
