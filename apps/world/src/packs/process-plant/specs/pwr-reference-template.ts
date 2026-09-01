import rawPwrReferenceTemplate from './pwr-reference-template.graph.json'
import { plantGraphSpecSchema } from '../graph/index.ts'

export const pwrReferenceTemplate = plantGraphSpecSchema.parse(rawPwrReferenceTemplate)
