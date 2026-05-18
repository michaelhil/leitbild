import type { ControlInstanceRegistry } from '../control-instances/registry.ts'
import type { ControlInstanceEventNotification } from '../control-instances/runtime.ts'
import type { ControlInstanceId, SimulationClockState } from '../model/index.ts'

interface RealtimeSubscription {
  readonly runtime: NonNullable<ReturnType<ControlInstanceRegistry['get']>>
  readonly unsubscribe: () => void
}

interface SubscriptionReconciliation {
  readonly runtime: NonNullable<ReturnType<ControlInstanceRegistry['get']>> | null
  readonly changed: boolean
}

export interface RealtimeStatus {
  readonly websocketClientCount: number
  readonly subscribedControlInstanceCount: number
  readonly controlInstances: ReadonlyArray<{
    readonly id: ControlInstanceId
    readonly websocketClientCount: number
  }>
}

export interface RealtimeReadyMessage {
  readonly type: 'realtime.ready'
  readonly controlInstanceId: ControlInstanceId
  readonly scenarioId?: string
  readonly snapshotSeq: number
  readonly clock?: SimulationClockState
}

export interface RealtimeEventBatchMessage {
  readonly type: 'events'
  readonly controlInstanceId: ControlInstanceId
  readonly scenarioId?: string
  readonly snapshotSeq: number
  readonly events: ControlInstanceEventNotification['events']
}

export interface ControlInstanceRealtimeManager<Client> {
  readonly addClient: (controlInstanceId: ControlInstanceId, client: Client) => void
  readonly removeClient: (controlInstanceId: ControlInstanceId, client: Client) => void
  readonly reconcile: () => void
  readonly status: () => RealtimeStatus
  readonly stop: () => void
}

export const emptyRealtimeStatus = (): RealtimeStatus => ({
  websocketClientCount: 0,
  subscribedControlInstanceCount: 0,
  controlInstances: [],
})

const realtimeStatusFromClients = <Client>(
  clientsByControlInstance: ReadonlyMap<ControlInstanceId, ReadonlySet<Client>>,
  subscribedControlInstanceCount: number,
): RealtimeStatus => {
  const controlInstances = [...clientsByControlInstance.entries()]
    .map(([id, clients]) => ({ id, websocketClientCount: clients.size }))
    .sort((left, right) => left.id.localeCompare(right.id))
  return {
    websocketClientCount: controlInstances.reduce((count, item) => count + item.websocketClientCount, 0),
    subscribedControlInstanceCount,
    controlInstances,
  }
}

