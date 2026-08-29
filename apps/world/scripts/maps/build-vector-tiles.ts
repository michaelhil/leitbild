import { $ } from 'bun'
import { dirname, join } from 'node:path'
import { createMapCapabilityManifest } from '../../src/map/capabilities.ts'
import { createLeitbildMapStyle } from '../../src/map/style.ts'
import { createMapPipelineConfig, planetilerDownloadUrl } from './config.ts'

const config = createMapPipelineConfig()
const downloadUrl = planetilerDownloadUrl(config.planetilerVersion)
const outputTmpPath = join(config.buildDir, 'norway.pmtiles')
const javaMaxHeap = process.env.LEITBILD_PLANETILER_JAVA_XMX ?? '3g'

await $`mkdir -p ${dirname(config.planetilerJarPath)} ${config.buildDir} ${config.releaseDir}`
await $`test -s ${config.sourcePath}`
await $`java -version`
await $`sh -c ${`test -s "${config.planetilerJarPath}" || curl -fL --retry 3 --connect-timeout 20 "${downloadUrl}" -o "${config.planetilerJarPath}"`}`

await $`java ${`-Xmx${javaMaxHeap}`} -jar ${config.planetilerJarPath} openmaptiles --osm-path=${config.sourcePath} --output=${outputTmpPath} --only-layers=landcover,landuse,water,waterway,building,transportation,transportation_name,poi,aeroway,boundary,place --download --force`

await $`test -s ${outputTmpPath}`
await $`mv ${outputTmpPath} ${config.outputPath}`
await Bun.write(join(config.releaseDir, 'capabilities.json'), `${JSON.stringify(createMapCapabilityManifest(), null, 2)}\n`)
await Bun.write(join(config.releaseDir, 'style.json'), `${JSON.stringify(createLeitbildMapStyle(), null, 2)}\n`)
await Bun.write(join(config.releaseDir, 'build.json'), `${JSON.stringify({
  buildId: config.buildId,
  builtAt: new Date().toISOString(),
  sourceUrl: config.sourceUrl,
  sourcePath: config.sourcePath,
  planetilerVersion: config.planetilerVersion,
  javaMaxHeap,
  profile: 'planetiler-openmaptiles',
  outputPath: config.outputPath,
}, null, 2)}\n`)

console.log(`Built vector tile release at ${config.releaseDir}`)
