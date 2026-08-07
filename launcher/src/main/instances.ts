/**
 * Instance registry: named, independently-configured installs.
 *
 * An instance is a template plus the handful of things that genuinely differ
 * between two installs of the same version — its name, its heap, its own
 * worlds and mods. Everything era-specific (which loader build, which JVM,
 * which client-core jar) stays in the template, because those are not
 * preferences: getting one wrong is a crash, not a different experience.
 *
 * Layout: each instance owns `<root>/instances/<id>` — mods, config, saves,
 * options.txt — while the expensive immutable stores (assets, libraries,
 * versions, natives) stay shared. Two 1.21 instances cost one asset download
 * between them.
 *
 * Persistence: `<root>/launcher/instances.json`. Written on every mutation and
 * read once at startup.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { DIRS, ensureDir, instanceDir } from './paths';
import {
  accentFor,
  clientCoreFor,
  installerUrlFor,
  jvmArgsFor,
  listTemplates,
  resolveJava,
  versionIdFor,
} from './profiles';
import { javaMajorFor } from './versions';
import type {
  ClientProfile,
  Instance,
  InstanceDraft,
  InstancePatch,
  InstanceSummary,
  RuntimeSpec,
} from '../shared/types';

const INSTANCES_FILE = path.join(DIRS.launcherState, 'instances.json');

/** Shape actually written to disk. Versioned so a future migration has a hook. */
interface InstanceDocument {
  version: 1;
  instances: Instance[];
}

const DEFAULT_MEMORY_MAX = '8G';
const DEFAULT_MEMORY_MIN = '4G';

/** In-memory registry. Loaded once; every mutation writes straight through. */
let registry: Instance[] | null = null;

// --------------------------------------------------------------- persistence

function readDocument(): Instance[] {
  try {
    if (!fs.existsSync(INSTANCES_FILE)) return [];

    // Same BOM defence as runtimes.json: every native Windows editor writes
    // one, and JSON.parse rejects it with a message that looks nothing like
    // "your file has a BOM".
    const raw = fs.readFileSync(INSTANCES_FILE, 'utf8').replace(/^﻿/, '');
    const parsed = JSON.parse(raw) as Partial<InstanceDocument>;

    if (!Array.isArray(parsed.instances)) return [];
    return parsed.instances.map(migrate).filter(isUsable);
  } catch (err) {
    // A damaged registry must not stop the launcher opening — the user needs
    // the window to fix it from. The file is left alone rather than
    // overwritten, so nothing is destroyed by a transient read failure.
    console.warn('[instances] Ignoring unreadable instances.json:', (err as Error).message);
    return [];
  }
}

/**
 * Bring a first-generation entry forward.
 *
 * The original registry referenced a template by id and derived everything from
 * it. Instances now carry their own runtime, because a template list cannot
 * describe "1.20.1 on Fabric 0.16.10". An entry written by the earlier version
 * is upgraded in place by expanding its template, so nobody loses an instance
 * to a format change.
 */
function migrate(candidate: Instance & { templateId?: string }): Instance {
  if (candidate?.runtime !== undefined || typeof candidate?.templateId !== 'string') {
    return candidate;
  }

  const template = listTemplates().find((entry) => entry.id === candidate.templateId);
  if (!template) return candidate;

  return {
    ...candidate,
    runtime: {
      minecraftVersion: template.minecraftVersion,
      loader: template.loader,
      loaderVersion: template.loaderVersion,
      versionId: template.versionId,
      installerUrl: template.installerUrl,
      javaMajor: template.javaMajor,
    },
  };
}

/** Drop entries too damaged to launch, rather than offering a button that throws. */
function isUsable(candidate: Instance): boolean {
  if (typeof candidate?.id !== 'string' || candidate.id.length === 0) return false;
  if (typeof candidate.runtime?.minecraftVersion !== 'string') {
    console.warn(`[instances] Dropping "${candidate.id}": no runtime recorded`);
    return false;
  }
  return true;
}

