import { describe, expect, test } from 'bun:test'
import {
  handleSamsinnScreenshotRequest,
  installSamsinnScreenshotResponder,
  isOriginAllowed,
  samsinnScreenshotProtocolVersion,
  samsinnScreenshotRequestType,
  samsinnScreenshotResponseType,
  validateSamsinnScreenshotRequest,
  type SamsinnScreenshotResponse,
} from '../src/ui/samsinn-screenshot.ts'

const capture = async (): Promise<{ readonly dataUrl: string; readonly width: number; readonly height: number }> => ({
  dataUrl: 'data:image/png;base64,abc',
  width: 800,
  height: 450,
})

const createWindowHarness = (): {
  readonly parent: { readonly postMessage: (message: unknown, targetOrigin: string) => void }
  readonly otherSource: { readonly postMessage: (message: unknown, targetOrigin: string) => void }
  readonly messages: Array<{ readonly message: unknown; readonly targetOrigin: string }>
  readonly dispatch: (event: {
    readonly data: unknown
    readonly origin: string
    readonly source: unknown
  }) => void
  readonly window: Window
} => {
  let listener: ((event: MessageEvent) => void) | null = null
  const messages: Array<{ readonly message: unknown; readonly targetOrigin: string }> = []
  const parent = {
    postMessage: (message: unknown, targetOrigin: string): void => {
      messages.push({ message, targetOrigin })
    },
  }
  const otherSource = {
    postMessage: (message: unknown, targetOrigin: string): void => {
      messages.push({ message, targetOrigin })
    },
  }
  const windowLike = {
    parent,
    addEventListener: (type: string, nextListener: EventListener): void => {
      if (type === 'message') listener = nextListener as (event: MessageEvent) => void
    },
    removeEventListener: (type: string): void => {
      if (type === 'message') listener = null
    },
  } as unknown as Window
  return {
    parent,
    otherSource,
    messages,
    dispatch: event => {
      listener?.(event as MessageEvent)
    },
    window: windowLike,
  }
}

describe('Samsinn screenshot protocol', () => {
  test('accepts only the screenshot request message type', () => {
    expect(validateSamsinnScreenshotRequest({ type: samsinnScreenshotRequestType, requestId: 'req-1' })).toEqual({
      type: samsinnScreenshotRequestType,
      requestId: 'req-1',
    })
    expect(validateSamsinnScreenshotRequest({ type: 'other.message', requestId: 'req-1' })).toBeNull()
    expect(validateSamsinnScreenshotRequest({ type: samsinnScreenshotRequestType })).toBeNull()
  })

  test('requires window.parent as the message source', async () => {
    const harness = createWindowHarness()
    const uninstall = installSamsinnScreenshotResponder({
      enabled: true,
      allowedParentOrigins: 'https://samsinn.app',
      maxDataUrlBytes: 1_000,
      capture,
      currentWindow: harness.window,
    })
    harness.dispatch({
      data: { type: samsinnScreenshotRequestType, requestId: 'req-1' },
      origin: 'https://samsinn.app',
      source: harness.otherSource,
    })
    await Bun.sleep(0)
    expect(harness.messages).toHaveLength(0)
    uninstall()
  })

  test('allows exact and wildcard Samsinn parent origins', () => {
    const allowList = 'https://samsinn.app,https://*.samsinn.app'
    expect(isOriginAllowed('https://samsinn.app', allowList)).toBe(true)
    expect(isOriginAllowed('https://ops.samsinn.app', allowList)).toBe(true)
    expect(isOriginAllowed('https://deep.ops.samsinn.app', allowList)).toBe(true)
    expect(isOriginAllowed('https://evil-samsinn.app', allowList)).toBe(false)
    expect(isOriginAllowed('http://ops.samsinn.app', allowList)).toBe(false)
  })

  test('posts a successful response to the requesting origin with protocolVersion', async () => {
    const harness = createWindowHarness()
    const uninstall = installSamsinnScreenshotResponder({
      enabled: true,
      allowedParentOrigins: 'https://*.samsinn.app',
      maxDataUrlBytes: 1_000,
      capture,
      currentWindow: harness.window,
    })
    harness.dispatch({
      data: { type: samsinnScreenshotRequestType, requestId: 'req-2' },
      origin: 'https://ops.samsinn.app',
      source: harness.parent,
    })
    await Bun.sleep(0)
    expect(harness.messages).toHaveLength(1)
    expect(harness.messages[0]?.targetOrigin).toBe('https://ops.samsinn.app')
    expect(harness.messages[0]?.message).toEqual({
      type: samsinnScreenshotResponseType,
      requestId: 'req-2',
      protocolVersion: samsinnScreenshotProtocolVersion,
      dataUrl: 'data:image/png;base64,abc',
      width: 800,
      height: 450,
    })
    uninstall()
  })

  test('returns disabled, oversized, and capture-failed errors', async () => {
    const request = { type: samsinnScreenshotRequestType, requestId: 'req-3' } as const
    const disabled = await handleSamsinnScreenshotRequest({
      request,
      enabled: false,
      maxDataUrlBytes: 1_000,
      capture,
    }) as SamsinnScreenshotResponse
    expect(disabled).toMatchObject({ protocolVersion: samsinnScreenshotProtocolVersion, error: 'disabled' })

    const oversized = await handleSamsinnScreenshotRequest({
      request,
      enabled: true,
      maxDataUrlBytes: 10,
      capture,
    }) as SamsinnScreenshotResponse
    expect(oversized).toMatchObject({ protocolVersion: samsinnScreenshotProtocolVersion, error: 'oversized' })

    const failed = await handleSamsinnScreenshotRequest({
      request,
      enabled: true,
      maxDataUrlBytes: 1_000,
      capture: async () => {
        throw new Error('canvas unavailable')
      },
    }) as SamsinnScreenshotResponse
    expect(failed).toMatchObject({ protocolVersion: samsinnScreenshotProtocolVersion, error: 'capture_failed' })
  })

  test('returns origin-mismatch errors without using wildcard target origins', async () => {
    const harness = createWindowHarness()
    const uninstall = installSamsinnScreenshotResponder({
      enabled: true,
      allowedParentOrigins: 'https://samsinn.app',
      maxDataUrlBytes: 1_000,
      capture,
      currentWindow: harness.window,
    })
    harness.dispatch({
      data: { type: samsinnScreenshotRequestType, requestId: 'req-4' },
      origin: 'https://attacker.example',
      source: harness.parent,
    })
    await Bun.sleep(0)
    expect(harness.messages).toHaveLength(1)
    expect(harness.messages[0]?.targetOrigin).toBe('https://attacker.example')
    expect(harness.messages[0]?.message).toMatchObject({
      type: samsinnScreenshotResponseType,
      requestId: 'req-4',
      protocolVersion: samsinnScreenshotProtocolVersion,
      error: 'origin_mismatch',
    })
    uninstall()
  })
})
