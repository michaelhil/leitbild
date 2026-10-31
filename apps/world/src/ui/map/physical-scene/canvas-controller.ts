import { createCanvasPhysicalViewport } from './canvas-viewport.ts'
import { createPhysicalSceneControllerForViewport } from './scene-controller.ts'
import type { PhysicalCanvasControllerOptions } from './types.ts'
export const createPhysicalCanvasController = (options: PhysicalCanvasControllerOptions) => createPhysicalSceneControllerForViewport(createCanvasPhysicalViewport(options.canvas), options)
