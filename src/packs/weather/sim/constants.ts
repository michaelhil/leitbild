import type { AdapterId, DomainId } from '../../../core/model/index.ts'
import { weatherDomainId } from '../model.ts'

export const weatherSimProviderId = 'weather-local'
export const weatherSimAdapterId = 'adapter:weather-local' as AdapterId
export const weatherSimDomain = weatherDomainId as DomainId