export const createControlInstanceRealtimeManager = <Client>(config: {
  readonly registry: ControlInstanceRegistry
  readonly send: (client: Client, message: RealtimeEventBatchMessage) => void
  readonly sendReady: (client: Client, message: RealtimeReadyMessage) => void
}): ControlInstanceRealtimeManager<Client> => {
  const clientsByControlInstance = new Map<ControlInstanceId, Set<Client>>()
  const subscriptionsByControlInstance = new Map<ControlInstanceId, RealtimeSubscription>()

  const messageContextForRuntime = (
    controlInstanceId: ControlInstanceId,
    runtime: NonNullable<ReturnType<ControlInstanceRegistry['get']>>,
  ): Omit<RealtimeReadyMessage, 'type' | 'clock'> => {
    const snapshot = runtime.snapshot()
    return {
      controlInstanceId,
      ...(snapshot.scenario?.scenarioId === undefined ? {} : { scenarioId: snapshot.scenario.scenarioId }),
      snapshotSeq: snapshot.seq,
    }
  }

  const broadcastToControlInstance = (
    controlInstanceId: ControlInstanceId,
    runtime: NonNullable<ReturnType<ControlInstanceRegistry['get']>>,
    notification: ControlInstanceEventNotification,
  ): void => {
    const subscription = subscriptionsByControlInstance.get(controlInstanceId)
    if (subscription?.runtime !== runtime) return
    const clients = clientsByControlInstance.get(controlInstanceId)
    if (!clients) return
    const message: RealtimeEventBatchMessage = {
      type: 'events',
      ...messageContextForRuntime(controlInstanceId, runtime),
      events: notification.events,
    }
    for (const client of clients) config.send(client, message)
  }

  const readyMessageForRuntime = (
    controlInstanceId: ControlInstanceId,
    runtime: NonNullable<ReturnType<ControlInstanceRegistry['get']>>,
  ): RealtimeReadyMessage => {
    const snapshot = runtime.snapshot()
    return {
      type: 'realtime.ready',
      ...messageContextForRuntime(controlInstanceId, runtime),
      ...(snapshot.clock === undefined ? {} : { clock: snapshot.clock }),
    }
  }

  const sendReadyToControlInstance = (
    controlInstanceId: ControlInstanceId,
    runtime: NonNullable<ReturnType<ControlInstanceRegistry['get']>>,
  ): void => {
    const clients = clientsByControlInstance.get(controlInstanceId)
    if (!clients) return
    const message = readyMessageForRuntime(controlInstanceId, runtime)
    for (const client of clients) config.sendReady(client, message)
  }

  const sendReadyToClient = (
    controlInstanceId: ControlInstanceId,
    runtime: NonNullable<ReturnType<ControlInstanceRegistry['get']>>,
    client: Client,
  ): void => {
    config.sendReady(client, readyMessageForRuntime(controlInstanceId, runtime))
  }

  const reconcileControlInstanceSubscription = (controlInstanceId: ControlInstanceId): SubscriptionReconciliation => {
    const clients = clientsByControlInstance.get(controlInstanceId)
    const existing = subscriptionsByControlInstance.get(controlInstanceId)
    if (!clients || clients.size === 0) {
      existing?.unsubscribe()
      subscriptionsByControlInstance.delete(controlInstanceId)
      return { runtime: null, changed: existing !== undefined }
    }
    const runtime = config.registry.get(controlInstanceId)
    if (!runtime) {
      existing?.unsubscribe()
      subscriptionsByControlInstance.delete(controlInstanceId)
      return { runtime: null, changed: existing !== undefined }
    }
    if (existing?.runtime === runtime) return { runtime, changed: false }
    existing?.unsubscribe()
    const unsubscribe = runtime.subscribe(event => broadcastToControlInstance(controlInstanceId, runtime, event))
    subscriptionsByControlInstance.set(controlInstanceId, { runtime, unsubscribe })
    return { runtime, changed: true }
  }

  return {
    addClient: (controlInstanceId, client): void => {
      const clients = clientsByControlInstance.get(controlInstanceId) ?? new Set<Client>()
      clients.add(client)
      clientsByControlInstance.set(controlInstanceId, clients)
      const { runtime } = reconcileControlInstanceSubscription(controlInstanceId)
      if (runtime) sendReadyToClient(controlInstanceId, runtime, client)
    },
    removeClient: (controlInstanceId, client): void => {
      const clients = clientsByControlInstance.get(controlInstanceId)
      if (!clients) return
      clients.delete(client)
      if (clients.size === 0) clientsByControlInstance.delete(controlInstanceId)
      reconcileControlInstanceSubscription(controlInstanceId)
    },
    reconcile: (): void => {
      for (const controlInstanceId of clientsByControlInstance.keys()) {
        const { runtime, changed } = reconcileControlInstanceSubscription(controlInstanceId)
        if (runtime && changed) sendReadyToControlInstance(controlInstanceId, runtime)
      }
    },
    status: () => realtimeStatusFromClients(clientsByControlInstance, subscriptionsByControlInstance.size),
    stop: (): void => {
      for (const { unsubscribe } of subscriptionsByControlInstance.values()) unsubscribe()
      subscriptionsByControlInstance.clear()
      clientsByControlInstance.clear()
    },
  }
}
