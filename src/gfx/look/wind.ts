import { Effect } from '@babylonjs/core';

/**
 * Vertex-side wind chunk, `#include<lookWind>`.
 *
 * Lives in its own include because TWO shaders must displace foliage by the
 * exact same amount: the toy material and the shadow depth pass. If the depth
 * pass skipped it, a swaying canopy would be tested against a shadow map of
 * the canopy standing still and crawl with self-shadow acne.
 *
 * Declares `uniform vec4 lookWind` (xy = unit wind direction in world xz,
 * z = amplitude in meters at weight 1, w = time in seconds).
 */
export const LOOK_WIND_UNIFORM = 'lookWind';

const WIND_CHUNK = `
uniform vec4 lookWind;
// Two travelling sine waves whose phase comes from the WORLD position, so
// thin instances never sway in unison and neighbouring trees lean in sequence
// (reads as a gust crossing the field). Two sines per vertex, no textures.
vec3 lookWindSway(vec3 wp, float weight) {
  float ph = dot(wp.xz, vec2(0.13, 0.09));
  float a = sin(lookWind.w * 1.3 + ph) + 0.45 * sin(lookWind.w * 3.1 + ph * 2.3 + wp.y * 0.5);
  float amt = a * lookWind.z * weight;
  wp.xz += lookWind.xy * amt;
  // Tips dip a little as they lean: keeps branch length roughly constant
  // instead of visibly stretching the mesh sideways.
  wp.y -= abs(amt) * 0.18;
  return wp;
}
`;

let registered = false;

export function registerWindChunk(): void {
  if (registered) return;
  registered = true;
  Effect.IncludesShadersStore['lookWind'] = WIND_CHUNK;
}
