import { z } from 'zod'
import type { PackWorkspaceCapability } from '../../simulation/protocol.ts'
import { physicalCatalogManifestSchema } from './catalog-manifest.ts'
import { physicalDesignChoices, physicalDesignManifest } from './design.ts'
import { physicalDesignRefSchema } from './model.ts'

const profiles = z.enum(['turbine-island', 'campus', 'explorer', 'architecture', 'drafting'])
const listInput = z.object({ profile: profiles.optional(), modelRef: z.string().min(1).optional() }).strict()
const entry = z.object({ design: physicalDesignRefSchema, profile: profiles,
  modelRequirement: z.object({ modelRef: z.string(), modelDigest: z.string() }).strict(),
  ownerRole: z.string(), relatedRoles: z.array(z.string()),
}).strict()
const describeInput = z.object({ design: physicalDesignRefSchema }).strict()
export const physicalLayoutWorkspaceCapabilities: ReadonlyArray<PackWorkspaceCapability> = [{
  id: 'world.physical-layout.designs.list', title: 'List retained Physical Designs',
  description: 'Bounded pre-run list of exact immutable Design pins, profiles, required owner model and member roles. Optional profile/modelRef filters do not load sources, compile geometry, start a Run or wake a renderer. Describe one exact pin before binding Scenario item members.',
  kind: 'query', risk: 'read', idempotent: true, input: listInput, output: z.object({ designs: z.array(entry) }).strict(),
  invoke: async raw => {
    const input = listInput.parse(raw)
    return { designs: physicalDesignChoices().filter(choice => (input.profile === undefined || input.profile === choice.profile) && (input.modelRef === undefined || input.modelRef === choice.modelRequirement.modelRef)) }
  },
}, {
  id: 'world.physical-layout.design.describe', title: 'Describe one retained Physical Design',
  description: 'Reads the exact id/revision/digest manifest: required owner model, member roles and geography, correspondence/compiler/source digests, bounds and any admitted applicability. Does not load source geometry or bindings, compile or render. Unknown or mismatched pins refuse; there is no latest pointer. Existing Runs retain their admitted Design; replacement requires a new Scenario Revision and Run.',
  kind: 'query', risk: 'read', idempotent: true, input: describeInput,
  output: z.object({ manifest: physicalCatalogManifestSchema, application: z.literal('new-scenario-revision'), liveDesignReplacement: z.literal(false) }).strict(),
  invoke: async raw => {
    const { design } = describeInput.parse(raw)
    const manifest = physicalDesignManifest(design)
    return { manifest, application: 'new-scenario-revision', liveDesignReplacement: false }
  },
}]
