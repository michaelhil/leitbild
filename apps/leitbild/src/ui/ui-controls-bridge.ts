import {
  uiControlsReadyMessageSchema, uiControlsOfferMessageSchema, uiControlsHostMessageSchema, uiControlSetMessageSchema,
  type UiControlsHostMessage, type UiControlsOfferMessage, type UiControlSetMessage, type WorkspaceResourceReference,
} from '@leitbild/contracts'
const same = (a: WorkspaceResourceReference, b: WorkspaceResourceReference): boolean => a.workspaceId === b.workspaceId && a.moduleId === b.moduleId && a.type === b.type && a.id === b.id

/** The Module owns control meaning and state. The Host only displays its offer
 * and relays a requested checkbox value to the currently challenged document.
 * The caller validates the source frame and origin before delivering messages. */
export const createUiControlsBridge = (config: {
  readonly subject: () => WorkspaceResourceReference | null
  readonly post: (message: UiControlsHostMessage | UiControlSetMessage) => void
  readonly offer: (offer: UiControlsOfferMessage | null) => void
  readonly error: (message: string) => void
  readonly channel?: () => string
}) => {
  let channel: string | null = null
  let latest: UiControlsOfferMessage | null = null
  const clear = (): void => { channel = null; latest = null; config.offer(null) }
  return {
    clear,
    /** True only when this message established valid current-document readiness. */
    receive: (data: unknown): boolean => {
      if (typeof data !== 'object' || data === null) return false
      const type = (data as { type?: unknown }).type
      if (type === 'leitbild:ui-controls-ready') {
        const result = uiControlsReadyMessageSchema.safeParse(data), subject = config.subject()
        if (!result.success) { config.error('View controls sent invalid readiness'); return false }
        if (!subject || !same(result.data.subject, subject)) return false
        channel = config.channel?.() ?? crypto.randomUUID()
        latest = null; config.offer(null)
        config.post(uiControlsHostMessageSchema.parse({ type: 'leitbild:ui-controls-host', subject, channel }))
        return true
      }
      if (type !== 'leitbild:ui-controls-offer') return false
      const result = uiControlsOfferMessageSchema.safeParse(data), subject = config.subject()
      if (!result.success) { config.error('View controls sent an invalid offer'); return false }
      if (!subject || !same(result.data.subject, subject) || result.data.channel !== channel) return false
      latest = result.data; config.offer(latest)
      return false
    },
    set: (id: string, visible: boolean): void => {
      const subject = config.subject(), control = latest?.controls.find(control => control.id === id)
      if (!subject || !channel || !latest || !same(latest.subject, subject) || !control || control.disabledReason) return
      config.post(uiControlSetMessageSchema.parse({ type: 'leitbild:ui-controls-set', subject, channel, id, visible }))
    },
  }
}
