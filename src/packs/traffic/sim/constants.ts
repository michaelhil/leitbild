import type { AdapterId, DomainId } from '../../../core/model/index.ts'
import { trafficDomainId } from '../model.ts'

export const trafficSimProviderId = 'traffic-local'
export const trafficSimAdapterId = 'adapter:traffic-local' as AdapterId
export const trafficSimDomain = trafficDomainId as DomainId

