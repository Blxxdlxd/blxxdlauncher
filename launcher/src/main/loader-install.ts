/**
 * Loader provisioning.
 *
 * MCLC can bootstrap vanilla on its own, but it cannot *generate* a NeoForge or
 * modern-Forge version profile. Both loaders ship an installer jar that:
 *   1. downloads/patches the libraries it needs into <root>/libraries
 *   2. writes <root>/versions/<versionId>/<versionId>.json
 *
 * We run that installer once, headlessly, into our isolated root, then hand
 * MCLC the resulting version id via `version.custom`. This is the same code
 * path the official installers use, so we inherit their correctness instead of
 * reimplementing library patching.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import AdmZip from 'adm-zip';

import { DIRS, ensureDir } from './paths';
import { downloadFile } from './assets';
import { fabricProfileJson } from './versions';
import type { ClientProfile } from '../shared/types';

export type StatusSink = (message: string) => void;

/** Has the installer already produced a usable version profile? */
export function isLoaderInstalled(profile: ClientProfile): boolean {
  const manifest = path.join(DIRS.versions, profile.versionId, `${profile.versionId}.json`);
  return fs.existsSync(manifest);
}

/** Download the installer jar into <root>/runtime, skipping if already cached. */
async function fetchInstaller(profile: ClientProfile, status: StatusSink): Promise<string> {
  ensureDir(DIRS.runtime);
  const target = path.join(DIRS.runtime, `${profile.versionId}-installer.jar`);

  if (fs.existsSync(target) && fs.statSync(target).size > 0) {
    return target;
  }

  if (profile.installerUrl === null) {
    throw new Error(`${profile.loader} has no installer URL; this is a launcher bug.`);
  }

  status(`Downloading ${profile.loader} installer…`);

  const response = await fetch(profile.installerUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Installer download failed (${response.status} ${response.statusText}) for ${profile.installerUrl}`);
  }

  // Write to a temp name first so an interrupted download never leaves a
  // truncated jar that looks cached on the next run.
  const temp = `${target}.part`;
  await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(temp));
  fs.renameSync(temp, target);

  return target;
}

/** Shape of the 2015-era `install_profile.json` (legacy Forge installers). */
interface LegacyInstallProfile {
  install?: {
    /** Maven coordinate of the universal jar, e.g. `net.minecraftforge:forge:1.7.10-...`. */
    path: string;
    /** Entry name of that jar *inside* the installer archive. */
    filePath: string;
    target: string;
  };
  /** A complete, ready-to-use version manifest. Only present in the old format. */
  versionInfo?: { id: string; [key: string]: unknown };
}

/**
 * True when the installer is the pre-1.13 kind that cannot be run headlessly.
 *
 * Detected by content, not by version number: the presence of `versionInfo` in
 * `install_profile.json` is precisely what distinguishes the old self-contained
 * format from the modern processor-driven one.
 */
function isLegacyInstaller(installerJar: string): boolean {
  try {
    const entry = new AdmZip(installerJar).getEntry('install_profile.json');
    if (!entry) return false;
    const parsed = JSON.parse(
      new AdmZip(installerJar).readAsText(entry).replace(/^﻿/, ''),
    ) as LegacyInstallProfile;
    return Boolean(parsed.versionInfo && parsed.install);
  } catch {
    // Unreadable archive: let the modern path run and report the real error.
    return false;
  }
}

/** `group:artifact:version[:classifier]` -> `group/path/artifact/version/artifact-version.jar` */
function mavenCoordinateToPath(coordinate: string): { dir: string; fileName: string } {
  const [group = '', artifact = '', version = '', classifier] = coordinate.split(':');
  return {
    dir: path.join(group.replace(/\./g, path.sep), artifact, version),
    fileName: `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`,
  };
}

/**
 * Provision a legacy (pre-1.13) Forge install by unpacking the installer.
 *
 * **Why this exists.** The modern flow — `java -jar installer.jar
 * --installClient <dir>` — simply does not apply here. The 1.7.10 installer's
 * `SimpleInstaller` predates that option entirely and dies with:
 *
 * ```
 * joptsimple.UnrecognizedOptionException: 'installClient' is not a recognized option
 * ```
 *
 * It only understands `--installServer` and `--extract`; a *client* install was
 * GUI-only, which is useless to a launcher.
 *
 * Fortunately nothing needs executing. The archive is self-contained:
 *  - `install_profile.json` -> `versionInfo` is a complete version manifest
 *  - `install.filePath` names the universal jar bundled alongside it
 *
 * So we write the manifest and drop the jar at the Maven path MCLC will look
 * for. MCLC's `downloadToDirectory` handles old-format libraries (no
 * `downloads` block) by deriving the path from `name` and fetching via
 * `library.url`, and it skips anything already on disk — which is exactly how
 * the universal jar, absent from any Maven repo under that name, gets found.
 */
function installLegacyLoader(profile: ClientProfile, installerJar: string, status: StatusSink): void {
  const zip = new AdmZip(installerJar);

  const profileEntry = zip.getEntry('install_profile.json');
  if (!profileEntry) {
    throw new Error(`${path.basename(installerJar)} has no install_profile.json`);
  }

  const parsed = JSON.parse(
    zip.readAsText(profileEntry).replace(/^﻿/, ''),
  ) as LegacyInstallProfile;

  if (!parsed.versionInfo || !parsed.install) {
    throw new Error('install_profile.json is not in the legacy format');
  }

  const versionId = parsed.versionInfo.id;
  if (versionId !== profile.versionId) {
    // Loud rather than silent: a mismatch means every later path lookup is wrong.
    status(
      `WARNING: installer produces version id "${versionId}" but the profile expects ` +
        `"${profile.versionId}". Update profiles.ts.`,
    );
  }

  // 1. The version manifest.
  const versionDir = ensureDir(path.join(DIRS.versions, versionId));
  fs.writeFileSync(
    path.join(versionDir, `${versionId}.json`),
    JSON.stringify(parsed.versionInfo, null, 2),
    'utf8',
  );
  status(`Wrote ${versionId}.json`);

  // 2. The universal jar, at the Maven path MCLC derives from the library name.
  const { dir, fileName } = mavenCoordinateToPath(parsed.install.path);
  const targetDir = ensureDir(path.join(DIRS.libraries, dir));
  const target = path.join(targetDir, fileName);

  const jarEntry = zip.getEntry(parsed.install.filePath);
  if (!jarEntry) {
    throw new Error(`Installer does not contain ${parsed.install.filePath}`);
  }
  fs.writeFileSync(target, jarEntry.getData());
  status(`Extracted ${fileName} (${(jarEntry.header.size / 1024 / 1024).toFixed(1)} MB)`);
}

/** A library entry in a legacy (pre-1.13) version manifest. */
interface LegacyLibrary {
  name: string;
  /** Absent for anything hosted on Mojang's default Maven. */
  url?: string;
  downloads?: unknown;
  natives?: Record<string, string>;
  clientreq?: boolean;
  rules?: unknown;
}

/** Mojang's default Maven, used when a legacy library entry omits `url`. */
const MOJANG_LIBRARIES = 'https://libraries.minecraft.net/';

/**
 * Download legacy libraries MCLC will not fetch.
 *
 * MCLC's `downloadToDirectory` only downloads when `library.url` or
 * `library.downloads.artifact.url` is set:
 *
 * ```js
 * if (library.url) { ...download... }
 * else if (library.downloads?.artifact?.url) { ...download... }
 * // else: nothing happens
 * ```
 *
 * Pre-1.13 manifests omit `url` for everything hosted on Mojang's default
 * Maven — that is the format's convention, not an error. MCLC has no fallback
 * for it, so those jars are silently never fetched *and their paths are still
 * appended to the classpath*. For Forge 1.7.10 that means 6 of 18 libraries go
 * missing, including `net.minecraft:launchwrapper`, producing:
 *
 * ```
 * Error: Could not find or load main class net.minecraft.launchwrapper.Launch
 * ```
 *
 * Filling the gap here is cheap and keeps MCLC unpatched. Runs on every launch;
 * with a warm library store it is just stat() calls.
 */
async function ensureLegacyLibraries(profile: ClientProfile, status: StatusSink): Promise<void> {
  const manifestPath = path.join(DIRS.versions, profile.versionId, `${profile.versionId}.json`);
  if (!fs.existsSync(manifestPath)) return;

  let manifest: { libraries?: LegacyLibrary[] };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^﻿/, ''));
  } catch {
    return;
  }

  const libraries = manifest.libraries ?? [];
  const missing: Array<{ url: string; target: string; name: string }> = [];

  for (const library of libraries) {
    // Modern entries carry their own download info; MCLC handles those.
    if (library.downloads) continue;
    // Natives are extracted by MCLC from the vanilla manifest, not from here.
    if (library.natives) continue;
    // Forge marks server-only entries explicitly.
    if (library.clientreq === false) continue;

    const [group = '', artifact = '', version = ''] = library.name.split(':');
    const fileName = `${artifact}-${version}.jar`;
    const target = path.join(DIRS.libraries, group.replace(/\./g, path.sep), artifact, version, fileName);

    if (fs.existsSync(target) && fs.statSync(target).size > 0) continue;

    const base = library.url && library.url.length > 0 ? library.url : MOJANG_LIBRARIES;
    const url =
      `${base.replace(/\/?$/, '/')}` +
      `${group.replace(/\./g, '/')}/${artifact}/${version}/${fileName}`;

    missing.push({ url, target, name: library.name });
  }

  if (missing.length === 0) return;

  status(`Fetching ${missing.length} legacy libraries MCLC skips…`);
  for (const entry of missing) {
    status(`  ${entry.name}`);
    await downloadFile(entry.url, entry.target);
  }
  status(`Legacy libraries complete (${missing.length} fetched).`);
}

/**
 * The installer refuses to run unless a launcher_profiles.json exists in the
 * target directory (it tries to add a profile entry). Ours is isolated and has
 * never been touched by the vanilla launcher, so we seed a stub.
 */
function seedLauncherProfiles(): void {
  const file = path.join(DIRS.root, 'launcher_profiles.json');
  if (fs.existsSync(file)) return;
  fs.writeFileSync(
    file,
    JSON.stringify({ profiles: {}, selectedProfile: '', clientToken: '', authenticationDatabase: {}, version: 3 }, null, 2),
    'utf8',
  );
}

/** Run `java -jar <installer> --installClient <root>` and wait for exit 0. */
function runInstaller(javaPath: string, installerJar: string, status: StatusSink): Promise<void> {
  return new Promise((resolve, reject) => {
    // NOTE: use `java`, not `javaw` — we need the console streams.
    const javaExe = javaPath.replace(/javaw(\.exe)?$/i, (m) => m.replace('javaw', 'java'));

    const child = spawn(javaExe, ['-jar', installerJar, '--installClient', DIRS.root], {
      cwd: DIRS.root,
      windowsHide: true,
    });

    child.stdout.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim();
      if (line) status(line.split('\n').pop() ?? line);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim();
      if (line) console.warn('[installer]', line);
    });

    child.on('error', (err) =>
      reject(new Error(`Could not start the installer JVM at "${javaExe}": ${err.message}`)),
    );

    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(installerJar)} exited with code ${code}`));
    });
  });
}