function persist(): void {
  const document: InstanceDocument = { version: 1, instances: registry ?? [] };
  try {
    ensureDir(DIRS.launcherState);
    fs.writeFileSync(INSTANCES_FILE, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.error('[instances] Could not write instances.json:', (err as Error).message);
  }
}

/**
 * First run seeds one instance per template, reusing the template id as the
 * instance id.
 *
 * That id reuse is deliberate and load-bearing. Before instances existed the
 * game directory was `instances/<templateId>`, so seeding with the same id
 * means an existing installation's worlds, mods and options are simply *there*
 * under the new UI. Generating fresh ids would have orphaned them somewhere the
 * user would never think to look.
 */
function seed(): Instance[] {
  const now = Date.now();
  return listTemplates().map((template) => ({
    id: template.id,
    name: template.name,
    runtime: {
      minecraftVersion: template.minecraftVersion,
      loader: template.loader,
      loaderVersion: template.loaderVersion,
      versionId: template.versionId,
      installerUrl: template.installerUrl,
      javaMajor: template.javaMajor,
    },
    memoryMax: DEFAULT_MEMORY_MAX,
    memoryMin: DEFAULT_MEMORY_MIN,
    extraJvmArgs: [],
    icon: template.javaMajor === 8 ? '🕹️' : '⛏️',
    createdAt: now,
    lastPlayed: null,
  }));
}

function load(): Instance[] {
  if (registry === null) {
    registry = readDocument();
    if (registry.length === 0) {
      registry = seed();
      persist();
    }
  }
  return registry;
}

// -------------------------------------------------------------------- ids

/** `My Pack 2!` -> `my-pack-2`. Empty input yields a usable fallback. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug.length > 0 ? slug : 'instance';
}

/**
 * A slug not already taken, and whose directory does not already exist.
 *
 * Checking the filesystem as well as the registry matters: a directory left
 * behind by an instance deleted with "keep files" would otherwise be silently
 * adopted by the next instance that happened to pick the same name, handing
 * someone else's worlds to a brand-new install.
 */
function uniqueId(name: string): string {
  const base = slugify(name);
  const taken = new Set(load().map((instance) => instance.id));

  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate) || fs.existsSync(instanceDir(candidate))) {
    candidate = `${base}-${suffix++}`;
  }
  return candidate;
}

// ----------------------------------------------------------------- queries

function find(id: string): Instance {
  const instance = load().find((candidate) => candidate.id === id);
  if (!instance) throw new Error(`Unknown instance id: ${id}`);
  return instance;
}

/** Whether the template's JVM actually resolved to something runnable. */
function javaReady(javaPath: string): boolean {
  return path.isAbsolute(javaPath) && fs.existsSync(javaPath);
}

/** Whether the loader version manifest has already been written. */
function isInstalled(versionId: string): boolean {
  return fs.existsSync(path.join(DIRS.versions, versionId, `${versionId}.json`));
}

/**
 * Directory size, one level of recursion at a time.
 *
 * Capped rather than exact: a populated instance is tens of thousands of files
 * and this runs on every list refresh. Past the cap the number is only ever
 * shown as an approximation anyway, so walking further buys nothing.
 */
const SIZE_SCAN_FILE_CAP = 20_000;

function directorySize(dir: string): number | null {
  if (!fs.existsSync(dir)) return 0;

  let total = 0;
  let seen = 0;
  const stack = [dir];

  try {
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (seen++ > SIZE_SCAN_FILE_CAP) return total;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile()) {
          total += fs.statSync(full).size;
        }
      }
    }
  } catch {
    // A file vanishing mid-walk (the game is running) is expected, not an error.
    return total;
  }
  return total;
}

function summarise(instance: Instance): InstanceSummary {
  const { runtime } = instance;
  const directory = instanceDir(instance.id);
  const java = resolveJava(runtime.javaMajor);
  const ready = javaReady(java);

  return {
    instance,
    directory,
    accent: accentFor(runtime.loader),
    javaPath: ready ? java : null,
    javaReady: ready,
    installed: isInstalled(runtime.versionId),
    clientCoreJar: clientCoreFor(runtime.minecraftVersion, runtime.loader),
    sizeBytes: directorySize(directory),
  };
}

export function listInstances(): InstanceSummary[] {
  // Most recently played first, then newest. Someone with eight instances is
  // almost always reaching for the one they used last.
  return [...load()]
    .sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0) || b.createdAt - a.createdAt)
    .map(summarise);
}

export function getInstanceSummary(id: string): InstanceSummary {
  return summarise(find(id));
}

// ---------------------------------------------------------------- mutations

/** Reject a heap string MCLC would pass straight to the JVM as a bad flag. */
function normaliseMemory(value: string, fallback: string): string {
  const trimmed = value.trim().toUpperCase();
  return /^\d+[MG]$/.test(trimmed) ? trimmed : fallback;
}

/**
 * Build the runtime a draft describes.
 *
 * Async because the Java requirement is read from the version's own metadata
 * rather than guessed from a table — Mojang publishes the answer, and a table
 * would be wrong for exactly the versions nobody tests. Resolved once here and
 * stored, so launching never needs the network to pick a JVM.
 */
async function buildRuntime(draft: InstanceDraft): Promise<RuntimeSpec> {
  const loaderVersion = draft.loader === 'vanilla' ? '' : draft.loaderVersion;

  if (draft.loader !== 'vanilla' && loaderVersion.trim().length === 0) {
    throw new Error(`A ${draft.loader} instance needs a loader build.`);
  }

  return {
    minecraftVersion: draft.minecraftVersion,
    loader: draft.loader,
    loaderVersion,
    versionId: versionIdFor(draft.minecraftVersion, draft.loader, loaderVersion),
    installerUrl: installerUrlFor(draft.minecraftVersion, draft.loader, loaderVersion),
    javaMajor: await javaMajorFor(draft.minecraftVersion),
  };
}

