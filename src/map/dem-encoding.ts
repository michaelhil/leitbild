export type TerrainDemEncoding = 'terrarium' | 'mapbox'

export const decodeTerrariumElevationM = (
  red: number,
  green: number,
  blue: number,
): number =>
  red * 256 + green + blue / 256 - 32_768

export const decodeMapboxElevationM = (
  red: number,
  green: number,
  blue: number,
): number =>
  -10_000 + (red * 256 * 256 + green * 256 + blue) * 0.1

export const decodeDemElevationM = (
  red: number,
  green: number,
  blue: number,
  encoding: TerrainDemEncoding,
): number =>
  encoding === 'terrarium'
    ? decodeTerrariumElevationM(red, green, blue)
    : decodeMapboxElevationM(red, green, blue)
