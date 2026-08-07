/**
 * Mod browsing and installation, per instance.
 *
 * Backed by Modrinth's public API, and by CurseForge's when an API key has been
 * configured. Every request is filtered by the instance's
 * own Minecraft version and loader, so the list you are shown is the list that
 * can actually run — the usual way to end up with a broken profile is
 * downloading a jar for the wrong loader, and the cheapest fix is never
 * offering it.
 *
 * Files land in `<instance>/mods`, which is the folder the game already reads
 * and the one you can open and poke at by hand. Nothing here takes ownership of
 * that directory: a jar dropped in manually shows up in the installed list
 * alongside ours, just without the metadata.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import { ensureDir, instanceModsDir } from './paths';
import { getInstanceSummary } from './instances';
import * as curseforge from './curseforge';
import type { InstalledMod, ModSearchResult, ModSource, ModVersion } from '../shared/types';

const API = 'https://api.modrinth.com/v2';

/**
 * Modrinth asks API consumers to identify themselves, and rate-limits harder
 * for those that do not. Cheap courtesy, and it means a misbehaving build of
 * this launcher can be identified rather than blamed on everyone.
 */
const USER_AGENT = 'Blxxdlauncher/0.1.0 (minecraft launcher)';

const REQUEST_TIMEOUT_MS = 20_000;

/** Recorded per instance so the installed list can show titles, not filenames. */
const MANIFEST_NAME = 'blxxdlauncher-mods.json';
/** Pre-rename name. Adopted on first read, then gone. */
const LEGACY_MANIFEST_NAME = 'mycustomclient-mods.json';

interface ManifestEntry {
  projectId: string;
  versionId: string;
  title: string;
  fileName: string;
  /** Installed automatically to satisfy another mod's requirement. */
  dependency: boolean;
  /** Absent on entries written before CurseForge support; treated as Modrinth. */
  source?: ModSource;
}

interface Manifest {
  version: 1;
  mods: ManifestEntry[];
}

// ------------------------------------------------------------------ manifest

function manifestPath(instanceId: string): string {
  const dir = instanceModsDir(instanceId);
  const file = path.join(dir, MANIFEST_NAME);

  // Carry a pre-rename manifest over. Losing it would not lose any mods — the
  // jars are still in mods/ and the game still loads them — but the installed
  // list is built from this file, so every mod would show as untracked and
  // "Remove" would have nothing to remove.
  if (!fs.existsSync(file)) {
    const legacy = path.join(dir, LEGACY_MANIFEST_NAME);
    if (fs.existsSync(legacy)) {
      try {
        fs.renameSync(legacy, file);
      } catch (err) {
        console.warn('[mods] Could not adopt the old manifest:', (err as Error).message);
      }
    }
  }
  return file;
}

function readManifest(instanceId: string): Manifest {
  try {
    const raw = fs.readFileSync(manifestPath(instanceId), 'utf8').replace(/^﻿/, '');
    const parsed = JSON.parse(raw) as Manifest;
    return Array.isArray(parsed?.mods) ? parsed : { version: 1, mods: [] };
  } catch {
    return { version: 1, mods: [] };
  }
}

function writeManifest(instanceId: string, manifest: Manifest): void {
  try {
    ensureDir(instanceModsDir(instanceId));
    fs.writeFileSync(manifestPath(instanceId), JSON.stringify(manifest, null, 2), 'utf8');
  } catch (err) {
    console.warn('[mods] Could not write manifest:', (err as Error).message);
  }
}

// ------------------------------------------------------------------- fetching

async function api<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Modrinth returned ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

/** Modrinth's facet syntax: an array of AND-ed arrays of OR-ed terms. */
function facets(minecraftVersion: string, loader: string): string {
  const groups = [[`versions:${minecraftVersion}`], ['project_type:mod']];
  // Vanilla instances have no loader to filter on, and nothing to install into
  // either — but the search still works and is harmless.
  if (loader !== 'vanilla') {
    groups.splice(1, 0, [`categories:${loader}`]);
  }
  return encodeURIComponent(JSON.stringify(groups));
}

interface RawSearch {
  total_hits: number;
  hits: Array<{
    project_id: string;
    slug: string;
    title: string;
    description: string;
    downloads: number;
    icon_url: string | null;
    author: string;
  }>;
}

/**
 * Search both hosts and merge.
 *
 * Modrinth is always queried; CurseForge only when a key is configured, and a
 * failure there does not fail the whole search — one host being down or a key
 * having expired should degrade to the other rather than to nothing.
 */
