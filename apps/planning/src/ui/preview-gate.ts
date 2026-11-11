// One solver runs at a time in Planning, for Generate and for edit previews alike. While a Generate the
// person started is running, a preview waits here and runs when Generate ends, so the screen never shows
// the Module's "solver busy" for the person's own run. Only the latest preview asked for is kept.
import type { Edit } from '../plan/edit-schema.ts'

export interface HeldPreview { readonly edits: readonly Edit[]; readonly label: string }

export const createPreviewGate = () => {
  let generating = false
  let held: HeldPreview | null = null
  return {
    /** A Generate started: previews wait from now on. */
    start: (): void => { generating = true },
    /** Whether a preview may run now; if not, it is held (replacing any held before). */
    request: (preview: HeldPreview): boolean => {
      if (!generating) return true
      held = preview
      return false
    },
    /** Generate ended: the held preview, if any, to run now. */
    end: (): HeldPreview | null => {
      generating = false
      const next = held
      held = null
      return next
    },
    held: (): HeldPreview | null => held,
  }
}
