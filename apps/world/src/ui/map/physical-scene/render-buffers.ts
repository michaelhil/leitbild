import type { PhysicalMesh } from './geometry.ts'
/** One immutable local asset; placement, visibility, offsets and status stay per instance. */
export interface PhysicalRenderBuffers { readonly vertices: Float32Array; readonly lines: Float32Array; readonly roles: ReadonlyArray<string>; readonly objectCount: number }
export const preparePhysicalRenderBuffers = (meshes: ReadonlyArray<PhysicalMesh>): PhysicalRenderBuffers => {
  const roles: string[] = [], indices = new Map<string, number>()
  const role = (name: string): number => { const prior = indices.get(name); if (prior !== undefined) return prior; const next = roles.length; roles.push(name); indices.set(name, next); return next }
  const vertices = new Float32Array(meshes.reduce((count, mesh) => count + mesh.vertices.length / 7 * 8, 0)), lines = new Float32Array(meshes.reduce((count, mesh) => count + mesh.lines.length / 3 * 6, 0))
  let solidAt = 0, lineAt = 0
  meshes.forEach((mesh, objectIndex) => {
    for (let at = 0; at < mesh.vertices.length; at += 7) {
      for (let component = 0; component < 6; component++) vertices[solidAt + component] = mesh.vertices[at + component]!
      vertices[solidAt + 6] = role(mesh.materials?.[mesh.vertices[at + 6]!] ?? mesh.object.materials?.[mesh.vertices[at + 6]!] ?? mesh.object.material ?? mesh.object.kind); vertices[solidAt + 7] = objectIndex; solidAt += 8
    }
    for (let at = 0; at < mesh.lines.length; at += 3) {
      lines[lineAt] = mesh.lines[at]!; lines[lineAt + 1] = mesh.lines[at + 1]!; lines[lineAt + 2] = mesh.lines[at + 2]!; lines[lineAt + 3] = role(mesh.lineMaterials?.[Math.floor(at / 6)] ?? 'line'); lines[lineAt + 4] = objectIndex
      const style = mesh.lineStyles?.[Math.floor(at / 6)] ?? (mesh.object.kind === 'context' ? 'context' : 'feature'); lines[lineAt + 5] = style === 'section' ? 2 : style === 'context' ? 1 : 0; lineAt += 6
    }
  })
  return { vertices, lines, roles, objectCount: meshes.length }
}
