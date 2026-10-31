import { createPwrArchitectureUnitArtifacts, createPwrArchitectureCampusArtifacts } from '../../src/packs/physical-layout/authoring/pwr-architecture.ts'

const check = Bun.argv.includes('--check')
for (const [stem, create] of [['pwr-full-unit-architecture', createPwrArchitectureUnitArtifacts], ['pwr-campus-architecture', createPwrArchitectureCampusArtifacts]] as const) {
  const artifacts = create()
  for (const [facet, value] of Object.entries(artifacts)) {
    const target = new URL(`../../src/packs/physical-layout/${stem}.${facet === 'coverage' ? 'coverage' : facet}.json`, import.meta.url), text = `${JSON.stringify(value, null, 2)}\n`
    if (check) { if (await Bun.file(target).text() !== text) throw new Error(`Stale architecture source: ${stem}/${facet}`) }
    else await Bun.write(target, text)
  }
}
