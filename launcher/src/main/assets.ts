/**
 * Asset provisioning.
 *
 * ## Why this module exists
 *
 * MCLC's `Handler.getAssets()` does this:
 *
 * ```js
 * await Promise.all(Object.keys(index.objects).map(async asset => {
 *   if (!exists || !await this.checkSum(...)) await this.downloadAsync(...)
 * }))
 * ```
 *
 * Every object is dispatched at once — ~3,900 concurrent HTTP requests for
 * 1.21.1 — and `downloadAsync` sets no request timeout. `overrides.maxSockets`
 * does not apply here; it is only consulted by `downloadToDirectory`, which
 * handles libraries.
 *
 * Instrumenting `Handler.prototype` on a real run produced:
 *
 * ```
 * >>> downloadAsync : 3971
 * <<< downloadAsync : 2374
 * !!! rejections    : 0
 * ```
 *
 * 1,597 requests entered and never settled — not resolved, not rejected. With
 * no timeout they hang forever, so the enclosing `Promise.all` never completes,
 * `getAssets()` never returns, and `launch()` waits indefinitely. The launcher
 * looks frozen with nothing in any log, because the last thing MCLC emitted was
 * "Attempting to download assets".
 *
 * ## The fix
 *
 * Fetch the assets ourselves first, with bounded concurrency, per-request
 * timeouts and retries. MCLC only calls `downloadAsync` for an object that is
 * missing or fails its checksum — so if every object is already present and
 * correct, it issues zero requests and cannot hang. Its checksum pass over
 * ~3,900 local files is genuinely fast (measured: 1.2 s), so leaving that to
 * MCLC costs nothing.
 *
 * We do not patch or fork MCLC; we just make sure it has nothing left to do.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import { DIRS, ensureDir } from './paths';
import type { ClientProfile } from '../shared/types';

/**
 * Simultaneous downloads. Mojang's CDN is happy to serve far more, but the
 * point of this module is to *not* be MCLC — a bounded pool is what makes the
 * run deterministic. 16 saturates a normal connection comfortably.
 */
const CONCURRENCY = 8;

/**
 * Time allowed to receive response *headers*. A connect/response failure is
 * genuinely fast to detect, so this stays short.
 */
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * Time allowed with **zero bytes received** before giving up on a transfer.
 *
 * Deliberately a stall timeout rather than a cap on total duration. Asset
 * objects are not uniformly small — Minecraft's music and sound files run to
 * tens of megabytes (one measured here is 14.7 MB) — and with several transfers
 * sharing a ~1 MB/s link a large object legitimately takes minutes. A
 * wall-clock timeout aborts exactly those healthy-but-slow downloads, which is
 * what an earlier version of this file got wrong. What we actually need to
 * detect is a connection that has stopped making progress.
 */
const STALL_TIMEOUT_MS = 30_000;

/** Metadata requests are small; a plain total timeout is right for those. */
const META_TIMEOUT_MS = 30_000;

/** Exponential backoff across attempts: 0.5s, 1s, 2s, 4s. */
const MAX_ATTEMPTS = 5;

export type AssetProgress = (done: number, total: number, label: string) => void;

interface AssetIndexEntry {
  hash: string;
  size: number;
}

interface AssetIndex {
  objects: Record<string, AssetIndexEntry>;
}

interface VersionAssetIndex {
  id: string;
  url: string;
}

/** SHA-1 of a file, or null if it cannot be read. */
async function sha1OfFile(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(file);
    stream.on('error', () => resolve(null));
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** GET a small metadata document with a total timeout. Throws on non-2xx. */
async function fetchWithTimeout(url: string): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(META_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }
  return response;
}

/**
 * Stream a URL to `dest`, aborting only on a connect timeout or a stall.
 *
 * Two independent timers:
 *  - headers: bounded time to get a response at all
 *  - stall:   rearmed on every chunk, so an actively-progressing transfer of any
 *             size is never cancelled
 */
