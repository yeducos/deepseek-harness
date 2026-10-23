/** Ambient module declarations for CSS Modules imported by the client face. */

declare module '*.module.css' {
  /** Class-name map produced by the bundler for one stylesheet. */
  const classes: Record<string, string>
  export default classes
}
