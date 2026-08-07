/**
 * CurseForge as a second mod source.
 *
 * Kept in its own module because it differs from Modrinth in three ways that
 * matter, and mixing them would bury each one:
 *
 *   1. **It needs an API key.** Modrinth's API is open; CurseForge's returns 403
 *      to everyone without one. Keys are free from console.curseforge.com but
 *      have to be obtained by the person running the launcher — there is no key
 *      that can ship with this.
 *   2. **Numeric enums instead of strings.** Loaders, sort fields and dependency
 *      relations are all magic numbers, named as constants below.
 *   3. **Not everything is downloadable.** Authors can opt out of third-party
 *      distribution, and for those projects the API returns a null download URL.
 *      See {@link CurseForgeFile}.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { DIRS, ensureDir } from './paths';

const API = 'https://api.curseforge.com/v1';

/** Minecraft. CurseForge hosts several games; this is the one we want. */
const GAME_ID = 432;

/** The "Mods" class. Excludes resource packs, worlds, modpacks and shaders. */
const CLASS_ID = 6;

/** CurseForge's loader enum. */
const LOADER_IDS: Record<string, number> = {
  forge: 1,
  fabric: 4,
  quilt: 5,
  neoforge: 6,
};

/** sortField 6 is total downloads — the useful default for an empty query. */
const SORT_TOTAL_DOWNLOADS = 6;

/** relationType 3 is a required dependency. */
const RELATION_REQUIRED = 3;

/** hashes[].algo 1 is SHA-1. CurseForge does not publish SHA-512. */
const HASH_SHA1 = 1;

const KEY_FILE = path.join(DIRS.launcherState, 'curseforge.key');

const REQUEST_TIMEOUT_MS = 20_000;

let cachedKey: string | null | undefined;

/**
 * The configured API key, or null when CurseForge is not set up.
 *
 * Stored in its own file rather than in the instance registry: it is a
 * credential, it belongs to the person not the instance, and keeping it
 * separate means the registry can be copied around or shared without leaking
 * it.
 */
export function apiKey(): string | null {
  if (cachedKey === undefined) {
    try {
      const raw = fs.readFileSync(KEY_FILE, 'utf8').replace(/^﻿/, '').trim();
      cachedKey = raw.length > 0 ? raw : null;
    } catch {
      cachedKey = null;
    }
  }
  return cachedKey;
}

export function setApiKey(key: string | null): void {
  cachedKey = key && key.trim().length > 0 ? key.trim() : null;
  try {
    ensureDir(DIRS.launcherState);
    if (cachedKey === null) {
      fs.rmSync(KEY_FILE, { force: true });
    } else {
      fs.writeFileSync(KEY_FILE, cachedKey, 'utf8');
    }
  } catch (err) {
    console.warn('[curseforge] Could not persist the key:', (err as Error).message);
  }
}

export function isConfigured(): boolean {
  return apiKey() !== null;
}

