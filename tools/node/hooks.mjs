// Node resolve hook: lets plain Node (22.18+, native TypeScript type
// stripping) import the repo's extensionless TS modules ('./track' ->
// './track.ts', './world' -> './world/index.ts'). Babylon-free modules only.
export async function resolve(spec, ctx, next) {
  try {
    return await next(spec, ctx);
  } catch (e) {
    for (const ext of ['.ts', '/index.ts', '.js', '/index.js']) {
      try {
        return await next(spec + ext, ctx);
      } catch {
        /* try the next spelling */
      }
    }
    throw e;
  }
}