export async function searchMods(
  instanceId: string,
  query: string,
  offset: number,
  only: ModSource | null = null,
): Promise<{ total: number; results: ModSearchResult[] }> {
  const { instance } = getInstanceSummary(instanceId);
  const { minecraftVersion, loader } = instance.runtime;

  const empty = { total: 0, results: [] as ModSearchResult[] };

  const [modrinth, curse] = await Promise.all([
    only === 'curseforge'
      ? Promise.resolve(empty)
      : searchModrinth(instanceId, query, offset).catch((err: Error) => {
          console.warn('[mods] Modrinth search failed:', err.message);
          return empty;
        }),
    only === 'modrinth' || !curseforge.isConfigured()
      ? Promise.resolve(empty)
      : searchCurseForge(instanceId, minecraftVersion, loader, query, offset).catch((err: Error) => {
          console.warn('[mods] CurseForge search failed:', err.message);
          return empty;
        }),
  ]);

  // Interleaved rather than concatenated: appending CurseForge would bury it
  // below twenty Modrinth results and make the second source look broken.
  const merged: ModSearchResult[] = [];
  for (let i = 0; i < Math.max(modrinth.results.length, curse.results.length); i++) {
    const a = modrinth.results[i];
    const b = curse.results[i];
    if (a) merged.push(a);
    if (b) merged.push(b);
  }

  return { total: modrinth.total + curse.total, results: merged };
}

async function searchCurseForge(
  instanceId: string,
  minecraftVersion: string,
  loader: string,
  query: string,
  offset: number,
): Promise<{ total: number; results: ModSearchResult[] }> {
  const raw = await curseforge.searchMods(minecraftVersion, loader, query, offset);
  const installed = new Set(readManifest(instanceId).mods.map((m) => m.projectId));

  return {
    total: raw.total,
    results: raw.results.map((mod) => ({
      source: 'curseforge' as const,
      projectId: String(mod.id),
      slug: String(mod.id),
      title: mod.name,
      description: mod.summary,
      downloads: mod.downloads,
      iconUrl: mod.iconUrl,
      author: mod.author,
      installed: installed.has(String(mod.id)),
      downloadable: mod.downloadable,
      websiteUrl: mod.websiteUrl,
    })),
  };
}

async function searchModrinth(
  instanceId: string,
  query: string,
  offset: number,
): Promise<{ total: number; results: ModSearchResult[] }> {
  const { instance } = getInstanceSummary(instanceId);
  const { minecraftVersion, loader } = instance.runtime;

  const url =
    `${API}/search?limit=20&offset=${offset}` +
    `&query=${encodeURIComponent(query)}` +
    `&facets=${facets(minecraftVersion, loader)}` +
    // Relevance when searching, downloads when browsing: an empty query with
    // relevance sorting returns an arbitrary-looking list.
    `&index=${query.trim().length > 0 ? 'relevance' : 'downloads'}`;

  const raw = await api<RawSearch>(url);
  const installed = new Set(readManifest(instanceId).mods.map((m) => m.projectId));

  return {
    total: raw.total_hits,
    results: raw.hits.map((hit) => ({
      source: 'modrinth' as const,
      projectId: hit.project_id,
      slug: hit.slug,
      title: hit.title,
      description: hit.description,
      downloads: hit.downloads,
      iconUrl: hit.icon_url,
      author: hit.author,
      installed: installed.has(hit.project_id),
      // Modrinth has no equivalent opt-out: anything searchable is fetchable.
      downloadable: true,
      websiteUrl: `https://modrinth.com/mod/${hit.slug}`,
    })),
  };
}

interface RawVersion {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  version_type: string;
  date_published: string;
  files: Array<{ url: string; filename: string; size: number; primary: boolean; hashes: { sha512?: string } }>;
  dependencies: Array<{ project_id: string | null; version_id: string | null; dependency_type: string }>;
}

/** Versions of one project that fit this instance, newest first. */
export async function listModVersions(instanceId: string, projectId: string): Promise<ModVersion[]> {
  const raw = await fetchVersions(instanceId, projectId);
  return raw.map((version) => ({
    versionId: version.id,
    name: version.name,
    versionNumber: version.version_number,
    versionType: version.version_type,
    fileName: primaryFile(version).filename,
    sizeBytes: primaryFile(version).size,
    datePublished: version.date_published,
  }));
}

async function fetchVersions(instanceId: string, projectId: string): Promise<RawVersion[]> {
  const { instance } = getInstanceSummary(instanceId);
  const { minecraftVersion, loader } = instance.runtime;

  const loaders = encodeURIComponent(JSON.stringify([loader]));
  const versions = encodeURIComponent(JSON.stringify([minecraftVersion]));

  return api<RawVersion[]>(
    `${API}/project/${encodeURIComponent(projectId)}/version` +
      `?loaders=${loaders}&game_versions=${versions}`,
  );
}

