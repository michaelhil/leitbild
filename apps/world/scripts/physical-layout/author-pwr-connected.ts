import {createPwrConnectedUnitArtifacts,createPwrConnectedCampusArtifacts} from '../../src/packs/physical-layout/authoring/pwr-connected.ts'
const check=Bun.argv.includes('--check')
for(const[stem,create]of[['pwr-full-unit-connected',createPwrConnectedUnitArtifacts],['pwr-campus-connected',createPwrConnectedCampusArtifacts]]as const){
  const artifacts=create()
  for(const[facet,value]of Object.entries(artifacts)){
    const target=new URL(`../../src/packs/physical-layout/${stem}.${facet}.json`,import.meta.url),text=`${JSON.stringify(value,null,2)}\n`
    if(check){if(await Bun.file(target).text()!==text)throw Error(`Stale connected source: ${stem}/${facet}`)}else await Bun.write(target,text)
  }
}
