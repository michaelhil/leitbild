import {
  defaultSamsinnAllowedParentOrigins,
  defaultSamsinnScreenshotMaxDataUrlBytes,
  type SamsinnScreenshotConfig,
} from '../core/api/client-config.ts'

export const disabledSamsinnScreenshotConfig = (): SamsinnScreenshotConfig => ({
  enabled: false,
  allowedParentOrigins: defaultSamsinnAllowedParentOrigins,
  maxDataUrlBytes: defaultSamsinnScreenshotMaxDataUrlBytes,
})

export const fetchSamsinnScreenshotConfig = async (): Promise<SamsinnScreenshotConfig> => {
  const response = await fetch('/api/client-config', { cache: 'no-store' })
  if (!response.ok) throw new Error(`client config fetch failed: ${response.status}`)
  const body = await response.json() as { readonly samsinnScreenshot?: Partial<SamsinnScreenshotConfig> }
  return {
    enabled: body.samsinnScreenshot?.enabled === true,
    allowedParentOrigins: typeof body.samsinnScreenshot?.allowedParentOrigins === 'string'
      ? body.samsinnScreenshot.allowedParentOrigins
      : defaultSamsinnAllowedParentOrigins,
    maxDataUrlBytes: typeof body.samsinnScreenshot?.maxDataUrlBytes === 'number'
      ? body.samsinnScreenshot.maxDataUrlBytes
      : defaultSamsinnScreenshotMaxDataUrlBytes,
  }
}
