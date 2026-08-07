/**
 * Version catalogue: what you can actually create an instance of.
 *
 * Four upstream sources, each with a different shape:
 *
 *   Minecraft  launchermeta version_manifest_v2.json   (905 versions)
 *   NeoForge   maven-metadata.xml                      (1,648 builds)
 *   Forge      maven-metadata.xml                      (5,030 builds)
 *   Fabric     meta.fabricmc.net/v2                    (251 loaders)
 *
 * All four are cached on disk under `<root>/launcher/cache` with a TTL, because
 * the create dialog should open instantly on the second use and should still
 * open at all when offline. A stale cache is served rather than failing: an old
 * list of Forge builds is far more useful than an empty one.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { DIRS, ensureDir } from './paths';
import type { LoaderKind, LoaderBuild, McVersion } from '../shared/types';

const CACHE_DIR = path.join(DIRS.launcherState, 'cache');

/** Six hours. Loader builds appear a few times a week at most. */
const TTL_MS = 6 * 60 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 20_000;

const SOURCES = {
  minecraft: 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json',
  neoforge: 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml',
  forge: 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml',
  forgePromos: 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
  fabricLoader: 'https://meta.fabricmc.net/v2/versions/loader',
} as const;

// ------------------------------------------------------------------- caching

interface CacheEnvelope<T> {
  fetchedAt: number;
  payload: T;
}

function cacheFile(key: string): string {
  return path.join(CACHE_DIR, `${key}.json`);
}

function readCache<T>(key: string): CacheEnvelope<T> | null {
  try {
    const raw = fs.readFileSync(cacheFile(key), 'utf8').replace(/^﻿/, '');
    const envelope = JSON.parse(raw) as CacheEnvelope<T>;
    return typeof envelope?.fetchedAt === 'number' ? envelope : null;
  } catch {
    return null;
  }
}

function writeCache<T>(key: string, payload: T): void {
  try {
    ensureDir(CACHE_DIR);
    const envelope: CacheEnvelope<T> = { fetchedAt: Date.now(), payload };
    fs.writeFileSync(cacheFile(key), JSON.stringify(envelope), 'utf8');
  } catch (err) {
    console.warn(`[versions] Could not cache ${key}:`, (err as Error).message);
  }
}

async function fetchText(url: string): Promise<string> {
  // AbortSignal.timeout rather than a wall-clock race: it cancels the socket
  // too, so a hung DNS lookup does not leave a request alive behind us.
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }
  return response.text();
}

/**
 * Cached fetch with stale-on-error.
 *
 * The ordering matters: a *fresh* cache short-circuits without touching the
 * network, and a *stale* cache is still returned if the refresh fails. Only a
 * cold cache plus a failed request is an error, which is the one case where
 * there is genuinely nothing to show.
 */
async function cached<T>(key: string, parse: (body: string) => T, url: string): Promise<T> {
  const existing = readCache<T>(key);
  if (existing && Date.now() - existing.fetchedAt < TTL_MS) {
    return existing.payload;
  }

  try {
    const payload = parse(await fetchText(url));
    writeCache(key, payload);
    return payload;
  } catch (err) {
    if (existing) {
      console.warn(`[versions] Serving stale ${key}: ${(err as Error).message}`);
      return existing.payload;
    }
    throw new Error(`Could not load ${key}: ${(err as Error).message}`);
  }
}

// ----------------------------------------------------------------- Minecraft

interface RawManifest {
  versions: Array<{ id: string; type: string; url: string; releaseTime: string }>;
}

export async function listMinecraftVersions(): Promise<McVersion[]> {
  const manifest = await cached<RawManifest>(
    'minecraft',
    (body) => JSON.parse(body) as RawManifest,
    SOURCES.minecraft,
  );

  return manifest.versions.map((entry) => ({
    id: entry.id,
    type:
      entry.type === 'release' || entry.type === 'snapshot'
        ? (entry.type as McVersion['type'])
        : 'old',
    releaseTime: entry.releaseTime,
  }));
}

