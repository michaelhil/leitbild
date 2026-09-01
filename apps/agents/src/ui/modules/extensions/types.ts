import type { PostRenderProcessor } from './post-render-registry.ts'

export interface PanelSpec {
  readonly id: string
  readonly title: string
  readonly mount: (host: HTMLElement) => void
  readonly unmount?: () => void
}

export interface ExtensionAPI {
  readonly addPostRenderProcessor: (name: string, fn: PostRenderProcessor) => void
  readonly removePostRenderProcessor: (name: string) => void
  readonly registerPanel: (spec: PanelSpec) => () => void
}

export interface UIExtension {
  readonly name: string
  readonly mount: (api: ExtensionAPI) => Promise<void>
  readonly unmount: () => Promise<void>
}