async function call<T>(url: string): Promise<T> {
  const key = apiKey();
  if (!key) {
    throw new Error('No CurseForge API key configured.');
  }

  // `x-api-key` is what the REST API documents, and testing confirmed the
  // alternatives are not it: a `cfc_pat_` studio token was rejected identically
  // with `x-api-key`, `Authorization: Key` and `Authorization: Bearer`. The
  // scheme was never the problem — see the 403 handling below.
  const response = await fetch(url, {
    headers: { 'x-api-key': key, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.status === 401 || response.status === 403) {
    /*
     * Almost always an *unapproved* key rather than a wrong one.
     *
     * The Studios console issues a key the moment you ask, but CurseForge gates
     * Core API access behind a separate application for third-party services —
     * and an unapproved key returns 403 with "API Key missing or invalid",
     * which reads exactly like a typo. Verified here: a freshly-issued
     * `cfc_pat_` token was refused under every auth scheme, on the documented
     * host, with the documented header.
     *
     * Saying so is the difference between the user re-copying their key for
     * twenty minutes and filling in the form that actually fixes it.
     */
    throw new Error(
      'CurseForge refused the key (403). This usually means the key has not been ' +
        'approved for third-party API access yet — the console issues one immediately, ' +
        'but CurseForge has to grant access separately. Modrinth still works meanwhile.',
    );
  }
  if (!response.ok) {
    throw new Error(`CurseForge returned ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

interface RawMod {
  id: number;
  name: string;
  summary: string;
  downloadCount: number;
  logo: { thumbnailUrl?: string } | null;
  authors: Array<{ name: string }>;
  links: { websiteUrl?: string } | null;
  /** False when the author has opted out of third-party downloads. */
  allowModDistribution: boolean | null;
}

export interface CurseForgeMod {
  id: number;
  name: string;
  summary: string;
  downloads: number;
  iconUrl: string | null;
  author: string;
  websiteUrl: string | null;
  /** When false, we can list it but not fetch it. */
  downloadable: boolean;
}

export async function searchMods(
  minecraftVersion: string,
  loader: string,
  query: string,
  offset: number,
): Promise<{ total: number; results: CurseForgeMod[] }> {
  const params = new URLSearchParams({
    gameId: String(GAME_ID),
    classId: String(CLASS_ID),
    gameVersion: minecraftVersion,
    searchFilter: query,
    sortField: String(SORT_TOTAL_DOWNLOADS),
    sortOrder: 'desc',
    index: String(offset),
    pageSize: '20',
  });

  const loaderId = LOADER_IDS[loader];
  if (loaderId !== undefined) {
    params.set('modLoaderType', String(loaderId));
  }

  const raw = await call<{ data: RawMod[]; pagination: { totalCount: number } }>(
    `${API}/mods/search?${params.toString()}`,
  );

  return {
    total: raw.pagination.totalCount,
    results: raw.data.map((mod) => ({
      id: mod.id,
      name: mod.name,
      summary: mod.summary,
      downloads: mod.downloadCount,
      iconUrl: mod.logo?.thumbnailUrl ?? null,
      author: mod.authors[0]?.name ?? 'unknown',
      websiteUrl: mod.links?.websiteUrl ?? null,
      // Null is treated as allowed: the field is absent on older entries and
      // the per-file download URL is the real gate anyway.
      downloadable: mod.allowModDistribution !== false,
    })),
  };
}

interface RawFile {
  id: number;
  displayName: string;
  fileName: string;
  fileLength: number;
  releaseType: number;
  /**
   * Null when the author has disabled third-party distribution.
   *
   * A URL can be reconstructed from the file id, and several launchers do it.
   * This one does not: the null is the author declining to have their file
   * served by anyone else, and routing around that is not ours to do. The mod
   * is listed with Install disabled and a link to its page instead.
   */
  downloadUrl: string | null;
  hashes: Array<{ value: string; algo: number }>;
  dependencies: Array<{ modId: number; relationType: number }>;
}

export interface CurseForgeFile {
  fileId: number;
  displayName: string;
  fileName: string;
  sizeBytes: number;
  downloadUrl: string | null;
  sha1: string | null;
  requiredModIds: number[];
}

export async function listFiles(
  modId: number,
  minecraftVersion: string,
  loader: string,
): Promise<CurseForgeFile[]> {
  const params = new URLSearchParams({ gameVersion: minecraftVersion, pageSize: '50' });
  const loaderId = LOADER_IDS[loader];
  if (loaderId !== undefined) {
    params.set('modLoaderType', String(loaderId));
  }

  const raw = await call<{ data: RawFile[] }>(`${API}/mods/${modId}/files?${params.toString()}`);

  return raw.data.map((file) => ({
    fileId: file.id,
    displayName: file.displayName,
    fileName: file.fileName,
    sizeBytes: file.fileLength,
    downloadUrl: file.downloadUrl,
    sha1: file.hashes.find((hash) => hash.algo === HASH_SHA1)?.value ?? null,
    requiredModIds: file.dependencies
      .filter((dependency) => dependency.relationType === RELATION_REQUIRED)
      .map((dependency) => dependency.modId),
  }));
}

/** One mod's details, for resolving a dependency we only have an id for. */
export async function getMod(modId: number): Promise<CurseForgeMod> {
  const raw = await call<{ data: RawMod }>(`${API}/mods/${modId}`);
  const mod = raw.data;
  return {
    id: mod.id,
    name: mod.name,
    summary: mod.summary,
    downloads: mod.downloadCount,
    iconUrl: mod.logo?.thumbnailUrl ?? null,
    author: mod.authors[0]?.name ?? 'unknown',
    websiteUrl: mod.links?.websiteUrl ?? null,
    downloadable: mod.allowModDistribution !== false,
  };
}
