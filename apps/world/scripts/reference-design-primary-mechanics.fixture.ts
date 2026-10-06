/** TEST ONLY uniform-density structural fixture, separate from native preparation. */
import { currentPhysicalPrimaryGeometry } from './reference-design-primary-physical-geometry'
import type { CurrentPrimaryGraphInput } from './reference-design-primary-mechanics'

export async function currentPrimaryGraphFixture(wiki: string) {
  const physical = await currentPhysicalPrimaryGeometry(wiki)
  const rho = 997
  const masses = Object.fromEntries(Object.entries(physical.volumes).map(([id, V]) => [id, {
    mass_kg: rho * V, massRate_kg_s: 0, density_kg_m3: rho, densityRate_kg_m3_s: 0,
  }]))
  const input: CurrentPrimaryGraphInput = { ...physical.input, masses,
    snapshotIdentity: 'TEST ONLY uniform997kg/m3 cold structural snapshot; no EOS/native-original qualification' }
  const { volumes: _volumes, physicalInputs: _physicalInputs, hydraulicBasis: _hydraulicBasis, ...geometry } = physical
  return { ...geometry, input,
    scope: 'Actual current physical records, fresh fully inserted stationary geometry; uniform-density structural fixture only. No EOS/native original preparation, heated cohort homogeneity or installed complete-primary admission.' }
}
