import type { Asset } from './types';

/**
 * Asset registry — discovers every `*.asset.ts` under `cars/`, `props/` and
 * `buildings/` (any depth) with a LAZY `import.meta.glob`. Lazy matters: each
 * asset is its own dynamic import, so a sibling file with a syntax error or a
 * throwing top level only fails ITS import — every other asset still loads,
 * and the lab can list the broken one with its error.
 *
 * THE RULE: file name = asset id + '.asset.ts', and the default export is the
 * asset whose `id` field is that same string.
 *     src/assets/props/t01-rally-oak.asset.ts   →  id 't01-rally-oak'
 * Ids are therefore known from the paths alone (no import needed to list
 * them), and must be unique across all three folders. If a file's exported
 * `id` disagrees with its name, the exported id wins, a warning is logged,
 * and the asset is reachable under both — but fix the file name.
 */

interface AssetModule {
  default?: Asset;
}

const modules = import.meta.glob<AssetModule>('./{cars,props,buildings}/**/*.asset.ts');

export type AssetGroup = 'cars' | 'props' | 'buildings';

export interface AssetEntry {
  /** Id derived from the file name. */
  id: string;
  /** Top-level folder. */
  group: AssetGroup;
  /** Module path relative to src/assets, e.g. './props/t01-rally-oak.asset.ts'. */
  path: string;
}

export interface AssetFailure {
  id: string;
  path: string;
  error: unknown;
}

function idFromPath(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1);
  return file.slice(0, -'.asset.ts'.length);
}

const found: AssetEntry[] = Object.keys(modules)
  .map((path) => ({ id: idFromPath(path), group: path.split('/')[1] as AssetGroup, path }))
  .sort((a, b) => (a.group === b.group ? a.id.localeCompare(b.id) : a.group.localeCompare(b.group)));

// One entry per id: a second file with the same name in another folder is
// dropped (with a warning), so nothing keyed by id ever sees two assets.
const byId = new Map<string, AssetEntry>();
const entries: AssetEntry[] = [];
for (const e of found) {
  const clash = byId.get(e.id);
  if (clash) {
    console.warn(`[assets] duplicate asset id "${e.id}": ${clash.path} and ${e.path} — the first wins, the second is ignored`);
    continue;
  }
  byId.set(e.id, e);
  entries.push(e);
}

/** Loaded assets by path, so repeated loads share one import and one check. */
const loaded = new Map<string, Promise<Asset>>();
/** Assets whose own `id` differs from their file name, by that own id. */
const aliases = new Map<string, AssetEntry>();

function loadEntry(entry: AssetEntry): Promise<Asset> {
  let promise = loaded.get(entry.path);
  if (!promise) {
    promise = modules[entry.path]().then((mod) => {
      const asset = mod.default;
      if (!asset || typeof asset !== 'object' || typeof asset.id !== 'string') {
        throw new Error(`[assets] ${entry.path} has no default-exported asset (export default { kind, id, … })`);
      }
      if (asset.id !== entry.id) {
        const other = byId.get(asset.id);
        if (other) {
          // Two assets would answer to one id; the file's own name wins.
          console.warn(`[assets] ${entry.path} exports id "${asset.id}", which is ${other.path}'s id — it stays reachable only as "${entry.id}"; rename one of them`);
          return { ...asset, id: entry.id };
        }
        console.warn(`[assets] ${entry.path} exports id "${asset.id}" — file should be named ${asset.id}.asset.ts`);
        aliases.set(asset.id, entry);
      }
      return asset;
    });
    loaded.set(entry.path, promise);
  }
  return promise;
}

/** All asset ids, from file names alone (nothing is imported). Sorted by
 * folder, then id. */
export function listAssetIds(): string[] {
  return entries.map((e) => e.id);
}

/** Ids with their folder and module path (nothing is imported). */
export function listAssetEntries(): readonly AssetEntry[] {
  return entries;
}

/** Whether an asset FILE named `<id>.asset.ts` exists (synchronous, nothing
 * is imported). An asset whose exported `id` differs from its file name is
 * only known under that id once its module has been loaded — `loadAsset`
 * finds it either way. */
export function hasAsset(id: string): boolean {
  return byId.has(id) || aliases.has(id);
}

/**
 * Load one asset by id. Rejects if no such asset exists or its module fails
 * to load — other assets are unaffected. An id that matches no file name is
 * looked up among the assets' own `id` fields as a fallback (which loads the
 * others once).
 */
export async function loadAsset(id: string): Promise<Asset> {
  const entry = byId.get(id) ?? aliases.get(id);
  if (entry) return loadEntry(entry);
  const { assets } = await loadAll();
  const found = assets.find((a) => a.id === id);
  if (found) return found;
  throw new Error(`[assets] unknown asset "${id}". Known: ${listAssetIds().join(', ') || '(none)'}`);
}

/**
 * Load every asset. Never rejects: modules that fail to import (syntax
 * error, missing default export, throwing top level) are returned in
 * `failures` and the rest in `assets`, in `listAssetIds()` order.
 */
export async function loadAll(): Promise<{ assets: Asset[]; failures: AssetFailure[] }> {
  const results = await Promise.allSettled(entries.map((e) => loadEntry(e)));
  const assets: Asset[] = [];
  const failures: AssetFailure[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') assets.push(r.value);
    else failures.push({ id: entries[i].id, path: entries[i].path, error: r.reason });
  });
  return { assets, failures };
}
