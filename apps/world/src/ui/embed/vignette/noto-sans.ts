import notoSans, { characters } from 'virtual:noto-sans-subset'

// OpenBridge's Noto Sans for the embed's text (plan v5 W6.5; U-26): the subset
// the build cuts (ui/embed/noto-sans-font.ts), for the characters it carries,
// at every weight. The composer reserves a flow drawing's text by its widths
// (features/displays/topology/text.ts); any other character falls back to the
// system face OpenBridge's family token names after it (embed.css).
const range = [...characters].map(character => `U+${character.codePointAt(0)!.toString(16).toUpperCase()}`).join(', ')
const face = new FontFace('Noto Sans', `url(${notoSans})`, { weight: '100 900', unicodeRange: range })
document.fonts.add(face)
void face.load()
