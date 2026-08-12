/**
 * Template registry: the runtime eras an instance can be created from.
 *
 * A template is a complete description of a runtime — loader build, the version
 * id its installer produces, the JVM era that must run it, and the bootstrap
 * flags needed to get our client core loaded. Everything here is deliberately
 * *not* user-editable: getting the JVM era or the core jar wrong produces a
 * crash that is genuinely hard to attribute back to a setting.
 *
 * `instances.ts` combines a template with the per-instance settings (name,
 * memory, extra flags) to produce the `ClientProfile` that `launch.ts` consumes.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { app } from 'electron';

import { DIRS } from './paths';
import type { InstanceTemplate, JavaInstallation, LoaderKind } from '../shared/types';

/**
 * Where the compiled client-core jars live.
 * In development that's `<repo>/artifacts`; in a packaged build electron-builder
 * copies the same folder into `process.resourcesPath/artifacts`.
 */
function artifactsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'artifacts')
    : path.resolve(app.getAppPath(), '..', 'artifacts');
}

function artifact(fileName: string): string {
  return path.join(artifactsDir(), fileName);
}

/**
 * Persisted JVM locations: `~/.blxxdlauncher/launcher/runtimes.json`
 *
 *   { "8": "C:\\...\\jdk-8...", "21": "C:\\...\\jdk-21..." }
 *
 * This exists because an environment variable is the wrong mechanism for a
 * double-clickable app: a variable set in a terminal is invisible to a shortcut
 * launched from Explorer, so the app would silently pick the wrong JVM and the
 * game would die with UnsupportedClassVersionError. A config file is read the
 * same way no matter how the process was started.
 */
const RUNTIMES_FILE = path.join(DIRS.launcherState, 'runtimes.json');

function readConfiguredRuntimes(): Record<string, string> {
  try {
    if (!fs.existsSync(RUNTIMES_FILE)) return {};

    // Strip a UTF-8 BOM before parsing. Every native Windows tool writes one —
    // Notepad, `Out-File -Encoding utf8` on PowerShell 5.1, `Set-Content` — and
    // JSON.parse rejects it with "Unexpected token". Left unhandled this fails
    // in the worst possible way: the catch below swallows it, resolution falls
    // through to PATH, and the app launches a 1.21 profile on Java 8.
    const raw = fs.readFileSync(RUNTIMES_FILE, 'utf8').replace(/^﻿/, '');

    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch (err) {
    console.warn('[profiles] Ignoring unreadable runtimes.json:', (err as Error).message);
    return {};
  }
}

/** Accept either a JDK home or a direct path to the executable. */
function normaliseJavaPath(candidate: string, exe: string): string | null {
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || !fs.existsSync(trimmed)) return null;
  if (fs.statSync(trimmed).isDirectory()) {
    const inBin = path.join(trimmed, 'bin', exe);
    return fs.existsSync(inBin) ? inBin : null;
  }
  return trimmed;
}

/**
 * The Java major from which a newer JVM is an acceptable substitute.
 *
 * Below this line it is not. Minecraft 1.7.10 through 1.12 run on a
 * LaunchWrapper stack that reflects into JDK internals Java 9 sealed off, so
 * "just use a newer JDK" there is a guaranteed crash rather than a permitted
 * upgrade. From 1.17 onwards (Java 17+) the platform is stable in the usual
 * backward-compatible way and running on a later JDK is routine — modded packs
 * frequently *require* it.
 */
export const MODERN_JAVA = 17;

