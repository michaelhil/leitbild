import { expect, test } from 'bun:test'
import { runFuelRelocation } from './reference-design-fuel-relocation.ts'

test('relocation requires an actual connected physical-fuel boundary record', async () => {
  for (const artifact of ['{}', '{"scope":"nominal"}', JSON.stringify({
    scope:'connected physical lattice/grid reference plus reciprocal steady fresh-rod evaluation; no radial fuel transient or fuel qualification',
    radial:{}, connected:{physicalCoreInputSha256:'present'},
  })]) await expect(runFuelRelocation('', artifact, 'unused-python')).rejects.toThrow('Expected reviewed connected physical-fuel artifact')
})