/**
 * Install Fabric by writing the profile its meta API already produces.
 *
 * The returned JSON's `id` is authoritative — we write to whatever it says
 * rather than to our predicted `versionId`, so a naming change upstream shows
 * up as a mismatch here rather than as "installer completed but nothing was
 * produced" at launch. Verified against 1.21.1 + loader 0.16.10:
 * `id: fabric-loader-0.16.10-1.21.1`, `inheritsFrom: 1.21.1`, 8 libraries.
 *
 * MCLC resolves the libraries itself from the manifest, so nothing else needs
 * downloading here.
 */
async function installFabric(profile: ClientProfile, status: StatusSink): Promise<void> {
  status(`Fetching Fabric ${profile.loaderVersion} for ${profile.minecraftVersion}…`);

  const body = await fabricProfileJson(profile.minecraftVersion, profile.loaderVersion);
  const parsed = JSON.parse(body) as { id?: string };

  if (typeof parsed.id !== 'string' || parsed.id.length === 0) {
    throw new Error('Fabric returned a profile with no id.');
  }
  if (parsed.id !== profile.versionId) {
    throw new Error(
      `Fabric named this profile "${parsed.id}" but the instance expects "${profile.versionId}". ` +
        `Recreate the instance to pick it up.`,
    );
  }

  const dir = ensureDir(path.join(DIRS.versions, parsed.id));
  fs.writeFileSync(path.join(dir, `${parsed.id}.json`), body, 'utf8');

  status(`Fabric ${profile.loaderVersion} installed.`);
}

