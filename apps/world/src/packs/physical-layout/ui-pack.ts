import type { WorldPackView } from '../../core/packs/protocol.ts'
import { createWorldPackDescriptor } from '../../core/packs/protocol.ts'
import { physicalLayoutPackId } from './model.ts'
import { describePhysicalLayoutScene, loadPhysicalLayoutScene } from './scene.ts'

export const physicalLayoutPackView = {
  descriptor: createWorldPackDescriptor({
    id: physicalLayoutPackId, version: '1.0.0', name: 'Physical Layout',
    description: 'Revision-pinned spaces, architecture and physical equipment correspondence; no duplicate process state or physics runtime.',
    contributions: ['scenario', 'knowledge', 'presentation'],
  }),
  presentation: {
    categories: [{ id: 'physical-layouts', label: 'Physical layouts', emptyLabel: 'No physical layouts', matches: object => object.packId === physicalLayoutPackId, rail: false }],
    presentObject: object => ({
      categoryId: 'physical-layouts', icon: 'building-2', color: 'var(--element-active-color)',
      summary: `${object.label} · illustrative physical layout`, fields: [], mapIconVisible: false,
    }),
  },
  physicalScenes: { describe: describePhysicalLayoutScene, load: loadPhysicalLayoutScene },
} satisfies WorldPackView
