import type { PackEmbedContribution } from '../../../core/packs/protocol.ts'

// The Plant's UI the embedded view loads (ui/embed/pack-embed-loader.ts),
// never the World application: its panels draw OpenBridge, which only the
// embed bundle carries (D-03).

const processPlantEmbed: PackEmbedContribution = {
  /** The actions on one element in a display's element faceplate: its proposal, CONTROL and RESETs. */
  elementActions: () => import('./displays/operation/ElementActions.svelte'),
  /** What a drawing marks on the Plant's items: offered controls and pending proposals. */
  elementMarks: () => import('./displays/operation/element-marks.ts'),
}

export default processPlantEmbed
