import type { SimulationAdapter, SimulationConnection, SimulationConnectionConfig, SimulationEventHandler } from '../../../simulation/protocol.ts'
import type { CommandEnvelope, CommandResult } from '../../../core/model/index.ts'
import { createOsloAmbulanceScenario } from '../scenario.ts'
import { ambulanceDomainId } from '../model.ts'
import { createAmbulanceSimEngine } from './engine.ts'
import type { RoutingAdapter } from '../../../routing/protocol.ts'

export const createLocalAmbulanceSimulationAdapter = (adapterConfig: {
  readonly routing: RoutingAdapter
}): SimulationAdapter => ({
  id: 'ambulance-local',
  domain: ambulanceDomainId,
  connect: async (config: SimulationConnectionConfig): Promise<SimulationConnection> => {
    const engine = createAmbulanceSimEngine({
      controlInstanceId: config.controlInstanceId,
      scenario: createOsloAmbulanceScenario(),
      routing: adapterConfig.routing,
      ...(config.initialObjects ? { initialObjects: config.initialObjects } : {}),
    })
    const handlers = new Set<SimulationEventHandler>()
    const interval = setInterval(() => {
      const events = engine.tick(1000)
      for (const event of events) {
        for (const handler of handlers) handler(event)
      }
    }, 1000)

    const sendCommand = async (command: CommandEnvelope): Promise<CommandResult> => {
      const result = await engine.handleCommand(command)
      if (result.ok) {
        const snapshot = engine.snapshot()
        for (const object of snapshot.objects) {
          for (const handler of handlers) {
            handler({
              type: 'object.upserted',
              object,
              at: snapshot.capturedAt,
              provenance: object.provenance,
            })
          }
        }
      }
      return result
    }

    return {
      getSnapshot: async () => engine.snapshot(),
      subscribe: (handler: SimulationEventHandler): (() => void) => {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
      sendCommand,
      close: async (): Promise<void> => {
        clearInterval(interval)
        handlers.clear()
      },
    }
  },
})