export async function createInstance(draft: InstanceDraft): Promise<InstanceSummary> {
  // Resolved before allocating an id, so a bad request cannot leave a half-made
  // entry behind.
  const runtime = await buildRuntime(draft);

  const name = draft.name.trim().length > 0 ? draft.name.trim() : 'New Instance';
  const instance: Instance = {
    id: uniqueId(name),
    name,
    runtime,
    memoryMax: normaliseMemory(draft.memoryMax, DEFAULT_MEMORY_MAX),
    memoryMin: normaliseMemory(draft.memoryMin, DEFAULT_MEMORY_MIN),
    extraJvmArgs: [],
    icon: draft.icon.trim().slice(0, 4) || '⬦',
    createdAt: Date.now(),
    lastPlayed: null,
  };

  load().push(instance);
  ensureDir(instanceDir(instance.id));
  persist();
  return summarise(instance);
}

export function updateInstance(id: string, patch: InstancePatch): InstanceSummary {
  const instance = find(id);

  if (patch.name !== undefined && patch.name.trim().length > 0) {
    // The id is deliberately NOT re-derived from the new name. It is the
    // directory holding their worlds; renaming an instance must not move it.
    instance.name = patch.name.trim();
  }
  if (patch.icon !== undefined) instance.icon = patch.icon.trim().slice(0, 4) || instance.icon;
  if (patch.memoryMax !== undefined) {
    instance.memoryMax = normaliseMemory(patch.memoryMax, instance.memoryMax);
  }
  if (patch.memoryMin !== undefined) {
    instance.memoryMin = normaliseMemory(patch.memoryMin, instance.memoryMin);
  }
  if (patch.extraJvmArgs !== undefined) {
    instance.extraJvmArgs = patch.extraJvmArgs.filter((arg) => arg.trim().length > 0);
  }

  persist();
  return summarise(instance);
}

/**
 * Copy the settings, not the files.
 *
 * Duplicating a 12 GB instance by copying it is a surprise nobody wants from a
 * one-click button; this gives a fresh, empty install configured identically,
 * which is what "duplicate" is nearly always wanted for.
 */
export function duplicateInstance(id: string): InstanceSummary {
  const source = find(id);
  const name = `${source.name} (copy)`;

  const copy: Instance = {
    ...source,
    id: uniqueId(name),
    name,
    extraJvmArgs: [...source.extraJvmArgs],
    createdAt: Date.now(),
    lastPlayed: null,
  };

  load().push(copy);
  ensureDir(instanceDir(copy.id));
  persist();
  return summarise(copy);
}

export function deleteInstance(id: string, deleteFiles: boolean): void {
  const instance = find(id);
  const directory = instanceDir(instance.id);

  registry = load().filter((candidate) => candidate.id !== instance.id);
  persist();

  if (!deleteFiles) return;

  // Guard against ever handing rmSync a path outside the instances root — a
  // corrupted id must not be able to delete something else on the machine.
  const resolved = path.resolve(directory);
  const root = path.resolve(DIRS.instances);
  if (!resolved.startsWith(root + path.sep)) {
    console.error(`[instances] Refusing to delete outside the instance root: ${resolved}`);
    return;
  }

  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch (err) {
    console.error(`[instances] Could not remove ${resolved}:`, (err as Error).message);
  }
}

export function markPlayed(id: string): void {
  try {
    find(id).lastPlayed = Date.now();
    persist();
  } catch {
    // Launching an instance deleted in another window is not worth failing on.
  }
}

// ---------------------------------------------------------------- launching

/**
 * Flatten an instance and its template into the descriptor `launch.ts` wants.
 *
 * The resolved `id` is the *instance* id, which is what gives per-instance
 * isolation for free: `launch.ts` derives the game directory, the mods folder
 * and `-Dblxxdlauncher.instanceDir` from `profile.id`.
 */
export function resolveProfile(instanceId: string): ClientProfile {
  const instance = find(instanceId);
  const { runtime } = instance;

  return {
    id: instance.id,
    name: instance.name,
    minecraftVersion: runtime.minecraftVersion,
    loader: runtime.loader,
    loaderVersion: runtime.loaderVersion,
    versionId: runtime.versionId,
    installerUrl: runtime.installerUrl,
    javaPath: resolveJava(runtime.javaMajor),
    javaMajor: runtime.javaMajor,
    // Null for every runtime except the two a core was built for. `launch.ts`
    // treats that as "launch plain Minecraft", not as an error.
    clientCoreJar: clientCoreFor(runtime.minecraftVersion, runtime.loader),
    // Instance flags come last so a user flag overrides the defaults.
    extraJvmArgs: [...jvmArgsFor(runtime.loader, runtime.javaMajor), ...instance.extraJvmArgs],
    // Empty by design: the core jar reaches the game through <gameDir>/mods,
    // the only mechanism either loader honours. See launch.ts.
    extraClasspath: [],
    memory: { max: instance.memoryMax, min: instance.memoryMin },
  };
}

/** Legacy shape for the diagnostic profile list. */
export function listProfiles(): ClientProfile[] {
  return load().map((instance) => resolveProfile(instance.id));
}
