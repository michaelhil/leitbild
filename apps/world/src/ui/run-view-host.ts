import { uiControlsHostMessageSchema, uiControlSetMessageSchema, type UiControlsReadyMessage, type UiControlsOfferMessage, type UiControl, type WorkspaceResourceReference } from '@leitbild/contracts'
const same = (a: WorkspaceResourceReference, b: WorkspaceResourceReference): boolean => a.workspaceId === b.workspaceId && a.moduleId === b.moduleId && a.type === b.type && a.id === b.id
/** Only this Run document's challenged channel can change its client presentation. */
export const createRunViewHost = (config: {
  readonly subject: WorkspaceResourceReference
  readonly post: (message: UiControlsReadyMessage | UiControlsOfferMessage) => void
  readonly controls: () => ReadonlyArray<UiControl>
  readonly notification: () => UiControlsOfferMessage['notification']
  readonly set: (id: string, visible: boolean) => void
  readonly error: (reason: string) => void
}) => {
  let channel: string | null = null
  const publish = (): void => {
    if (channel === null) return
    const notification = config.notification()
    config.post({ type: 'leitbild:ui-controls-offer', subject: config.subject, channel, controls: [...config.controls()], ...(notification === undefined ? {} : { notification }) })
  }
  return {
    ready: (): void => config.post({ type: 'leitbild:ui-controls-ready', subject: config.subject }),
    publish,
    receive: (data: unknown): void => {
      if (typeof data !== 'object' || data === null) return
      const type = (data as { type?: unknown }).type
      if (type === 'leitbild:ui-controls-host') {
        const parsed = uiControlsHostMessageSchema.safeParse(data)
        if (!parsed.success) { config.error('Invalid View controls host challenge'); return }
        if (!same(parsed.data.subject, config.subject)) return
        channel = parsed.data.channel; publish(); return
      }
      if (type !== 'leitbild:ui-controls-set') return
      const parsed = uiControlSetMessageSchema.safeParse(data)
      if (!parsed.success) { config.error('Invalid View controls request'); return }
      if (!same(parsed.data.subject, config.subject) || parsed.data.channel !== channel) return
      const control = config.controls().find(control => control.id === parsed.data.id)
      if (!control || control.disabledReason) return
      config.set(control.id, parsed.data.visible)
    },
    close: (): void => { channel = null },
  }
}
