import { invokeWorld } from '../../../ui/workspace-capability-client.ts'
export const invokeSituation = async <T>(id: string, input: unknown, options: Parameters<typeof invokeWorld>[2] = {}): Promise<T> => await invokeWorld<T>('world.situation-monitor.' + id, input, options)
