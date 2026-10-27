import {admitDraftingArtifacts} from './admit-drafting-artifacts.ts'
await admitDraftingArtifacts([
  {stem:'pwr-full-unit-drafting',requirementStem:'pwr-full-unit-explorer',revision:'pwr-full-unit-20261027-r4'},
  {stem:'pwr-campus-drafting',requirementStem:'pwr-campus-explorer',revision:'pwr-campus-20261027-r4'},
],Bun.argv.includes('--check'))
