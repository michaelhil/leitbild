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
    sourcePath: 'src/packs/process-plant/specs/pressurized-water-reactor.graph.json',
    graph: () => pressurizedWaterReactorPlantSpec,
  }, {
    ref: processPlantPressurizedWaterReactorSixLoopGraphRef,
    sourcePath: 'src/packs/process-plant/specs/pressurized-water-reactor-6-loop.graph.json',
    graph: () => pressurizedWaterReactorSixLoopPlantSpec,
  }],
  assemblies: [{
    ref: processPlantPwrReferenceAssemblyRef,
    sourcePath: 'src/packs/process-plant/assembly/pwr-reference-assembly.ts',
    assemble: assemblePwrReferencePlantGraph,
  }],
  graphFragments: pwrReferenceGraphFragmentEntries.map(entry => ({
    ...entry,
    sourcePath: 'src/packs/process-plant/assembly/pwr-reference-assembly.ts',
  })),
  graphFragmentInstancePresets: pwrReferenceGraphFragmentInstancePresetEntries.map(entry => ({
    ...entry,
    sourcePath: 'src/packs/process-plant/assembly/pwr-reference-assembly.ts',
  })),
  icConfigs: [{
    ref: processPlantPressurizedWaterReactorIcRef,
    sourcePath: 'src/packs/process-plant/specs/reference-ic.ts',
    config: () => pressurizedWaterReactorReferenceIc,
  }, {
    ref: processPlantPressurizedWaterReactorSixLoopIcRef,
    sourcePath: 'src/packs/process-plant/specs/reference-ic.ts',
    config: () => pressurizedWaterReactorSixLoopReferenceIc,
  }],
  dynamicIcConfigs: [{
    id: 'process-plant.pwr-reference.loop-count-ic',
    refPattern: 'process-plant.pwr.reference.<loopCount>-loop.ic.v2',
    sourcePath: 'src/packs/process-plant/pwr-reference-catalog-contribution.ts',
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
    sourcePath: 'src/packs/process-plant/specs/reference-ic.ts',
    configForGraph: pressurizedWaterReactorReferenceIcForGraph,
  }],
  surfaces: [{
    id: 'unit-overview',
    sourcePath: 'src/packs/process-plant/surfaces/reference-unit-overview.ts',
    surface: config => processPlantUnitOverviewSurfaceForGraph(config.graph),
  }],
}
