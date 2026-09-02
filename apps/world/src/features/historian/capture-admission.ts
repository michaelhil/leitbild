import type { StorageBudget } from '@leitbild/module-runtime'

/** One bounded, shared filesystem inventory; never scan synchronously in a physics tick. */
export const createCaptureAdmission = async (budget: StorageBudget, workspaceRoot: string): Promise<() => string | null> => {
  let status = await budget.inspect(workspaceRoot)
  let checkedAt = Date.now()
  let checking = false
  return () => {
    if (!checking && Date.now() - checkedAt >= 30_000) {
      checking = true
      void budget.inspect(workspaceRoot).then(next => { status = next }).catch(error => {
        status = { ...status, allowed: false, reason: `Storage admission check failed: ${String(error)}` }
      }).finally(() => { checkedAt = Date.now(); checking = false })
    }
    return status.allowed ? null : status.reason
  }
}
