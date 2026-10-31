import { createPwrExplorerUnitArtifacts, createPwrExplorerCampusArtifacts } from '../../src/packs/physical-layout/authoring/pwr-explorer.ts'

for(const [name,create] of [['pwr-full-unit-explorer',createPwrExplorerUnitArtifacts],['pwr-campus-explorer',createPwrExplorerCampusArtifacts]] as const){
  const artifacts=create()
  for(const facet of ['source','bindings','coverage'] as const){
    const path=new URL(`../../src/packs/physical-layout/${name}.${facet}.json`,import.meta.url),text=`${JSON.stringify(artifacts[facet],null,2)}\n`
    if(process.argv.includes('--check')){if(await Bun.file(path).text()!==text)throw new Error(`Regenerate ${name}.${facet}.json from its explorer authoring source`)}
    else await Bun.write(path,text)
  }
  console.log(`${name}: ${artifacts.source.elements.length} elements, ${artifacts.bindings.length} correspondences`)
}
