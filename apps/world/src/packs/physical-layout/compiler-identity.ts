// Exact ordered closure of the drafting compiler used by the two current Designs.
export const draftingPhysicalCompilerFiles = [
  'explorer/source.ts', 'explorer/circulation.ts', 'explorer/mesh.ts', 'explorer/turbine-families.ts', 'explorer/architecture.ts', 'explorer/families.ts', 'explorer/solid.ts', 'explorer/compile-scene.ts', 'math.ts', '../scope-manifest.ts', '../applicability.ts',
  'architecture/source.ts', 'architecture/solid.ts', 'architecture/compile-scene.ts',
  'drafting/source.ts', 'drafting/primitives.ts', 'drafting/family-plan.ts', 'drafting/architecture-plan.ts', 'drafting/compile-scene.ts', 'drafting/solid.ts', 'drafting/foundation.ts', 'drafting/frame.ts', 'drafting/orientation.ts', 'drafting/section-plan.ts', 'routing/source.ts', 'routing/route.ts', 'routing/search.ts', 'routing/round.ts', 'routing/vector.ts', 'routing/self-clearance.ts', 'routing/compile.ts',
] as const
export const draftingPhysicalCompilerRef = { id: 'physical-layout-native-drafting', digest: '738f7a053a2567552490e2c9147d2960a139dd8a8c06a5bfa4b5505d160d51f0' } as const