/**
 * Resolve a java executable for a given major version.
 *
 * Resolution order:
 *   1. `MCC_JAVA_21` / `MCC_JAVA_8` env override — highest priority, for CI and
 *      one-off experiments.
 *   2. `~/.blxxdlauncher/launcher/runtimes.json`, exact major — the durable
 *      answer, and the one that works when the app is launched from a shortcut.
 *   3. `runtimes.json`, lowest configured major above the requirement, for
 *      modern versions only. See below.
 *   4. A conventional install location.
 *   5. Bare `java` on PATH (last resort; wrong for at least one profile on a
 *      machine that has both JDKs).
 *
 * Step 3 exists because the required major comes from Mojang's
 * `javaVersion.majorVersion`, which is a *minimum*, not an exact requirement.
 * Somebody with `{"8": ..., "21": ...}` configured — a perfectly sensible pair
 * covering the legacy and modern eras — would otherwise have no JVM at all for
 * a 1.20.1 instance, which asks for 17. Falling through to the filesystem scan
 * in that situation is worse than it looks: it silently prefers whatever JDK 17
 * happens to be installed over the one the user explicitly configured, and a
 * pack that needs 21 then dies deep inside mod init with an error naming a
 * mixin config rather than a JVM.
 *
 * Explicit configuration outranks a filesystem guess. That is the whole point
 * of runtimes.json.
 */
export function resolveJava(major: number): string {
  const exe = process.platform === 'win32' ? 'javaw.exe' : 'java';

  const override = process.env[`MCC_JAVA_${major}`];
  if (override) {
    const resolved = normaliseJavaPath(override, exe);
    if (resolved) return resolved;
  }

  const runtimes = readConfiguredRuntimes();

  const configured = runtimes[String(major)];
  if (configured) {
    const resolved = normaliseJavaPath(configured, exe);
    if (resolved) return resolved;
    console.warn(`[profiles] runtimes.json points at a missing JDK ${major}: ${configured}`);
  }

  if (major >= MODERN_JAVA) {
    // Lowest first: closest to what the version actually asked for.
    const newer = Object.keys(runtimes)
      .map(Number)
      .filter((m) => Number.isFinite(m) && m > major)
      .sort((a, b) => a - b);

    for (const candidate of newer) {
      const resolved = normaliseJavaPath(runtimes[String(candidate)] ?? '', exe);
      if (resolved) {
        console.log(`[profiles] No JDK ${major} configured; using the configured JDK ${candidate}.`);
        return resolved;
      }
    }
  }

  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const vendors = ['Eclipse Adoptium', 'Java', 'Microsoft', 'Zulu'];
    for (const vendor of vendors) {
      const base = path.join(programFiles, vendor);
      if (!fs.existsSync(base)) continue;
      const hit = fs
        .readdirSync(base)
        .filter((d) => d.includes(`-${major}`) || d.includes(`jdk${major}`) || d.includes(`jdk-${major}`))
        .map((d) => path.join(base, d, 'bin', exe))
        .find((p) => fs.existsSync(p));
      if (hit) return hit;
    }
  }

  return exe.replace('javaw.exe', 'java.exe');
}

/**
 * Every JVM we can find, so the user can pick one per instance.
 *
 * `resolveJava` answers "give me something that will run this"; this answers
 * "what are my options". They are different questions and the second one cannot
 * be derived from the first — automatic resolution deliberately returns a single
 * answer, and the whole point of an override is disagreeing with it.
 *
 * Each candidate is probed with `java -version` rather than trusted from its
 * directory name. A folder called `jdk-17` may hold anything, and a wrong guess
 * here would be presented to the user as fact.
 */
