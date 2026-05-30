export interface ControlInstanceRuntimePolicy {
  readonly idleRuntimeCloseDelayMs: number
  readonly projectedSnapshotFlushIntervalMs: number
  readonly runtimePrivateStateFlushIntervalMs: number
}

export const defaultControlInstanceRuntimePolicy: ControlInstanceRuntimePolicy = {
  idleRuntimeCloseDelayMs: 30_000,
  projectedSnapshotFlushIntervalMs: 10_000,
  runtimePrivateStateFlushIntervalMs: 10_000,
}
