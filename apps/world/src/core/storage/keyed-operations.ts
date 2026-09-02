/** Serialize lifecycle changes for one identity without blocking unrelated identities. */
export const createKeyedOperations = <Key>() => {
  const pending = new Map<Key, Promise<unknown>>()
  return {
    run: <T>(key: Key, operation: () => Promise<T>): Promise<T> => {
      const previous = pending.get(key) ?? Promise.resolve()
      const result = previous.catch(() => undefined).then(operation)
      pending.set(key, result)
      const release = () => { if (pending.get(key) === result) pending.delete(key) }
      void result.then(release, release)
      return result
    },
    drain: async (): Promise<void> => { await Promise.allSettled([...pending.values()]) },
  }
}
