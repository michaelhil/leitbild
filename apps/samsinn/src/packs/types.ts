import type { PackDescriptor } from '@samsinn-leitbild/platform-contracts'

export interface WikiSourceBinding {
  readonly org: string
  readonly repo: string
  readonly branch: string
  readonly procedureDir: string
  readonly indexFile: string
  readonly citationBase: string
  readonly manifestFile?: string
}

export interface WikiRef {
  readonly name: string
  readonly url: string
  readonly source?: WikiSourceBinding
}

/** Strict, application-specific metadata wrapped around the shared Pack Descriptor. */
export interface PackManifest {
  readonly descriptor: PackDescriptor
  readonly wikis: ReadonlyArray<WikiRef>
  readonly uiExtensions: ReadonlyArray<string>
}

/** A validated deployment-scoped Samsinn Pack. Its id is also its tool/skill namespace. */
export interface Pack {
  readonly id: string
  readonly dirPath: string
  readonly manifest: PackManifest
}
