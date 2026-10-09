declare module '*.css'
declare module '*.mjs?url' {
  const url: string
  export default url
}
declare module '*.ttf?url' {
  const url: string
  export default url
}
