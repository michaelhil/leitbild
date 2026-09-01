import { z } from 'zod'

export const relativeUiPathSchema = z.string().min(1).max(1024).superRefine((value, ctx) => {
  if (!value.startsWith('/')) ctx.addIssue({ code: 'custom', message: 'UI path must start with /' })
  if (value.includes('://')) ctx.addIssue({ code: 'custom', message: 'UI path must not contain an origin' })
})