/**
 * The file to actually download.
 *
 * A version can carry several — a sources jar, a javadoc jar — and exactly one
 * is flagged primary. Falling back to the first is only for the rare release
 * that flags none.
 */
function primaryFile(version: RawVersion): RawVersion['files'][number] {
  const primary = version.files.find((file) => file.primary);
  if (primary) return primary;
  const first = version.files[0];
  if (!first) throw new Error(`Version ${version.id} has no files`);
  return first;
}

// ---------------------------------------------------------------- installing

export type ModProgress = (message: string) => void;

/**
 * Install a mod and everything it requires.
 *
 * Dependencies are resolved one level at a time and recursively, because a
 * required dependency can have required dependencies of its own — installing
 * only the direct ones is how you end up with a mod that crashes on load
 * complaining about something you have never heard of.
 *
 * @returns the filenames written
 */
export async function installMod(
  instanceId: string,
  projectId: string,
  versionId: string | null,
  source: ModSource,
  progress: ModProgress,
): Promise<string[]> {
  const written: string[] = [];
  const seen = new Set<string>();

  if (source === 'curseforge') {
    await installCurseForge(instanceId, Number(projectId), versionId, false, written, seen, progress);
  } else {
    await installRecursive(instanceId, projectId, versionId, false, written, seen, progress);
  }

  return written;
}

/**
 * CurseForge install, with the same recursive dependency handling.
 *
 * Separate from the Modrinth path rather than abstracted behind a common
 * interface: the two differ in enough places — numeric ids, SHA-1 instead of
 * SHA-512, and a download URL that can legitimately be absent — that a shared
 * abstraction would be mostly branches anyway.
 */
async function installCurseForge(
  instanceId: string,
  modId: number,
  fileId: string | null,
  isDependency: boolean,
  written: string[],
  seen: Set<string>,
  progress: ModProgress,
): Promise<void> {
  const key = String(modId);
  if (seen.has(key)) return;
  seen.add(key);

  const manifest = readManifest(instanceId);
  if (manifest.mods.some((mod) => mod.projectId === key)) {
    progress(`Already installed: ${key}`);
    return;
  }

  const { instance } = getInstanceSummary(instanceId);
  const { minecraftVersion, loader } = instance.runtime;

  const files = await curseforge.listFiles(modId, minecraftVersion, loader);
  const file = fileId
    ? files.find((candidate) => String(candidate.fileId) === fileId) ?? files[0]
    : files[0];

  if (!file) {
    progress(`No compatible build on CurseForge for mod ${modId}; skipped.`);
    return;
  }

  if (!file.downloadUrl) {
    // The author has opted out of third-party distribution. Reported rather
    // than worked around — see the note in curseforge.ts.
    throw new Error(
      `${file.displayName} cannot be downloaded by third-party launchers. ` +
        `Its author has disabled that; download it from CurseForge and drop the jar in the mods folder.`,
    );
  }

  const target = path.join(ensureDir(instanceModsDir(instanceId)), file.fileName);

  progress(`Downloading ${file.fileName}…`);
  // SHA-1 rather than SHA-512: it is the strongest hash CurseForge publishes.
  // Adequate for catching a truncated transfer, which is what this guards.
  await download(file.downloadUrl, target, file.sha1, 'sha1');

  written.push(file.fileName);
  manifest.mods.push({
    projectId: key,
    versionId: String(file.fileId),
    title: file.displayName,
    fileName: file.fileName,
    dependency: isDependency,
    source: 'curseforge',
  });
  writeManifest(instanceId, manifest);

  for (const dependencyId of file.requiredModIds) {
    await installCurseForge(instanceId, dependencyId, null, true, written, seen, progress);
  }
}

async function installRecursive(
  instanceId: string,
  projectId: string,
  versionId: string | null,
  isDependency: boolean,
  written: string[],
  seen: Set<string>,
  progress: ModProgress,
): Promise<void> {
  if (seen.has(projectId)) return;
  seen.add(projectId);

  const manifest = readManifest(instanceId);
  if (manifest.mods.some((mod) => mod.projectId === projectId)) {
    progress(`Already installed: ${projectId}`);
    return;
  }

  const versions = await fetchVersions(instanceId, projectId);
  const version = versionId
    ? versions.find((candidate) => candidate.id === versionId) ?? versions[0]
    : versions[0];

  if (!version) {
    // A dependency with no compatible build is worth saying out loud rather
    // than failing the whole install — the parent mod may still run.
    progress(`No compatible build of ${projectId} for this instance; skipped.`);
    return;
  }

  const file = primaryFile(version);
  const target = path.join(ensureDir(instanceModsDir(instanceId)), file.filename);

  progress(`Downloading ${file.filename}…`);
  await download(file.url, target, file.hashes.sha512 ?? null);

  written.push(file.filename);
  manifest.mods.push({
    projectId,
    versionId: version.id,
    title: version.name,
    fileName: file.filename,
    dependency: isDependency,
    source: 'modrinth',
  });
  writeManifest(instanceId, manifest);

  for (const dependency of version.dependencies) {
    if (dependency.dependency_type !== 'required' || !dependency.project_id) {
      continue;
    }
    await installRecursive(
      instanceId,
      dependency.project_id,
      dependency.version_id,
      true,
      written,
      seen,
      progress,
    );
  }
}

