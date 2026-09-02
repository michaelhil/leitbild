import { createStorageBudget, type StorageBudget } from '@leitbild/module-runtime'
import { sharedPaths } from '../paths.ts'

let current: { root: string; budget: StorageBudget } | undefined
export const agentsStorageBudget = (): StorageBudget => {
  const root = sharedPaths.root()
  if (current?.root !== root) current = { root, budget: createStorageBudget({ root }) }
  return current.budget
}
