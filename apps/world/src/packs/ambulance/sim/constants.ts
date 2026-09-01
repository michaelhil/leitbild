import type { AdapterId, PackId } from '../../../core/model/index.ts'
import { ambulancePackId } from '../model.ts'

export const ambulanceSimRuntimeId = 'ambulance.local'
export const ambulanceSimAdapterId = 'adapter:ambulance.local' as AdapterId
export const ambulanceSimPackId = ambulancePackId as PackId
