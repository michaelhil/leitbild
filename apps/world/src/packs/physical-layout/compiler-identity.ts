// An incompatible installed compiler refuses retained Designs; it never silently rebuilds them with a different algorithm.
export const physicalCompilerFiles = ["compile-scene.ts", "family-solid.ts", "math.ts", "mesh.ts", "solid.ts", "source.ts"] as const
export const physicalCompilerRef = { id: 'physical-layout-native', digest: '89eaa4dc19d7550a08e99e1d903fba58a962a639853b7764633f3bfeb7272bf2' } as const

// The original native artifact stays byte-identical for Runs that admitted it.
// The expanded artifact explicitly pins its complete dependency closure instead
// of interpreting an old Design with a mutable current compiler.
export const campusPhysicalCompilerFiles = [...physicalCompilerFiles, 'campus/compile-scene.ts', 'campus/families.ts', 'campus/solid.ts', 'campus/source.ts', 'campus/footprints.ts'] as const
export const campusPhysicalCompilerRef = { id: 'physical-layout-native-campus', digest: '4d7ac76a20a7d0abf7da1503bc795d5f50fb326fa31b904745cd027b7312e854' } as const
