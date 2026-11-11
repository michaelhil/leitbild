import type { WriteResult } from './api.ts'

/** A previewed edit: the Module's answer, or its refusal in words. */
export interface Preview {
  readonly label: string
  readonly result: WriteResult | null
  readonly refusal: { readonly text: string; readonly needsAuthority: boolean; readonly nearestAllowed: string | null } | null
  /** Known on the screen already: this change weakens a hard rule, so it asks who agreed before saving. */
  readonly asks: string | null
}
