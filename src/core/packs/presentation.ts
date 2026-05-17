import type {
  PackObjectField,
  PackObjectStatusIndicator,
  PackObjectStatusPresentation,
  PackObjectStatusTone,
} from './protocol.ts'

export const packField = (key: string, label: string, value: string): PackObjectField => ({
  key,
  label,
  value,
})

export const packStatus = (
  tone: PackObjectStatusTone,
  label: string,
  indicator: PackObjectStatusIndicator = { shape: 'dot' },
): PackObjectStatusPresentation => ({
  tone,
  label,
  indicator,
})
