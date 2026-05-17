import { join } from 'node:path'

export interface MapPipelineConfig {
  readonly rootDir: string
  readonly sourceUrl: string
  readonly sourcePath: string
  readonly planetilerVersion: string
  readonly planetilerJarPath: string
  readonly fontBaseUrl: string
  readonly fontStack: string
  readonly fontsDir: string
  readonly buildId: string
  readonly buildDir: string
  readonly outputPath: string
  readonly releaseDir: string
}

const timestampBuildId = (): string => new Date().toISOString().replaceAll(':', '').replaceAll('.', '').replace('T', '-').replace('Z', 'Z')

export const createMapPipelineConfig = (): MapPipelineConfig => {
  const rootDir = process.env.LEITBILD_MAP_ROOT ?? '/opt/leitbild/maps'
  const buildId = process.env.LEITBILD_MAP_BUILD_ID ?? timestampBuildId()
  const releaseDir = process.env.LEITBILD_MAP_RELEASE_DIR ?? join(rootDir, 'releases', 'leitbild-osm-norway', buildId)
  return {
    rootDir,
    sourceUrl: process.env.LEITBILD_OSM_SOURCE_URL ?? 'https://download.geofabrik.de/europe/norway-latest.osm.pbf',
    sourcePath: process.env.LEITBILD_OSM_SOURCE_PATH ?? join(rootDir, 'sources', 'norway-latest.osm.pbf'),
    planetilerVersion: process.env.LEITBILD_PLANETILER_VERSION ?? 'v0.10.2',
    planetilerJarPath: process.env.LEITBILD_PLANETILER_JAR ?? join(rootDir, 'tools', 'planetiler.jar'),
    fontBaseUrl: process.env.LEITBILD_MAP_FONT_BASE_URL ?? 'https://fonts.openmaptiles.org',
    fontStack: process.env.LEITBILD_MAP_FONT_STACK ?? 'Noto Sans Regular',
    fontsDir: process.env.LEITBILD_MAP_FONTS_DIR ?? join(rootDir, 'fonts'),
    buildId,
    buildDir: process.env.LEITBILD_MAP_BUILD_DIR ?? join(rootDir, 'builds', buildId),
    outputPath: process.env.LEITBILD_MAP_OUTPUT_PATH ?? join(releaseDir, 'norway.pmtiles'),
    releaseDir,
  }
}

export const planetilerDownloadUrl = (version: string): string =>
  `https://github.com/onthegomap/planetiler/releases/download/${version}/planetiler.jar`
