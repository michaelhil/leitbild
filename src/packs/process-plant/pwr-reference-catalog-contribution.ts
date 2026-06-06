import { pressurizedWaterReactorSixLoopPlantSpec } from './specs/pressurized-water-reactor-6-loop.ts'
import { pressurizedWaterReactorPlantSpec } from './specs/pressurized-water-reactor.ts'
import {
  assemblePwrReferencePlantGraph,
  processPlantPwrReferenceAssemblyRef,
  pwrReferenceGraphFragmentEntries,
  pwrReferenceGraphFragmentInstancePresetEntries,
} from './assembly/pwr-reference-assembly.ts'
import {
  pressurizedWaterReactorReferenceIc,
  pressurizedWaterReactorReferenceIcFor,
  pressurizedWaterReactorReferenceIcForGraph,
  pressurizedWaterReactorSixLoopReferenceIc,
  processPlantPressurizedWaterReactorIcRef,
  processPlantPressurizedWaterReactorSixLoopIcRef,
  processPlantPwrReferenceGraphIcRef,
} from './specs/reference-ic.ts'
import { referenceLoopLettersForCount } from './specs/reference-loop.ts'
import { processPlantUnitOverviewSurfaceForGraph } from './surfaces/reference-unit-overview.ts'
import type { ProcessPlantCatalogContribution } from './catalog-contributions.ts'

export const processPlantPressurizedWaterReactorGraphRef = 'process-plant.pressurized-water-reactor.v1'
export const processPlantPressurizedWaterReactorSixLoopGraphRef = 'process-plant.pressurized-water-reactor-6-loop.v1'

const pwrReferenceIcRefPattern = /^process-plant\.pwr\.reference\.(\d+)-loop\.ic\.v2$/u

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
  icConfigs: [{
    ref: processPlantPressurizedWaterReactorIcRef,
    config: () => pressurizedWaterReactorReferenceIc,
  }, {
    ref: processPlantPressurizedWaterReactorSixLoopIcRef,
    config: () => pressurizedWaterReactorSixLoopReferenceIc,
  }],
  dynamicIcConfigs: [{
    id: 'process-plant.pwr-reference.loop-count-ic',
    refPattern: 'process-plant.pwr.reference.<loopCount>-loop.ic.v2',
    description: 'Reference PWR I&C generated for loop counts 2-26.',
    matches: (icRef: string) => pwrReferenceIcRefPattern.test(icRef),
    config: (icRef: string) => {
      const match = pwrReferenceIcRefPattern.exec(icRef)
      if (match === null) throw new Error(`unknown process plant icRef: ${icRef}`)
      const loopCount = Number(match[1])
      return pressurizedWaterReactorReferenceIcFor(referenceLoopLettersForCount(loopCount))
    },
  }],
  graphIcConfigs: [{
    ref: processPlantPwrReferenceGraphIcRef,
    configForGraph: pressurizedWaterReactorReferenceIcForGraph,
  }],
  surfaces: [{
    id: 'unit-overview',
    surface: config => processPlantUnitOverviewSurfaceForGraph(config.graph),
  }],
}
