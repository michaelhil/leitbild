import { z } from 'zod'
import { moduleIdSchema } from './ids.ts'
import { workspaceResourceReferenceSchema } from './resources.ts'

/** The query parameter that names a surface on a Resource's page, beside the Resource's own selection. */
export const WORKSPACE_SURFACE_PARAMETER = 'surface'
export const WORKSPACE_SURFACE_MAX_LENGTH = 200

// A surface is one thing a Module's page can show filling its pane, addressed
// relative to a Resource: for World, a Run's unit overview or its procedure
// window. The owning Module defines, validates and renders the string; the
// Host stores and forwards it without reading it, so a browser window can be
// opened on exactly that surface and reopened on the same surface of a later
// Run. The string names no Workspace and no Run.
export const workspaceSurfaceStringSchema = z.string()
  .min(3)
  .max(WORKSPACE_SURFACE_MAX_LENGTH)
  .regex(/^[a-z][a-z0-9-]*:\S+$/, 'A surface is <kind>:<subject>')

export const workspaceSurfaceSchema = z.object({
  moduleId: moduleIdSchema,
  /** The Resource whose page shows the surface (World: the Run). */
  subject: workspaceResourceReferenceSchema,
  surface: workspaceSurfaceStringSchema,
  /** What a person calls it, for a list of screens. */
  title: z.string().min(1).max(120),
}).strict().superRefine((surface, ctx) => {
  if (surface.subject.moduleId !== surface.moduleId) {
    ctx.addIssue({ code: 'custom', path: ['subject', 'moduleId'], message: 'A surface subject must belong to the publishing Module' })
  }
})
export type WorkspaceSurface = z.infer<typeof workspaceSurfaceSchema>

/**
 * Module page -> Host: the person asked to show this surface on another
 * screen. The Host offers its screens and remembers the choice; it never
 * learns what the surface string means.
 */
export const workspaceSurfacePlaceMessageSchema = z.object({
  type: z.literal('leitbild:surface-place'),
  surface: workspaceSurfaceSchema,
}).strict()
export type WorkspaceSurfacePlaceMessage = z.infer<typeof workspaceSurfacePlaceMessageSchema>
