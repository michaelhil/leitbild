import { embeddedViewHostMessageSchema, embeddedViewOpenMessageSchema, type EmbeddedViewHostMessage, type EmbeddedViewListing } from '@leitbild/contracts'

/** A same-origin embedded inspection relays detail to the shared display window; it grants no control authority. */
export const createEmbeddedFrameHost = (config: {
  readonly origin: string
  readonly frame: () => unknown
  readonly post: (frame: unknown, message: EmbeddedViewHostMessage) => void
  readonly open: (view: EmbeddedViewListing) => void
}) => ({
  receive: (event: { readonly origin: string; readonly source: unknown; readonly data: unknown }): void => {
    const frame = config.frame()
    if (frame === null || event.source !== frame || event.origin !== config.origin) return
    const data = event.data
    if (typeof data === 'object' && data !== null && (data as { readonly type?: unknown }).type === 'world:display-frame-ready') {
      config.post(frame, embeddedViewHostMessageSchema.parse({ type: 'leitbild:view-host' }))
      return
    }
    const opened = embeddedViewOpenMessageSchema.safeParse(data)
    if (opened.success) config.open(opened.data.view)
  },
})
