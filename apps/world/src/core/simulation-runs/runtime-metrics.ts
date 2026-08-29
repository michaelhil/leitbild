import type { SimulationRunId, IsoTimestamp } from '../model/index.ts'

export interface SimulationRunRuntimeMetricsSnapshot {
  readonly simulationRunId: SimulationRunId
  readonly createdAt: IsoTimestamp
  readonly closedAt?: IsoTimestamp
  readonly packEmissions: {
    readonly count: number
    readonly totalEvents: number
    readonly maxEventsPerEmission: number
    readonly lastRuntimeId?: string
    readonly lastEventCount: number
    readonly lastEmittedAt?: IsoTimestamp
  }
  readonly publishedEvents: {
    readonly batchCount: number
    readonly totalEvents: number
    readonly durableEvents: number
    readonly projectedEvents: number
    readonly maxEventsPerBatch: number
  }
  readonly persistence: {
    readonly snapshotSaveCount: number
    readonly snapshotSaveFailureCount: number
    readonly snapshotSaveTotalMs: number
    readonly lastSnapshotSaveMs: number
    readonly lastSnapshotSavedAt?: IsoTimestamp
    readonly immediateSnapshotSaveCount: number
    readonly projectedSnapshotScheduleCount: number
    readonly projectedSnapshotFlushCount: number
  }
}

export interface SimulationRunRuntimeMetricsRecorder {
  readonly recordPackEmission: (runtimeId: string, eventCount: number, emittedAt: IsoTimestamp) => void
  readonly recordPublishedEvents: (config: {
    readonly eventCount: number
    readonly durableEventCount: number
    readonly projectedEventCount: number
  }) => void
  readonly recordSnapshotSave: (durationMs: number, savedAt: IsoTimestamp) => void
  readonly recordSnapshotSaveFailure: () => void
  readonly recordImmediateSnapshotSave: () => void
  readonly recordProjectedSnapshotScheduled: () => void
  readonly recordProjectedSnapshotFlushed: () => void
  readonly markClosed: (closedAt: IsoTimestamp) => void
  readonly snapshot: () => SimulationRunRuntimeMetricsSnapshot
}

const roundMetricMs = (value: number): number =>
  Math.round(value * 10) / 10

export const createSimulationRunRuntimeMetricsRecorder = (config: {
  readonly simulationRunId: SimulationRunId
  readonly createdAt: IsoTimestamp
}): SimulationRunRuntimeMetricsRecorder => {
  let closedAt: IsoTimestamp | undefined
  let packEmissionCount = 0
  let packEmissionTotalEvents = 0
  let packEmissionMaxEvents = 0
  let packEmissionLastRuntimeId: string | undefined
  let packEmissionLastEventCount = 0
  let packEmissionLastEmittedAt: IsoTimestamp | undefined
  let publishedBatchCount = 0
  let publishedTotalEvents = 0
  let publishedDurableEvents = 0
  let publishedProjectedEvents = 0
  let publishedMaxEventsPerBatch = 0
  let snapshotSaveCount = 0
  let snapshotSaveFailureCount = 0
  let snapshotSaveTotalMs = 0
  let lastSnapshotSaveMs = 0
  let lastSnapshotSavedAt: IsoTimestamp | undefined
  let immediateSnapshotSaveCount = 0
  let projectedSnapshotScheduleCount = 0
  let projectedSnapshotFlushCount = 0

  return {
    recordPackEmission: (runtimeId, eventCount, emittedAt): void => {
      packEmissionCount += 1
      packEmissionTotalEvents += eventCount
      packEmissionMaxEvents = Math.max(packEmissionMaxEvents, eventCount)
      packEmissionLastRuntimeId = runtimeId
      packEmissionLastEventCount = eventCount
      packEmissionLastEmittedAt = emittedAt
    },
    recordPublishedEvents: ({ eventCount, durableEventCount, projectedEventCount }): void => {
      publishedBatchCount += 1
      publishedTotalEvents += eventCount
      publishedDurableEvents += durableEventCount
      publishedProjectedEvents += projectedEventCount
      publishedMaxEventsPerBatch = Math.max(publishedMaxEventsPerBatch, eventCount)
    },
    recordSnapshotSave: (durationMs, savedAt): void => {
      snapshotSaveCount += 1
      snapshotSaveTotalMs += durationMs
      lastSnapshotSaveMs = durationMs
      lastSnapshotSavedAt = savedAt
    },
    recordSnapshotSaveFailure: (): void => {
      snapshotSaveFailureCount += 1
    },
    recordImmediateSnapshotSave: (): void => {
      immediateSnapshotSaveCount += 1
    },
    recordProjectedSnapshotScheduled: (): void => {
      projectedSnapshotScheduleCount += 1
    },
    recordProjectedSnapshotFlushed: (): void => {
      projectedSnapshotFlushCount += 1
    },
    markClosed: (nextClosedAt): void => {
      closedAt = nextClosedAt
    },
    snapshot: (): SimulationRunRuntimeMetricsSnapshot => ({
      simulationRunId: config.simulationRunId,
      createdAt: config.createdAt,
      ...(closedAt === undefined ? {} : { closedAt }),
      packEmissions: {
        count: packEmissionCount,
        totalEvents: packEmissionTotalEvents,
        maxEventsPerEmission: packEmissionMaxEvents,
        ...(packEmissionLastRuntimeId === undefined ? {} : { lastRuntimeId: packEmissionLastRuntimeId }),
        lastEventCount: packEmissionLastEventCount,
        ...(packEmissionLastEmittedAt === undefined ? {} : { lastEmittedAt: packEmissionLastEmittedAt }),
      },
      publishedEvents: {
        batchCount: publishedBatchCount,
        totalEvents: publishedTotalEvents,
        durableEvents: publishedDurableEvents,
        projectedEvents: publishedProjectedEvents,
        maxEventsPerBatch: publishedMaxEventsPerBatch,
      },
      persistence: {
        snapshotSaveCount,
        snapshotSaveFailureCount,
        snapshotSaveTotalMs: roundMetricMs(snapshotSaveTotalMs),
        lastSnapshotSaveMs: roundMetricMs(lastSnapshotSaveMs),
        ...(lastSnapshotSavedAt === undefined ? {} : { lastSnapshotSavedAt }),
        immediateSnapshotSaveCount,
        projectedSnapshotScheduleCount,
        projectedSnapshotFlushCount,
      },
    }),
  }
}