export function detectJavaInstallations(): JavaInstallation[] {
  const exe = process.platform === 'win32' ? 'javaw.exe' : 'java';
  const found = new Map<string, JavaInstallation>();

  const consider = (candidate: string, source: JavaInstallation['source']): void => {
    const resolved = normaliseJavaPath(candidate, exe);
    if (!resolved) return;

    const key = resolved.toLowerCase();
    // First writer wins, and configured entries are offered first, so a JDK
    // listed in runtimes.json is labelled as configured rather than detected.
    if (found.has(key)) return;

    const probed = probeJavaVersion(resolved);
    if (!probed) return;

    found.set(key, { path: resolved, major: probed.major, version: probed.version, source });
  };

  for (const configured of Object.values(readConfiguredRuntimes())) {
    consider(configured, 'configured');
  }

  if (process.env['JAVA_HOME']) {
    consider(process.env['JAVA_HOME'], 'detected');
  }

  if (process.platform === 'win32') {
    const roots = [process.env['ProgramFiles'] ?? 'C:\\Program Files', process.env['ProgramFiles(x86)']]
      .filter((r): r is string => typeof r === 'string' && r.length > 0);

    for (const root of roots) {
      for (const vendor of ['Eclipse Adoptium', 'Java', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft']) {
        const base = path.join(root, vendor);
        if (!fs.existsSync(base)) continue;
        try {
          for (const dir of fs.readdirSync(base)) {
            consider(path.join(base, dir), 'detected');
          }
        } catch {
          /* Unreadable vendor directory; skip it. */
        }
      }
    }
  }

  // Ascending, so the list reads like a version ladder rather than filesystem
  // order — which is what someone choosing between 17 and 21 is thinking about.
  return [...found.values()].sort((a, b) => a.major - b.major || a.path.localeCompare(b.path));
}

/** @returns the JVM's major and full version, or null if it will not run. */
function probeJavaVersion(javaPath: string): { major: number; version: string } | null {
  // -version writes to stderr on every JVM ever shipped.
  const probe = spawnSync(javaPath, ['-version'], { encoding: 'utf8', windowsHide: true });
  if (probe.error) return null;

  const output = `${probe.stderr ?? ''}${probe.stdout ?? ''}`;
  // Matches both `1.8.0_492` (Java 8 and earlier) and `21.0.11` (9+).
  const match = /version "((\d+)(?:\.(\d+))?[^"]*)"/.exec(output);
  if (!match) return null;

  const first = Number(match[2]);
  const major = first === 1 ? Number(match[3] ?? 0) : first;
  return Number.isFinite(major) && major > 0 ? { major, version: match[1] ?? String(major) } : null;
}

/** Modern era: Minecraft 1.21.1 on NeoForge, Java 21, Mixin-driven. */
const MODERN: InstanceTemplate = {
  id: 'modern-1.21.1',
  name: '1.21.1 — NeoForge',
  summary: 'Modern era. Mixin-based client core, Java 21.',
  minecraftVersion: '1.21.1',
  loader: 'neoforge',
  loaderVersion: '21.1.209',
  versionId: 'neoforge-21.1.209',
  installerUrl:
    'https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.209/neoforge-21.1.209-installer.jar',
  javaMajor: 21,
  javaPath: resolveJava(21),
  clientCoreJar: artifact('blxxdlauncher-core-1.21.1-0.1.0.jar'),
  extraJvmArgs: [
    // G1 tuning that actually matters for heavily modded 1.21 packs.
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+UseG1GC',
    '-XX:G1NewSizePercent=20',
    '-XX:G1ReservePercent=20',
    '-XX:MaxGCPauseMillis=50',
    '-XX:G1HeapRegionSize=32M',
    '-XX:+AlwaysPreTouch',
    '-XX:+DisableExplicitGC',
    // Mixin: keep the transformed bytecode on disk when debugging a failing
    // injection point. Flip to true while iterating on MixinMinecraft.
    '-Dmixin.debug.export=false',
    '-Dmixin.debug.verbose=false',
    // Identify our own build in crash reports.
    '-Dblxxdlauncher.branding=modern',
  ],
  // Empty by design. The core jar reaches the game through <gameDir>/mods.
  // Putting a NeoForge mod on the system classpath as well is actively harmful:
  // classes loaded by the app class loader bypass ModLauncher's transforming
  // layer, so mixins silently fail to apply to them.
  extraClasspath: [],
  accent: '#5B8CFF',
};

