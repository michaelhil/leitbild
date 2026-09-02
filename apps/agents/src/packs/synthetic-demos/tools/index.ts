// Bundled demo tools — registered into the shared tool registry at boot
// (see bootstrap.ts). They do not require a separate Pack installation.
//
// Biometrics tools (used by the Biometrics Demo) are NOT bundled here —
// they remain in the leitbild-biometrics registry pack because their
// browser-side widget code has its own install lifecycle; the demo modal
// triggers a pack-install on first launch.

import type { Tool } from '../../../core/types/tool.ts'
import { norwayPlatformsTool } from './norway-platforms.ts'

export const BUNDLED_DEMO_TOOLS: ReadonlyArray<Tool> = [
  norwayPlatformsTool,
]
