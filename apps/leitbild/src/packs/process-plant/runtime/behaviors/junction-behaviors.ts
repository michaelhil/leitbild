import type { ComponentBehaviorDefinition } from '../behavior-contract.ts'
import { headerBehaviorDefinitions } from './junction/header-behaviors.ts'
import { valveBehaviorDefinitions } from './junction/valve-behaviors.ts'

export const junctionBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  ...valveBehaviorDefinitions,
  ...headerBehaviorDefinitions,
]
