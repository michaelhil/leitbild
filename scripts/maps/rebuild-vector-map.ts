const buildId = process.env.LEITBILD_MAP_BUILD_ID ?? new Date().toISOString().replaceAll(':', '').replaceAll('.', '').replace('T', '-').replace('Z', 'Z')
process.env.LEITBILD_MAP_BUILD_ID = buildId

await import('./download-osm.ts')
await import('./install-map-fonts.ts')
await import('./build-vector-tiles.ts')
await import('./promote-vector-tiles.ts')

console.log(`Rebuilt and promoted vector map build ${buildId}`)
