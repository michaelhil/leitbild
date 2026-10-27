export type PhysicalTransparencyPhase = 'accumulate' | 'reveal'

/** Order-independent architectural inspection transparency. Both passes test
 * the opaque model's exact depth; neither writes depth nor sorts/rebuilds meshes.
 * Unit weights preserve the quiet material palette across intersecting walls.
 * See McGuire/Bavoil, Weighted Blended Order-Independent Transparency (2013). */
export const createPhysicalTransparencyPass = (gl: WebGL2RenderingContext, input: { readonly width: number; readonly height: number; readonly samples: number; readonly depth: WebGLRenderbuffer }) => {
  if (!gl.getExtension('EXT_color_buffer_float')) throw Error('Architecture transparency requires floating-point colour attachments on this GPU')
  if (input.samples > 0 && ![...gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA16F, gl.SAMPLES) as Int32Array].includes(input.samples)) throw Error('This GPU cannot antialias floating-point architecture transparency at the physical view’s sample quality')
  interface Target { texture: WebGLTexture; resolve: WebGLFramebuffer; draw: WebGLFramebuffer; color: WebGLRenderbuffer | null }
  const targets: Partial<Record<PhysicalTransparencyPhase, Target>> = {}
  let disposed = false
  const live = { liveTextures: null as number | null, liveFramebuffers: null as number | null, liveRenderbuffers: null as number | null }
  const release = (target: Target): void => { gl.deleteTexture(target.texture); gl.deleteFramebuffer(target.resolve); if (target.draw !== target.resolve) gl.deleteFramebuffer(target.draw); if (target.color) gl.deleteRenderbuffer(target.color) }
  try {
    for (const phase of ['accumulate', 'reveal'] as const) {
      const texture = gl.createTexture(), resolve = gl.createFramebuffer(), color = input.samples > 0 ? gl.createRenderbuffer() : null, draw = input.samples > 0 ? gl.createFramebuffer() : resolve
      if (!texture || !resolve || !draw || input.samples > 0 && !color) {
        if (texture) gl.deleteTexture(texture); if (resolve) gl.deleteFramebuffer(resolve); if (draw && draw !== resolve) gl.deleteFramebuffer(draw); if (color) gl.deleteRenderbuffer(color)
        throw Error('Unable to allocate architectural transparency targets')
      }
      const target = { texture, resolve, draw, color }; targets[phase] = target
      const format = phase === 'accumulate' ? gl.RGBA16F : gl.RGBA8
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texImage2D(gl.TEXTURE_2D, 0, format, input.width, input.height, 0, gl.RGBA, phase === 'accumulate' ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null)
      gl.bindFramebuffer(gl.FRAMEBUFFER, resolve); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
      gl.bindFramebuffer(gl.FRAMEBUFFER, draw); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, input.depth)
      if (color) { gl.bindRenderbuffer(gl.RENDERBUFFER, color); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, input.samples, format, input.width, input.height); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color) }
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw Error('Architectural transparency target is incomplete')
      gl.bindFramebuffer(gl.FRAMEBUFFER, resolve)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw Error('Architectural transparency resolve target is incomplete')
    }
  } catch (error) { for (const target of Object.values(targets)) release(target); throw error }
  const accumulated = targets.accumulate!, revealed = targets.reveal!
  return {
    begin(phase: PhysicalTransparencyPhase): void {
      if (disposed) throw Error('Architectural transparency has been disposed')
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets[phase]!.draw); gl.viewport(0, 0, input.width, input.height)
      gl.disable(gl.SCISSOR_TEST); gl.colorMask(true, true, true, true); gl.depthMask(false)
      if (phase === 'accumulate') gl.clearColor(0, 0, 0, 0); else gl.clearColor(1, 1, 1, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
    },
    resolve(): void {
      for (const target of [accumulated, revealed]) if (target.draw !== target.resolve) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.draw); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.resolve)
        gl.blitFramebuffer(0, 0, input.width, input.height, 0, 0, input.width, input.height, gl.COLOR_BUFFER_BIT, gl.NEAREST)
      }
    },
    textures: { accumulated: accumulated.texture, revealed: revealed.texture },
    metrics: () => ({ textures: disposed ? 0 : 2, framebuffers: disposed ? 0 : input.samples > 0 ? 4 : 2, renderbuffers: disposed ? 0 : input.samples > 0 ? 2 : 0, textureBytes: disposed ? 0 : input.width * input.height * 12, bytes: disposed ? 0 : input.width * input.height * 12 * (1 + input.samples), ...live }),
    dispose(): void {
      if (disposed) return
      release(accumulated); release(revealed); disposed = true
      live.liveTextures = Number(gl.isTexture(accumulated.texture)) + Number(gl.isTexture(revealed.texture))
      live.liveFramebuffers = [...new Set([accumulated.draw, accumulated.resolve, revealed.draw, revealed.resolve])].filter(value => gl.isFramebuffer(value)).length
      live.liveRenderbuffers = [accumulated.color, revealed.color].filter(value => value !== null && gl.isRenderbuffer(value)).length
    },
  }
}
