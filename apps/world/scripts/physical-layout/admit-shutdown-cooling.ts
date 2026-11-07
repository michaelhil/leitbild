import { admitDraftingArtifacts } from './admit-drafting-artifacts.ts'

// Current authored source, correspondence, coverage and requirements are
// the inputs. Git retains the original installation and its earlier baseline.
await admitDraftingArtifacts([
  { stem: 'pwr-full-unit-shutdown-cooling', revision: 'pwr-full-unit-20261030-r10' },
  { stem: 'pwr-campus-shutdown-cooling', revision: 'pwr-campus-20261030-r12' },
], Bun.argv.includes('--check'))
