import { expect, test } from 'bun:test'
import { ld01UnitArtifactEnv } from '../src/packs/process-plant/engine/artifact.ts'

// Production installs no LD-01 native artifact. There World offers no LD-01 procedure and refuses an LD-01 Plant
// explicitly at creation; nothing falls back to the TS PWR. (The refusal of a Run's Plant is in process-plant-ld01-shell.)
test('without a native artifact, World lists no LD-01 procedure source and resolves no LD-01 Plant Model', async () => {
  const saved = process.env[ld01UnitArtifactEnv]
  delete process.env[ld01UnitArtifactEnv]
  try {
    const { procedureSources } = await import('../src/procedure-sources.ts')
    expect(procedureSources.map(source => source.sourceId)).toEqual(['leitbild'])
    const { compileProcessPlant } = await import('../src/packs/process-plant/plant-compiler.ts')
    expect(() => compileProcessPlant({ id: 'plant:ld01-inert', model: { ref: 'process-plant.ld01', parameters: {} }, operatingPoint: { ref: 'process-plant.ld01.s3-settled' }, automation: { ref: 'process-plant.ld01.kernel' } }))
      .toThrow('the LD-01 native engine is not installed here')
  } finally {
    if (saved !== undefined) process.env[ld01UnitArtifactEnv] = saved
  }
})