/** Legacy era: Minecraft 1.7.10 on Forge, Java 8, ASM coremod-driven. */
const LEGACY: InstanceTemplate = {
  id: 'legacy-1.7.10',
  name: '1.7.10 — Forge',
  summary: 'Legacy era for old modded setups. ASM coremod, Java 8.',
  minecraftVersion: '1.7.10',
  loader: 'forge',
  loaderVersion: '10.13.4.1614-1.7.10',
  versionId: '1.7.10-Forge10.13.4.1614-1.7.10',
  installerUrl:
    'https://maven.minecraftforge.net/net/minecraftforge/forge/1.7.10-10.13.4.1614-1.7.10/forge-1.7.10-10.13.4.1614-1.7.10-installer.jar',
  javaMajor: 8,
  javaPath: resolveJava(8),
  clientCoreJar: artifact('blxxdlauncher-core-1.7.10-0.1.0.jar'),
  extraJvmArgs: [
    // 1.7.10 predates G1 tuning being useful here; CMS is the era-correct choice.
    '-XX:+UseConcMarkSweepGC',
    '-XX:+CMSIncrementalMode',
    '-XX:-UseAdaptiveSizePolicy',
    // 1.7.10 ships a Java 6-era LaunchWrapper; PermGen still exists on Java 8
    // only as metaspace, but old packs still expect a generous limit.
    '-XX:MaxMetaspaceSize=512M',
    '-Dfml.ignoreInvalidMinecraftCertificates=true',
    '-Dfml.ignorePatchDiscrepancies=true',
    '-Dblxxdlauncher.branding=legacy',
    // NOTE: -Dfml.coreMods.load is deliberately absent. The jar ships with an
    // `FMLCorePlugin` manifest attribute (see client-core-1.7.10/build.gradle),
    // so FML discovers the loading plugin when it scans mods/. Setting the
    // property as well would construct the plugin a second time.
  ],
  extraClasspath: [],
  // Amber, so the two eras are never confused at a glance in the grid.
  accent: '#FFB454',
};

const TEMPLATES: readonly InstanceTemplate[] = [MODERN, LEGACY];

/**
 * The eras a client core has actually been built for.
 *
 * Every other Minecraft version and loader is launchable, but launches as plain
 * (modded) Minecraft: a NeoForge 1.21.1 mixin jar cannot load on Fabric 1.20.1,
 * and the 1.7.10 coremod cannot load anywhere else. The UI says so on the card
 * rather than letting someone discover it after a five-minute download.
 */
export function clientCoreFor(minecraftVersion: string, loader: LoaderKind): string | null {
  for (const template of TEMPLATES) {
    if (template.minecraftVersion === minecraftVersion && template.loader === loader) {
      return preferDevEdition(template.clientCoreJar);
    }
  }
  return null;
}

/**
 * Use the Dev core jar when one has been built, otherwise the release jar.
 *
 * The client core ships in two editions from one source tree: `-dev-` carries
 * every module, the plain name carries the set intended for other people. Only
 * one is normally present, so preferring dev is really "use whichever exists"
 * — with a defined answer when both do.
 *
 * Resolved per call rather than once at load, so rebuilding the other edition
 * takes effect without restarting the launcher. It is two `existsSync` calls
 * against a path we were about to stat anyway.
 */
function preferDevEdition(releaseJar: string): string {
  const dev = releaseJar.replace(/-core-(?=\d)/, '-core-dev-');
  if (dev !== releaseJar && fs.existsSync(dev)) {
    return dev;
  }
  return releaseJar;
}

/** Per-loader JVM flags. Era-appropriate GC tuning, plus loader bootstrapping. */
export function jvmArgsFor(loader: LoaderKind, javaMajor: number): string[] {
  const args: string[] = [];

  // G1 is the right collector from Java 9 onwards and is what every modern pack
  // is tuned against. Java 8 predates it being a good default here; CMS is the
  // era-correct choice and the only one 1.7.10-era packs expect.
  if (javaMajor >= 9) {
    args.push(
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:+UseG1GC',
      '-XX:G1NewSizePercent=20',
      '-XX:G1ReservePercent=20',
      '-XX:MaxGCPauseMillis=50',
      '-XX:G1HeapRegionSize=32M',
      '-XX:+AlwaysPreTouch',
      '-XX:+DisableExplicitGC',
    );
  } else {
    args.push(
      '-XX:+UseConcMarkSweepGC',
      '-XX:+CMSIncrementalMode',
      '-XX:-UseAdaptiveSizePolicy',
      '-XX:MaxMetaspaceSize=512M',
    );
  }

  if (loader === 'forge') {
    // Harmless on modern Forge, required on 1.7.10-era packs whose jars fail
    // Mojang's certificate check.
    args.push('-Dfml.ignoreInvalidMinecraftCertificates=true', '-Dfml.ignorePatchDiscrepancies=true');
  }

  if (loader === 'neoforge' || loader === 'forge') {
    args.push('-Dmixin.debug.export=false', '-Dmixin.debug.verbose=false');
  }

  args.push(`-Dblxxdlauncher.branding=${loader}`);
  return args;
}

