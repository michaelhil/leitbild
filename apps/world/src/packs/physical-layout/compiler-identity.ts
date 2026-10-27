// An incompatible installed compiler refuses retained Designs; it never silently rebuilds them with a different algorithm.
export const physicalCompilerFiles = ["compile-scene.ts", "family-solid.ts", "math.ts", "mesh.ts", "solid.ts", "source.ts"] as const
export const physicalCompilerRef = { id: 'physical-layout-native', digest: '89eaa4dc19d7550a08e99e1d903fba58a962a639853b7764633f3bfeb7272bf2' } as const

// The original native artifact stays byte-identical for Runs that admitted it.
// The expanded artifact explicitly pins its complete dependency closure instead
// of interpreting an old Design with a mutable current compiler.
export const campusPhysicalCompilerFiles = [...physicalCompilerFiles, 'campus/compile-scene.ts', 'campus/families.ts', 'campus/solid.ts', 'campus/source.ts', 'campus/footprints.ts'] as const
export const campusPhysicalCompilerRef = { id: 'physical-layout-native-campus', digest: '4d7ac76a20a7d0abf7da1503bc795d5f50fb326fa31b904745cd027b7312e854' } as const

// Explicit recovered appearance/scope profile. Frozen native artifacts above stay exact.
export const explorerPhysicalCompilerFiles = ['explorer/source.ts', 'explorer/circulation.ts', 'explorer/mesh.ts', 'explorer/turbine-families.ts', 'explorer/architecture.ts', 'explorer/families.ts', 'explorer/solid.ts', 'explorer/compile-scene.ts', 'math.ts', '../scope-manifest.ts', '../applicability.ts'] as const
export const explorerPhysicalCompilerRef = { id: 'physical-layout-native-explorer', digest: '743047de52fe80efb06f9c9e2a2aedb2cf216482a97ef8f4873a7917737cbfe7' } as const

// New architecture recipes and drafting presentation keep every earlier closure exact.
export const architecturePhysicalCompilerFiles = [...explorerPhysicalCompilerFiles, 'architecture/source.ts', 'architecture/solid.ts', 'architecture/compile-scene.ts'] as const
export const architecturePhysicalCompilerRef = { id: 'physical-layout-native-architecture', digest: '96e82c37da017162c4f768eb37db11b8e38f513355a2a9ba2052b453baa156f8' } as const

// Explicit vector drafting extends the retained physical architecture without
// reinterpreting earlier source/compiler pairs.
export const draftingPhysicalCompilerFiles = [...architecturePhysicalCompilerFiles, 'drafting/source.ts', 'drafting/primitives.ts', 'drafting/family-plan.ts', 'drafting/architecture-plan.ts', 'drafting/compile-scene.ts', 'drafting/solid.ts', 'drafting/foundation.ts', 'drafting/frame.ts', 'drafting/orientation.ts', 'drafting/section-plan.ts', 'routing/source.ts', 'routing/route.ts', 'routing/search.ts', 'routing/round.ts', 'routing/vector.ts', 'routing/self-clearance.ts', 'routing/compile.ts'] as const
export const draftingPhysicalCompilerRef = { id: 'physical-layout-native-drafting', digest: 'cc14f7e2007beb21f0bc8bbba0d7211e6ef028ceef042774ba2e8aaf6b388df8' } as const