/**
 * Idempotently ensure `<root>/versions/<versionId>` exists.
 * Safe to call before every launch; a no-op once installed.
 */
export async function ensureLoaderInstalled(profile: ClientProfile, status: StatusSink): Promise<void> {
  if (profile.loader === 'vanilla') {
    return;
  }

  // Fabric has no installer to run at all. Its meta API serves a complete
  // version JSON with `inheritsFrom` already set, so installing is writing one
  // file — no jar to download, no processors, no headless-install problem.
  if (profile.loader === 'fabric') {
    if (isLoaderInstalled(profile)) return;
    await installFabric(profile, status);
    return;
  }

  if (isLoaderInstalled(profile)) {
    // The manifest existing does not mean the libraries do. Verify every time:
    // a previous run can leave a complete manifest beside missing jars, which
    // fails at JVM start with an unhelpful "could not find main class".
    await ensureLegacyLibraries(profile, status);
    return;
  }

  seedLauncherProfiles();
  const installerJar = await fetchInstaller(profile, status);

  status(`Installing ${profile.loader} ${profile.loaderVersion}…`);

  // Pick the provisioning strategy from the installer's own format rather than
  // from the Minecraft version: `versionInfo` is present only in pre-1.13
  // installers, and it is exactly the marker for "cannot be driven headlessly".
  if (isLegacyInstaller(installerJar)) {
    status('Legacy installer detected — unpacking directly (no headless client install available).');
    installLegacyLoader(profile, installerJar, status);
  } else {
    await runInstaller(profile.javaPath, installerJar, status);
  }

  if (!isLoaderInstalled(profile)) {
    throw new Error(
      `Installer completed but ${profile.versionId}.json was not produced. ` +
        `Check that versionId matches what the installer writes into <root>/versions.`,
    );
  }

  await ensureLegacyLibraries(profile, status);

  status(`${profile.loader} ${profile.loaderVersion} installed.`);
}
