import type { AdapterId, PackId } from '../../../core/model/index.ts'
import { weatherPackId } from '../model.ts'

export const weatherSimRuntimeId = 'weather-local'
export const weatherSimAdapterId = 'adapter:weather-local' as AdapterId
export const weatherSimPackId = weatherPackId as PackId
