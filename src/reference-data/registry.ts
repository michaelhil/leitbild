import type { DatasetConfig } from './types.ts'

// Reference-data dataset registry.
// Initially empty; Phase A.4 appends aero-norway and future phases append further datasets.
// Tests bypass the registry and call buildDataset directly with their own configs.

export const registeredDatasets: ReadonlyArray<DatasetConfig> = []
