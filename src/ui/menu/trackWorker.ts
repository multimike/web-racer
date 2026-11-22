import { generateTerrain } from '../../terrain/generateTerrain';
import { trackInfoOf } from './trackPreview';

/**
 * Module worker of the menu's track previews (trackPreview.ts): `{ seed }` →
 * `{ seed, info }` with the outline and length of `generateTerrain(seed)`'s
 * track (~0.2 s, off the main thread so the title never hitches).
 */

const scope = self as unknown as { postMessage(msg: unknown): void; onmessage: ((ev: MessageEvent<{ seed: number }>) => void) | null };

scope.onmessage = (ev: MessageEvent<{ seed: number }>): void => {
  const seed = ev.data.seed;
  try {
    scope.postMessage({ seed, info: trackInfoOf(seed, generateTerrain(seed).track) });
  } catch (e) {
    scope.postMessage({ seed, info: null, error: String(e) });
  }
};