/**
 * Download to a temp name, verify, then rename.
 *
 * The hash check is the point: a truncated download produces a jar that looks
 * present and fails at class-load time with an error that says nothing about
 * the real cause. Verifying before the file takes its final name means a bad
 * transfer can never masquerade as an installed mod.
 */
async function download(
  url: string,
  target: string,
  expectedHash: string | null,
  algorithm: 'sha512' | 'sha1' = 'sha512',
): Promise<void> {
  const temp = `${target}.part`;

  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status} ${response.statusText})`);
  }

  await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(temp));

  if (expectedHash) {
    const actual = createHash(algorithm).update(fs.readFileSync(temp)).digest('hex');
    // Case-insensitive: CurseForge returns SHA-1 in mixed case.
    if (actual.toLowerCase() !== expectedHash.toLowerCase()) {
      fs.rmSync(temp, { force: true });
      throw new Error(`Checksum mismatch for ${path.basename(target)}; the download was corrupt.`);
    }
  }

  fs.renameSync(temp, target);
}

// ------------------------------------------------------------------ listing

/**
 * Everything in the instance's mods folder.
 *
 * Scans the directory rather than trusting the manifest, so a jar dropped in by
 * hand is listed too — just without a title or a project to update from. The
 * manifest only supplies metadata for what we installed.
 */
export function listInstalledMods(instanceId: string): InstalledMod[] {
  const dir = instanceModsDir(instanceId);
  if (!fs.existsSync(dir)) return [];

  const manifest = readManifest(instanceId);
  const byFile = new Map(manifest.mods.map((mod) => [mod.fileName, mod]));

  const result: InstalledMod[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;

    const enabled = entry.name.endsWith('.jar');
    // `.jar.disabled` is the convention every launcher uses, and the game
    // ignores it — so disabling needs no bookkeeping beyond the rename.
    const disabled = entry.name.endsWith('.jar.disabled');
    if (!enabled && !disabled) continue;

    const baseName = disabled ? entry.name.slice(0, -'.disabled'.length) : entry.name;
    const known = byFile.get(baseName);

    result.push({
      fileName: entry.name,
      title: known?.title ?? baseName.replace(/\.jar$/, ''),
      projectId: known?.projectId ?? null,
      enabled,
      dependency: known?.dependency ?? false,
      sizeBytes: fs.statSync(path.join(dir, entry.name)).size,
      /** True when we did not install it — the client core included. */
      external: known === undefined,
      // Entries written before CurseForge support carry no source; they can
      // only have come from Modrinth.
      source: known === undefined ? null : known.source ?? 'modrinth',
    });
  }

  return result.sort((a, b) => a.title.localeCompare(b.title));
}

export function setModEnabled(instanceId: string, fileName: string, enabled: boolean): void {
  const dir = instanceModsDir(instanceId);
  const current = path.join(dir, fileName);
  if (!fs.existsSync(current)) return;

  const base = fileName.endsWith('.disabled') ? fileName.slice(0, -'.disabled'.length) : fileName;
  const wanted = path.join(dir, enabled ? base : `${base}.disabled`);

  if (path.resolve(current) !== path.resolve(wanted)) {
    fs.renameSync(current, wanted);
  }
}

export function removeMod(instanceId: string, fileName: string): void {
  const dir = instanceModsDir(instanceId);
  const target = path.resolve(dir, fileName);

  // Never delete outside the instance's own mods folder, whatever the caller
  // sent — a filename is untrusted input from the renderer.
  if (!target.startsWith(path.resolve(dir) + path.sep)) {
    console.error(`[mods] Refusing to delete outside the mods folder: ${target}`);
    return;
  }

  fs.rmSync(target, { force: true });

  const base = fileName.endsWith('.disabled') ? fileName.slice(0, -'.disabled'.length) : fileName;
  const manifest = readManifest(instanceId);
  manifest.mods = manifest.mods.filter((mod) => mod.fileName !== base);
  writeManifest(instanceId, manifest);
}
