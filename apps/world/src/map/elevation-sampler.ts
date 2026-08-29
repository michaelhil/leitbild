export interface ElevationSamplePoint {
  readonly lon: number
  readonly lat: number
}

export interface ElevationSampler {
  readonly kind: string
  readonly heightAtLonLat: (point: ElevationSamplePoint) => number
}

export const flatElevationSampler: ElevationSampler = {
  kind: 'flat',
  heightAtLonLat: (): number => 0,
}

export const sampleElevationMeters = (
  sampler: ElevationSampler,
  point: ElevationSamplePoint,
): number => {
  const heightM = sampler.heightAtLonLat(point)
  if (!Number.isFinite(heightM)) {
    throw new Error(`elevation sampler ${sampler.kind} returned a non-finite height`)
  }
  return heightM
}
