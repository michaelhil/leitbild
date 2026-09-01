import { processPlantUnitOverviewDisplayForGraph } from './displays/reference-unit-overview.ts'
import type { ProcessPlantCatalogContribution } from './catalog-contributions.ts'

export const processPlantPwrReferenceCredibilityEvidenceId = 'process-plant.pwr.reference.credibility'

export const processPlantPwrReferenceCatalogContribution: ProcessPlantCatalogContribution = {
  id: 'process-plant.pwr-reference',
  displays: [{
    id: 'unit-overview',
    title: 'Unit overview',
    description: 'Reference operating overview generated from the Plant graph and its published display profile.',
    display: config => processPlantUnitOverviewDisplayForGraph(config.graph),
  }],
  credibilityEvidence: [{
    id: processPlantPwrReferenceCredibilityEvidenceId,
    title: 'PWR reference credibility targets',
    description: 'Source-backed operational target envelopes for reference PWR transients and accident families.',
    scope: 'Operational/training credibility for the process-plant PWR reference family; not licensing-basis safety analysis.',
    generatedFromCommand: 'bun run process-plant:credibility',
    appliesToGraph: graph => String(graph.specId).startsWith('process-plant.pwr.reference.'),
    artifacts: [
      {
        id: 'summary',
        title: 'Target summary JSON',
        language: 'json',
        contentType: 'application/json',
        path: 'docs/assets/process-plant-pwr-credibility-summary.json',
      },
      {
        id: 'report',
        title: 'Target report SVG',
        language: 'svg',
        contentType: 'image/svg+xml',
        path: 'docs/assets/process-plant-pwr-credibility-report.svg',
      },
    ],
  }],
}
