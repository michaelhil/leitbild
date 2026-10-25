<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import PhysicalExplorer from './PhysicalExplorer.svelte'
  type Props = Omit<ComponentProps<typeof PhysicalExplorer>, 'host' | 'map' | 'active'> & { readonly onback: () => void }
  let props: Props = $props()
</script>

<section class="layout-browser" aria-label="Physical layout browser">
  <PhysicalExplorer {...props} host="browser" />
</section>

<style>
  .layout-browser { position: fixed; inset: 0; z-index: 10; overflow: hidden; background: var(--panel); color: var(--text); }
</style>
