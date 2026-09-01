import { apiFetch } from "../api-client.ts"
// UI extension mount layer (Path C).
//
// A Pack declares `uiExtensions: ["biometrics"]` in its pack.json. The server
// surfaces this verbatim in /packs (list_packs tool response). The browser
// unions the declared names across installed packs and reconciles them against
// KNOWN_UI_EXTENSIONS — mounting / unmounting as the union changes.
//
// Path C invariants:
//   - The pack contributes only the *declaration*. The implementation lives
//     in core, gated on the declaration.
//   - Unknown declarations are reported loudly: reviewed browser code must
//     exist before a Pack can activate a UI extension.
//   - mount() is async because v1 lazy-imports heavy modules (widget + panel)
//     so the user pays nothing for unused extensions.
//   - unmount() must release every resource the extension acquired —
//     post-render processors, settings panels, in-flight captures, etc.
//
// Adding a new extension to KNOWN_UI_EXTENSIONS is the only change required
// in this file when a new module ships. The corresponding pack just declares
// the matching name.

import {
  addPostRenderProcessor,
  removePostRenderProcessor,
} from './post-render-registry.ts'
import type { ExtensionAPI, UIExtension } from './types.ts'
export type { ExtensionAPI, PanelSpec, UIExtension } from './types.ts'

// Panel registration is lightweight — the panel renderer (Settings nav) polls
// this list. Keeps the API surface in this file rather than reaching into
// settings-nav internals from extension code.
interface PanelEntry {
  readonly id: string
  readonly title: string
  readonly mount: (host: HTMLElement) => void
  readonly unmount?: () => void
}
const panels = new Map<string, PanelEntry>()

export const listExtensionPanels = (): ReadonlyArray<PanelEntry> => [...panels.values()]

const buildApi = (): ExtensionAPI => ({
  addPostRenderProcessor,
  removePostRenderProcessor,
  registerPanel: (spec) => {
    panels.set(spec.id, spec)
    notifyPanelsChanged()
    return () => {
      const e = panels.get(spec.id)
      try { e?.unmount?.() } catch { /* ignore */ }
      panels.delete(spec.id)
      notifyPanelsChanged()
    }
  },
})

const panelsChangedListeners = new Set<() => void>()
const notifyPanelsChanged = (): void => {
  for (const l of panelsChangedListeners) {
    try { l() } catch { /* ignore */ }
  }
}
export const onExtensionPanelsChanged = (cb: () => void): (() => void) => {
  panelsChangedListeners.add(cb)
  return () => panelsChangedListeners.delete(cb)
}

// === Known extensions ========================================================
// Each entry is a thunk returning a UIExtension. The thunk is invoked lazily
// the first time the extension is mounted, so the import graph for unused
// extensions stays cold. v1 lazy-imports the heavy modules inside mount().
type ExtensionThunk = () => Promise<UIExtension>

const KNOWN_UI_EXTENSIONS: Record<string, ExtensionThunk> = {
  biometrics: async () => (await import('./biometrics.ts')).createBiometricsExtension(),
}

// === Reconciliation ==========================================================

interface MountedEntry {
  readonly extension: UIExtension
}
const mounted = new Map<string, MountedEntry>()

// Reconcile mounted extensions against the declared set from the server.
// Idempotent — calling with the same set twice is a no-op.
export const reconcileExtensions = async (declared: ReadonlySet<string>): Promise<void> => {
  // Unmount what's mounted but no longer declared.
  for (const [name, entry] of mounted) {
    if (!declared.has(name)) {
      try { await entry.extension.unmount() } catch (err) {
        console.error(`[extensions] ${name}: unmount failed`, err)
      }
      mounted.delete(name)
    }
  }
  // Mount what's declared but not mounted.
  for (const name of declared) {
    if (mounted.has(name)) continue
    const thunk = KNOWN_UI_EXTENSIONS[name]
    if (!thunk) {
      console.error(`[extensions] ${name}: declared by a Pack but no reviewed browser implementation exists`)
      continue
    }
    try {
      const extension = await thunk()
      await extension.mount(buildApi())
      mounted.set(name, { extension })
    } catch (err) {
      console.error(`[extensions] ${name}: mount failed`, err)
    }
  }
}

// Pull the declared set from the /packs response. Reads Pack entries'
// uiExtensions arrays and unions them. Only actual Packs participate.
export const fetchDeclaredExtensions = async (): Promise<ReadonlySet<string>> => {
  const res = await apiFetch('/packs')
  if (!res.ok) throw new Error(`Pack catalog fetch failed (${res.status})`)
  const body = await res.json() as Array<{ uiExtensions?: ReadonlyArray<string> }>
  const set = new Set<string>()
  for (const p of body) {
    for (const name of p.uiExtensions ?? []) set.add(name)
  }
  return set
}

// Convenience: fetch + reconcile in one call. Used at boot and on every
// `packs_changed` WS event.
export const refreshExtensions = async (): Promise<void> => {
  try {
    await reconcileExtensions(await fetchDeclaredExtensions())
  } catch (error) {
    // Preserve the currently mounted set on transient catalog failures.
    console.error('[extensions] refresh failed; preserving mounted extensions', error)
  }
}
