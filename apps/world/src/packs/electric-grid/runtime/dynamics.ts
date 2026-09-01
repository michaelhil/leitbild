import type { IsoTimestamp } from '../../../core/model/index.ts'
import type { GridLoadDefinition } from '../grid-model.ts'

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

const stableUnitFor = (value: string): number => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) / 0xffffffff
}

const loadDailyFactor = (load: GridLoadDefinition, hour: number): number => {
  const phase = 2 * Math.PI * hour / 24
  if (load.kind === 'residential') return 1 + 0.055 * Math.sin(phase - 0.6) + 0.05 * Math.sin(2 * phase - 2.2)
  if (load.kind === 'commercial' || load.kind === 'airport') return 0.98 + 0.08 * Math.sin(phase - 1.35) + 0.025 * Math.sin(2 * phase - 1.8)
  if (load.kind === 'ev_charging') return 0.96 + 0.105 * Math.sin(phase - 2.35) + 0.035 * Math.sin(2 * phase - 2.9)
  if (load.kind === 'industry' || load.kind === 'data_center' || load.kind === 'process_plant') return 1 + 0.018 * Math.sin(phase - 0.9)
  if (load.kind === 'hospital') return 1 + 0.01 * Math.sin(phase - 0.4)
  return 1
}

export const profiledGridDemand = (load: GridLoadDefinition, nominalDemandMw: number, at: IsoTimestamp): number => {
  const seconds = Date.parse(at) / 1_000
  const hour = (((seconds % 86_400) + 86_400) % 86_400) / 3_600
  const seed = stableUnitFor(`${load.id}:${load.kind}`)
  const regulation = 0.006 * Math.sin(seconds / 95 + 0.8) + 0.003 * Math.sin(seconds / 29 + 1.7)
  const local = 0.012 * Math.sin(seconds / (41 + seed * 23) + seed * Math.PI * 2)
    + 0.006 * Math.sin(seconds / (113 + seed * 31) + seed * Math.PI * 5)
  return Math.max(load.criticalMw, nominalDemandMw * clamp(loadDailyFactor(load, hour) + regulation + local, 0.78, 1.22))
}

export const gridFrequencyStep = (config: {
  readonly nominalHz: number
  readonly previousHz: number
  readonly generationMw: number
  readonly loadMw: number
  readonly reserveMw: number
  readonly inertiaSeconds: number
  readonly dtSeconds: number
}): number => {
  const droopMw = clamp((config.nominalHz - config.previousHz) * 500, -config.reserveMw, config.reserveMw)
  const imbalanceMw = config.generationMw + droopMw - config.loadMw
  const equilibriumHz = config.nominalHz + clamp(imbalanceMw / Math.max(500, config.loadMw) * 2, -1.6, 0.6)
  const timeConstantSeconds = clamp(5 + config.inertiaSeconds / 100, 5, 20)
  const response = 1 - Math.exp(-Math.max(0, config.dtSeconds) / timeConstantSeconds)
  return clamp(
    config.previousHz + (equilibriumHz - config.previousHz) * response,
    config.nominalHz - 1.6,
    config.nominalHz + 0.6,
  )
}

export const gridGeneratorIsOnline = (state: string): boolean => state === 'online'
