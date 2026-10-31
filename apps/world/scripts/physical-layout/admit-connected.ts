import {admitDraftingArtifacts} from './admit-drafting-artifacts.ts'
await admitDraftingArtifacts([
  {stem:'pwr-full-unit-connected',requirementStem:'pwr-full-unit-drafting',revision:'pwr-full-unit-20261027-r5'},
  {stem:'pwr-campus-connected',requirementStem:'pwr-campus-drafting',revision:'pwr-campus-20261027-r5'},
],Bun.argv.includes('--check'))
