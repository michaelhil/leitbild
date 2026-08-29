import type { CompiledComponent, VariablePath } from '../../graph/index.ts'
import type { ProcessPlantValue } from '../model.ts'

export interface ComponentInitialValueDefinition {
  readonly componentKind: string
  readonly initialValueFor: (component: CompiledComponent, localPath: string, path: VariablePath) => ProcessPlantValue | undefined
}
