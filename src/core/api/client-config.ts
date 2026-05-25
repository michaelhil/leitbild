export const defaultSamsinnAllowedParentOrigins = 'https://samsinn.app,https://*.samsinn.app'
export const defaultSamsinnScreenshotMaxDataUrlBytes = 5_000_000

export interface SamsinnScreenshotConfig {
  readonly enabled: boolean
  readonly allowedParentOrigins: string
  readonly maxDataUrlBytes: number
}

export const parseBooleanEnv = (value: string | undefined): boolean =>
  value === 'true'

export const parsePositiveIntegerEnv = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export const createSamsinnScreenshotConfigFromEnv = (env: Record<string, string | undefined> = process.env): SamsinnScreenshotConfig => ({
  enabled: parseBooleanEnv(env.LEITBILD_SCREENSHOT_CAPTURE_ENABLED),
  allowedParentOrigins: env.LEITBILD_ALLOWED_PARENT_ORIGINS ?? defaultSamsinnAllowedParentOrigins,
  maxDataUrlBytes: parsePositiveIntegerEnv(
    env.LEITBILD_SCREENSHOT_MAX_DATA_URL_BYTES,
    defaultSamsinnScreenshotMaxDataUrlBytes,
  ),
})