async function streamToFile(url: string, dest: string): Promise<void> {
  const controller = new AbortController();
  let headersTimer: NodeJS.Timeout | undefined;
  let stallTimer: NodeJS.Timeout | undefined;
  let stalled = false;

  const armStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, STALL_TIMEOUT_MS);
  };

  try {
    headersTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(headersTimer);
    headersTimer = undefined;

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    if (!response.body) {
      throw new Error('empty response body');
    }

    const source = Readable.fromWeb(response.body as never);
    armStall();
    source.on('data', armStall);

    await pipeline(source, fs.createWriteStream(dest));
  } catch (err) {
    if (stalled) {
      throw new Error(`stalled: no data for ${STALL_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    if (headersTimer) clearTimeout(headersTimer);
    if (stallTimer) clearTimeout(stallTimer);
  }
}

/**
 * Locate the vanilla version JSON, which carries the asset index pointer.
 *
 * Prefers the copy the loader installer or a previous run already wrote, and
 * falls back to Mojang's live manifest so a cold install works.
 */
async function resolveAssetIndexPointer(minecraftVersion: string): Promise<VersionAssetIndex> {
  const local = path.join(DIRS.versions, minecraftVersion, `${minecraftVersion}.json`);

  if (fs.existsSync(local)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(local, 'utf8').replace(/^﻿/, '')) as {
        assetIndex?: VersionAssetIndex;
      };
      if (parsed.assetIndex?.url && parsed.assetIndex.id) {
        return parsed.assetIndex;
      }
    } catch {
      // Fall through to the network path rather than trusting a damaged file.
    }
  }

  const manifest = (await (
    await fetchWithTimeout('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json')
  ).json()) as { versions: Array<{ id: string; url: string }> };

  const entry = manifest.versions.find((v) => v.id === minecraftVersion);
  if (!entry) {
    throw new Error(`Minecraft ${minecraftVersion} is not in Mojang's version manifest.`);
  }

  const versionJson = (await (await fetchWithTimeout(entry.url)).json()) as {
    assetIndex?: VersionAssetIndex;
  };
  if (!versionJson.assetIndex?.url) {
    throw new Error(`Minecraft ${minecraftVersion} version JSON has no assetIndex.`);
  }
  return versionJson.assetIndex;
}

/**
 * Write the asset index under both names MCLC might look for.
 *
 * MCLC uses `version.custom || version.number` as the index filename, so for a
 * loader profile it wants `neoforge-21.1.209.json`. Writing the canonical
 * `<id>.json` too keeps the store readable by any other launcher.
 */
async function writeAssetIndex(pointer: VersionAssetIndex, profile: ClientProfile): Promise<AssetIndex> {
  const indexDir = ensureDir(path.join(DIRS.assets, 'indexes'));
  const canonical = path.join(indexDir, `${pointer.id}.json`);

  let body: string;
  if (fs.existsSync(canonical) && fs.statSync(canonical).size > 0) {
    body = fs.readFileSync(canonical, 'utf8');
  } else {
    body = await (await fetchWithTimeout(pointer.url)).text();
    fs.writeFileSync(canonical, body, 'utf8');
  }

  // MCLC's expected filename for this profile.
  fs.writeFileSync(path.join(indexDir, `${profile.versionId}.json`), body, 'utf8');

  return JSON.parse(body) as AssetIndex;
}

/**
 * Download any URL to a file, with the same stall-timeout and retry behaviour
 * used for assets. Exported so loader provisioning can reuse it rather than
 * growing a second, weaker downloader.
 */
export async function downloadFile(url: string, target: string): Promise<void> {
  ensureDir(path.dirname(target));
  const temp = `${target}.part`;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await streamToFile(url, temp);
      fs.renameSync(temp, target);
      return;
    } catch (err) {
      lastError = err as Error;
      try {
        if (fs.existsSync(temp)) fs.rmSync(temp);
      } catch {
        /* best effort */
      }
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
      }
    }
  }

  throw new Error(`Failed to download ${url} after ${MAX_ATTEMPTS} attempts: ${lastError?.message}`);
}

