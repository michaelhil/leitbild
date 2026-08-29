declare module '*.svelte' {
  import type { Component } from 'svelte'
  const component: Component
  export default component
}

declare const __LEITBILD_VERSION__: string
