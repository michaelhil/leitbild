<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import PhysicalExplorer from './PhysicalExplorer.svelte'
  let props: Omit<ComponentProps<typeof PhysicalExplorer>, 'host'> = $props()
</script>

<PhysicalExplorer {...props} host="map" />