/** Absolute path of an object in the content-addressed store. */
function objectPath(hash: string): string {
  return path.join(DIRS.assets, 'objects', hash.substring(0, 2), hash);
}

/** Download one object, verify it, and move it into place. Retries on failure. */
async function downloadObject(hash: string): Promise<void> {
  const target = objectPath(hash);
  ensureDir(path.dirname(target));
  const temp = `${target}.part`;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await streamToFile(
        `https://resources.download.minecraft.net/${hash.substring(0, 2)}/${hash}`,
        temp,
      );

      const actual = await sha1OfFile(temp);
      if (actual !== hash) {
        throw new Error(`checksum mismatch (expected ${hash}, got ${actual})`);
      }

      // Node's rename maps to MoveFileEx with REPLACE_EXISTING, so this is safe
      // even if a previous partial landed at the target.
      fs.renameSync(temp, target);
      return;
    } catch (err) {
      lastError = err as Error;
      try {
        if (fs.existsSync(temp)) fs.rmSync(temp);
      } catch {
        /* best effort */
      }
      // Exponential backoff. Linear was not enough: when the CDN is throttling,
      // retrying quickly just burns attempts against a closed window.
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
      }
    }
  }

  throw new Error(`Failed to download asset ${hash} after ${MAX_ATTEMPTS} attempts: ${lastError?.message}`);
}

/** Run `tasks` with at most `limit` in flight. Rejects on the first failure. */
async function runPool<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index]!);
    }
  });

  await Promise.all(runners);
}

/**
 * Ensure every asset for the profile is present and correct.
 *
 * Safe and cheap to call before every launch: a warm store costs one SHA-1 pass
 * (~1 s for 1.21.1) and zero network requests.
 */
export async function ensureAssets(profile: ClientProfile, progress: AssetProgress): Promise<void> {
  progress(0, 1, 'Resolving asset index…');

  const pointer = await resolveAssetIndexPointer(profile.minecraftVersion);
  const index = await writeAssetIndex(pointer, profile);

  const hashes = Object.values(index.objects).map((entry) => entry.hash);
  const unique = [...new Set(hashes)];

  // Pass 1: figure out what is actually missing or corrupt. Size is checked
  // first because it is a stat() rather than a full read.
  progress(0, unique.length, 'Verifying assets…');
  const sizeByHash = new Map<string, number>();
  for (const entry of Object.values(index.objects)) {
    sizeByHash.set(entry.hash, entry.size);
  }

  const missing: string[] = [];
  let verified = 0;

  await runPool(unique, CONCURRENCY * 2, async (hash) => {
    const target = objectPath(hash);
    let ok = false;

    if (fs.existsSync(target)) {
      const expectedSize = sizeByHash.get(hash);
      const actualSize = fs.statSync(target).size;
      // A size mismatch is decisive, so skip hashing in that case.
      ok = expectedSize === undefined || actualSize === expectedSize
        ? (await sha1OfFile(target)) === hash
        : false;
    }

    if (!ok) missing.push(hash);
    verified++;
    if (verified % 200 === 0) progress(verified, unique.length, 'Verifying assets…');
  });

  if (missing.length === 0) {
    progress(unique.length, unique.length, `Assets OK (${unique.length} objects)`);
    return;
  }

  // Pass 2: fetch only what is needed, bounded and with timeouts.
  progress(0, missing.length, `Downloading ${missing.length} assets…`);
  let done = 0;

  await runPool(missing, CONCURRENCY, async (hash) => {
    await downloadObject(hash);
    done++;
    if (done % 25 === 0 || done === missing.length) {
      progress(done, missing.length, `Downloading assets… ${done}/${missing.length}`);
    }
  });

  progress(missing.length, missing.length, `Assets ready (${unique.length} objects)`);
}
