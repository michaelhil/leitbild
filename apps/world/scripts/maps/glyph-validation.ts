import { PbfReader } from 'pbf'

/** Validate the actual protobuf envelope, not just a successful HTTP status. */
export const validateGlyphRange = (bytes: Uint8Array, font: string, range: string): void => {
  if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error('Invalid map glyph size')
  const reader = new PbfReader(bytes)
  const stacks: { name: string; range: string }[] = []
  reader.readFields((tag, result, pbf) => {
    if (tag !== 1) throw new Error('Invalid map glyph envelope')
    result.push(pbf.readMessage((field, stack, data) => {
      if (field === 1) stack.name = data.readString()
      else if (field === 2) stack.range = data.readString()
      else if (field === 3) data.readMessage((glyphField, _glyph, glyph) => {
        if (glyphField === 2) glyph.readBytes()
        else if (glyphField >= 1 && glyphField <= 7) glyph.readVarint()
        else throw new Error('Invalid map glyph field')
      }, {})
      else throw new Error('Invalid map font stack field')
    }, { name: '', range: '' }))
  }, stacks)
  if (reader.pos !== bytes.length || stacks.length !== 1 || !stacks[0]!.name.split(',').map(name => name.trim()).includes(font) || stacks[0]!.range !== range) {
    throw new Error('Map glyph font/range does not match requested artifact')
  }
}