/** The manifest entry URL, needed to read a version's own metadata. */
async function versionManifestUrl(id: string): Promise<string> {
  const manifest = await cached<RawManifest>(
    'minecraft',
    (body) => JSON.parse(body) as RawManifest,
    SOURCES.minecraft,
  );
  const entry = manifest.versions.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unknown Minecraft version: ${id}`);
  return entry.url;
}

/**
 * Which Java major this Minecraft version wants.
 *
 * Read from the version's own metadata (`javaVersion.majorVersion`) rather than
 * guessed from a table: Mojang publishes the answer, and a table would be wrong
 * for exactly the versions nobody tests. Verified against the live manifest —
 * 1.21.1 -> 21, 1.20.1 -> 17, 1.16.5 -> 8, 1.7.10 -> 8.
 *
 * Versions old enough to predate the field fall back to 8, which is what they
 * were built for.
 */
export async function javaMajorFor(minecraftVersion: string): Promise<number> {
  const key = `java-${minecraftVersion}`;
  const existing = readCache<number>(key);
  if (existing) return existing.payload;

  try {
    const url = await versionManifestUrl(minecraftVersion);
    const meta = JSON.parse(await fetchText(url)) as { javaVersion?: { majorVersion?: number } };
    const major = meta.javaVersion?.majorVersion ?? 8;
    writeCache(key, major);
    return major;
  } catch (err) {
    console.warn(`[versions] Java major for ${minecraftVersion} unknown: ${(err as Error).message}`);
    return 8;
  }
}

// -------------------------------------------------------------------- loaders

function mavenVersions(xml: string): string[] {
  return [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((match) => match[1]!);
}

/**
 * NeoForge encodes the Minecraft version in its own: `21.1.209` is for 1.21.1,
 * `21.0.167` is for 1.21 (a zero patch means the version has no third segment).
 */
function neoforgeMinecraftVersion(build: string): string | null {
  const match = /^(\d+)\.(\d+)\./.exec(build);
  if (!match) return null;
  const [, major, minor] = match;
  return minor === '0' ? `1.${major}` : `1.${major}.${minor}`;
}

/** Newest first, comparing numeric segments so `1151` sorts above `950`. */
function byVersionDesc(a: string, b: string): number {
  const left = a.split(/[.\-]/).map((part) => Number.parseInt(part, 10));
  const right = b.split(/[.\-]/).map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = Number.isNaN(left[i]!) ? -1 : (left[i] ?? -1);
    const r = Number.isNaN(right[i]!) ? -1 : (right[i] ?? -1);
    if (l !== r) return r - l;
  }
  return 0;
}

async function neoforgeBuilds(minecraftVersion: string): Promise<LoaderBuild[]> {
  const all = await cached<string[]>('neoforge', mavenVersions, SOURCES.neoforge);
  return all
    .filter((build) => neoforgeMinecraftVersion(build) === minecraftVersion)
    .sort(byVersionDesc)
    .map((build, index) => ({ version: build, recommended: index === 0 }));
}

async function forgeBuilds(minecraftVersion: string): Promise<LoaderBuild[]> {
  const all = await cached<string[]>('forge', mavenVersions, SOURCES.forge);
  const prefix = `${minecraftVersion}-`;

  let recommended: string | null = null;
  try {
    const promos = await cached<Record<string, string>>(
      'forge-promos',
      (body) => (JSON.parse(body) as { promos: Record<string, string> }).promos,
      SOURCES.forgePromos,
    );
    recommended = promos[`${minecraftVersion}-recommended`] ?? promos[`${minecraftVersion}-latest`] ?? null;
  } catch {
    // Promotions are a nicety; the build list is the part that matters.
  }

  return all
    .filter((build) => build.startsWith(prefix))
    // Sort on the build number alone. The full string starts with the
    // Minecraft version, which is identical across this filtered set and would
    // otherwise dominate the comparison.
    .sort((a, b) => byVersionDesc(a.slice(prefix.length), b.slice(prefix.length)))
    .map((build) => ({
      version: build,
      recommended: recommended !== null && build.slice(prefix.length).startsWith(recommended),
    }));
}

interface RawFabricLoader {
  version: string;
  stable: boolean;
}

async function fabricBuilds(): Promise<LoaderBuild[]> {
  const loaders = await cached<RawFabricLoader[]>(
    'fabric-loader',
    (body) => JSON.parse(body) as RawFabricLoader[],
    SOURCES.fabricLoader,
  );
  // Already newest-first from the API.
  return loaders.map((loader) => ({ version: loader.version, recommended: loader.stable }));
}

/**
 * Loader builds available for a Minecraft version.
 *
 * Every source is queried concurrently and a failing one yields an empty list
 * rather than rejecting the whole call — Forge's maven and Fabric's meta going
 * down at once should still leave NeoForge selectable.
 */
export async function listLoaderBuilds(
  minecraftVersion: string,
  loader: LoaderKind,
): Promise<LoaderBuild[]> {
  switch (loader) {
    case 'vanilla':
      return [];
    case 'neoforge':
      return neoforgeBuilds(minecraftVersion).catch(() => []);
    case 'forge':
      return forgeBuilds(minecraftVersion).catch(() => []);
    case 'fabric':
      return fabricBuilds().catch(() => []);
    default:
      return [];
  }
}

/** Which loaders have at least one build for this version. */
export async function listAvailableLoaders(minecraftVersion: string): Promise<LoaderKind[]> {
  const [neoforge, forge, fabric] = await Promise.all([
    neoforgeBuilds(minecraftVersion).catch(() => []),
    forgeBuilds(minecraftVersion).catch(() => []),
    fabricSupports(minecraftVersion).catch(() => false),
  ]);

  const available: LoaderKind[] = ['vanilla'];
  if (neoforge.length > 0) available.push('neoforge');
  if (forge.length > 0) available.push('forge');
  if (fabric) available.push('fabric');
  return available;
}

/**
 * Whether Fabric publishes an intermediary mapping for this version.
 *
 * Fabric's loader list is version-independent, so the loader endpoint cannot
 * answer this — the intermediary endpoint is what actually gates support, and
 * it 404s for versions Fabric never shipped for.
 */
async function fabricSupports(minecraftVersion: string): Promise<boolean> {
  const key = `fabric-supports-${minecraftVersion}`;
  const existing = readCache<boolean>(key);
  if (existing && Date.now() - existing.fetchedAt < TTL_MS) return existing.payload;

  try {
    const body = await fetchText(
      `https://meta.fabricmc.net/v2/versions/intermediary/${encodeURIComponent(minecraftVersion)}`,
    );
    const supported = (JSON.parse(body) as unknown[]).length > 0;
    writeCache(key, supported);
    return supported;
  } catch {
    writeCache(key, false);
    return false;
  }
}

/**
 * Fabric's ready-made launcher profile.
 *
 * Fabric is the one loader here with no installer to run: this endpoint returns
 * a complete version JSON with `inheritsFrom` already pointing at the vanilla
 * version, so installing is writing one file. Verified against 1.21.1 +
 * loader 0.16.10 — `id: fabric-loader-0.16.10-1.21.1`, 8 libraries,
 * `mainClass: net.fabricmc.loader.impl.launch.knot.KnotClient`.
 */
export async function fabricProfileJson(
  minecraftVersion: string,
  loaderVersion: string,
): Promise<string> {
  return fetchText(
    `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(minecraftVersion)}/` +
      `${encodeURIComponent(loaderVersion)}/profile/json`,
  );
}
