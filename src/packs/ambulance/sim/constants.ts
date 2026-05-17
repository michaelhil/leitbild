import type { AdapterId, DomainId } from '../../../core/model/index.ts'
import { ambulanceDomainId } from '../model.ts'

export const ambulanceSimProviderId = 'ambulance-local'
export const ambulanceSimAdapterId = 'adapter:ambulance-local' as AdapterId
export const ambulanceSimDomain = ambulanceDomainId as DomainId
