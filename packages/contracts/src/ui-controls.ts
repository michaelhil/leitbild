import { z } from 'zod'
import { workspaceResourceReferenceSchema } from './resources.ts'

// Module-owned, browser-local presentation controls. They are neither domain
// commands nor persisted Run settings. A fresh Host challenge scopes each
// offer and subsequent choice to the currently listening Module document.
const id = z.string().min(1).max(200)
export const uiControlSchema = z.object({
  id,
  label: z.string().min(1).max(120),
  visible: z.boolean(),
  disabledReason: z.string().min(1).max(500).optional(),
}).strict()
export const uiControlsReadyMessageSchema = z.object({
  type: z.literal('leitbild:ui-controls-ready'),
  subject: workspaceResourceReferenceSchema,
}).strict()
export const uiControlsHostMessageSchema = z.object({
  type: z.literal('leitbild:ui-controls-host'),
  subject: workspaceResourceReferenceSchema,
  channel: id,
}).strict()
export const uiControlsOfferMessageSchema = z.object({
  type: z.literal('leitbild:ui-controls-offer'),
  subject: workspaceResourceReferenceSchema,
  channel: id,
  controls: z.array(uiControlSchema),
  notification: z.object({ count: z.number().int().nonnegative(), label: z.string().min(1).max(200) }).strict().optional(),
}).strict().superRefine((message, context) => {
  if (new Set(message.controls.map(control => control.id)).size !== message.controls.length) context.addIssue({ code: 'custom', message: 'View control identities must be unique' })
})
export const uiControlSetMessageSchema = z.object({
  type: z.literal('leitbild:ui-controls-set'),
  subject: workspaceResourceReferenceSchema,
  channel: id,
  id,
  visible: z.boolean(),
}).strict()
export type UiControl = z.infer<typeof uiControlSchema>
export type UiControlsReadyMessage = z.infer<typeof uiControlsReadyMessageSchema>
export type UiControlsHostMessage = z.infer<typeof uiControlsHostMessageSchema>
export type UiControlsOfferMessage = z.infer<typeof uiControlsOfferMessageSchema>
export type UiControlSetMessage = z.infer<typeof uiControlSetMessageSchema>
