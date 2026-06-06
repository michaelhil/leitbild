import { pressurizedWaterReactorSixLoopPlantSpec } from './specs/pressurized-water-reactor-6-loop.ts'
import { pressurizedWaterReactorPlantSpec } from './specs/pressurized-water-reactor.ts'
import {
  assemblePwrReferencePlantGraph,
  processPlantPwrReferenceAssemblyRef,
  pwrReferenceGraphFragmentEntries,
  pwrReferenceGraphFragmentInstancePresetEntries,
} from './assembly/pwr-reference-assembly.ts'
import type { ProcessPlantCatalogContribution } from './catalog-contributions.ts'

export const processPlantPressurizedWaterReactorGraphRef = 'process-plant.pressurized-water-reactor.v1'
export const processPlantPressurizedWaterReactorSixLoopGraphRef = 'process-plant.pressurized-water-reactor-6-loop.v1'

export const processPlantPwrReferenceCatalogContribution: ProcessPlantCatalogContribution = {
  id: 'process-plant.pwr-reference',
  graphSpecs: [{
    ref: processPlantPressurizedWaterReactorGraphRef,
    graph: () => pressurizedWaterReactorPlantSpec,
  }, {
    ref: processPlantPressurizedWaterReactorSixLoopGraphRef,
    graph: () => pressurizedWaterReactorSixLoopPlantSpec,
  }],
  assemblies: [{
    ref: processPlantPwrReferenceAssemblyRef,
    assemble: assemblePwrReferencePlantGraph,
  }],
  graphFragments: pwrReferenceGraphFragmentEntries,
  graphFragmentInstancePresets: pwrReferenceGraphFragmentInstancePresetEntries,
}
