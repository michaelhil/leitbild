import {admitDraftingArtifacts} from './admit-drafting-artifacts.ts'
await admitDraftingArtifacts([
 {stem:'pwr-full-unit-manifold',requirementStem:'pwr-full-unit-connected',revision:'pwr-full-unit-20261028-r6'},
 {stem:'pwr-campus-manifold',requirementStem:'pwr-campus-connected',revision:'pwr-campus-20261029-r7'},
],Bun.argv.includes('--check'))