/** Card accent, by loader family, so instances are told apart at a glance. */
export function accentFor(loader: LoaderKind): string {
  switch (loader) {
    case 'neoforge':
      return '#5B8CFF';
    case 'forge':
      return '#FFB454';
    case 'fabric':
      return '#C8A2F0';
    default:
      return '#6EE7A8';
  }
}

/** Where a loader's installer jar lives, or null when it needs none. */
export function installerUrlFor(
  minecraftVersion: string,
  loader: LoaderKind,
  loaderVersion: string,
): string | null {
  switch (loader) {
    case 'neoforge':
      return (
        `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/` +
        `neoforge-${loaderVersion}-installer.jar`
      );
    case 'forge':
      // The maven coordinate is the full `<mc>-<build>` string, which is what
      // the version list already yields — no reassembly, nothing to get wrong.
      return (
        `https://maven.minecraftforge.net/net/minecraftforge/forge/${loaderVersion}/` +
        `forge-${loaderVersion}-installer.jar`
      );
    default:
      // Vanilla needs nothing; Fabric's profile JSON is fetched from its meta
      // API and written directly. See loader-install.ts.
      return null;
  }
}

/**
 * True for Minecraft versions before the 1.13 "Flattening", which is where
 * Forge changed both its installer format and its version naming.
 *
 * Anything unparseable (a snapshot id like `26.3-snapshot-7`) is treated as
 * modern, which is the safe default — the old scheme has been dead since 2018.
 */
function isPre113(minecraftVersion: string): boolean {
  const match = /^1\.(\d+)/.exec(minecraftVersion);
  return match !== null && Number(match[1]) < 13;
}

/** The version id a loader writes into `<root>/versions/`. */
export function versionIdFor(
  minecraftVersion: string,
  loader: LoaderKind,
  loaderVersion: string,
): string {
  switch (loader) {
    case 'neoforge':
      return `neoforge-${loaderVersion}`;
    case 'forge': {
      // Forge has used two naming schemes, and the boundary is the 1.13 rewrite:
      //
      //   pre-1.13   1.7.10-Forge10.13.4.1614-1.7.10   (no separator, capital F)
      //   1.13+      1.20.1-forge-47.4.22             (hyphenated, lowercase)
      //
      // The maven coordinate is `<mc>-<build>` in both eras, so the build part
      // is everything after the Minecraft version. Getting this wrong is not
      // subtle — `ensureLoaderInstalled` fails with "installer completed but
      // <id>.json was not produced" — but it fails *after* a multi-minute
      // download, which is exactly the kind of wasted wait worth avoiding.
      const build = loaderVersion.startsWith(`${minecraftVersion}-`)
        ? loaderVersion.slice(minecraftVersion.length + 1)
        : loaderVersion;
      return isPre113(minecraftVersion)
        ? `${minecraftVersion}-Forge${build}`
        : `${minecraftVersion}-forge-${build}`;
    }
    case 'fabric':
      return `fabric-loader-${loaderVersion}-${minecraftVersion}`;
    default:
      return minecraftVersion;
  }
}

export function listTemplates(): InstanceTemplate[] {
  return [...TEMPLATES];
}

export function getTemplate(id: string): InstanceTemplate {
  const template = TEMPLATES.find((t) => t.id === id);
  if (!template) throw new Error(`Unknown template id: ${id}`);
  return template;
}

/** The template every fresh install seeds its first instance from. */
export const DEFAULT_TEMPLATE_ID = MODERN.id;
