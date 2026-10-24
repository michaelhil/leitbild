<script lang="ts">
  import type { ScrollEnds } from './scroll-ends.ts'

  // Over a drawing that scrolls (W4.3), in the frame that holds its scroller:
  // each edge with more to see fades, and a mark there says the drawing
  // continues that way, clear of the scroller's scrollbars.
  let { ends }: { ends: ScrollEnds } = $props()
</script>

<div class="ends" aria-hidden="true" style:right={`${ends.bars.right}px`} style:bottom={`${ends.bars.bottom}px`}>
  {#if ends.left}<span class="fade left"></span><span class="mark left">‹ drawing continues</span>{/if}
  {#if ends.right}<span class="fade right"></span><span class="mark right">drawing continues ›</span>{/if}
  {#if ends.top}<span class="fade top"></span><span class="mark top">drawing continues ↑</span>{/if}
  {#if ends.bottom}<span class="fade bottom"></span><span class="mark bottom">drawing continues ↓</span>{/if}
</div>

<style>
  .ends { position: absolute; z-index: 2; left: 0; top: 0; pointer-events: none; }
  .fade { position: absolute; }
  .fade.left, .fade.right { top: 0; bottom: 0; width: 32px; }
  .fade.top, .fade.bottom { left: 0; right: 0; height: 32px; }
  .fade.left { left: 0; background: linear-gradient(to left, transparent, var(--container-background-color)); }
  .fade.right { right: 0; background: linear-gradient(to right, transparent, var(--container-background-color)); }
  .fade.top { top: 0; background: linear-gradient(to top, transparent, var(--container-background-color)); }
  .fade.bottom { bottom: 0; background: linear-gradient(to bottom, transparent, var(--container-background-color)); }
  .mark { position: absolute; padding: 0 8px; border: 1px solid var(--border-outline-color); border-radius: 12px; background: var(--container-background-color); color: var(--element-active-color); font-size: 12px; line-height: 20px; white-space: nowrap; }
  .mark.left { left: 4px; top: 4px; }
  .mark.right { right: 4px; top: 4px; }
  /* Up and down in the middle of the edge, clear of the marks for left and right. */
  .mark.top { left: 50%; top: 4px; transform: translateX(-50%); }
  .mark.bottom { left: 50%; bottom: 4px; transform: translateX(-50%); }
</style>
