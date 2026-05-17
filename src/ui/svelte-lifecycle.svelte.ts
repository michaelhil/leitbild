import { untrack } from 'svelte'

type Cleanup = () => void

export const runOnMount = (setup: () => void | Cleanup): void => {
  $effect(() => untrack(setup))
}
