/**
 * Filesystem layout for the isolated `.blxxdlauncher` installation.
 *
 *   ~/.blxxdlauncher/
 *     ├── assets/              shared vanilla asset store (MCLC managed)
 *     ├── libraries/           shared maven library store (MCLC managed)
 *     ├── versions/            vanilla + loader version manifests/jars
 *     ├── natives/             extracted LWJGL natives, per version
 *     ├── runtime/             cached loader installer jars
 *     ├── instances/<id>/      PER-PROFILE game dir: mods, config, saves, logs
 *     └── launcher/            our own state (account.json, settings.json)
 *
 * Nothing here touches `%APPDATA%\.minecraft`. That is the whole point:
 * the vanilla launcher installation stays pristine and our client cannot be
 * clobbered by (or clobber) a third-party mod manager.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Installation root. Overridable with BLXXDLAUNCHER_HOME so power users can
 * park the (multi-GB) install on a different drive.
 */
const LEGACY_DIR_NAME = '.mycustomclient';
const DIR_NAME = '.blxxdlauncher';

/**
 * Carry an existing installation over to the new directory name.
 *
 * The rename from MyCustomClient to Blxxdlauncher would otherwise orphan
 * everything: instances, worlds, the asset store, the signed-in account. A
 * fresh empty root beside a full one is the worst outcome — nothing is lost,
 * but it all looks lost, which amounts to the same thing.
 *
 * Renaming the whole directory is the good case: atomic, instant regardless of
 * size, and the store here is measured in gigabytes. It is tried first and
 * usually wins.
 *
 * It does not always win. Windows refuses to rename a directory while anything
 * holds a handle to it, and "anything" includes an Explorer window merely
 * *displaying* the folder — no file open, nothing running. That is a normal
 * state for a folder somebody has been poking around in, and it fails with a
 * bare EPERM. Making migration contingent on the user having no Explorer
 * window open is not a reasonable contract, so there is a fallback.
 *
 * Idempotent either way: every path is re-checked on each call, so a partial
 * migration finishes on the next start.
 */
function migrateLegacyRoot(target: string): void {
  const legacy = path.join(os.homedir(), LEGACY_DIR_NAME);
  if (!fs.existsSync(legacy)) {
    return;
  }

  // Fast path: nothing at the new name yet, so claim it outright.
  if (!fs.existsSync(target)) {
    try {
      fs.renameSync(legacy, target);
      console.log(`[paths] Moved ${legacy} -> ${target}`);
      return;
    } catch (err) {
      console.warn(
        `[paths] Could not move ${legacy} in one step (${(err as Error).message}); moving its contents instead.`,
      );
    }
  }

  moveContents(legacy, target);
}

/**
 * Move `legacy`'s entries into `target` one at a time.
 *
 * Used when the directory itself cannot be renamed. The children are what
 * matter — `instances/`, `assets/`, `launcher/account.json` — and a handle on
 * the parent does not lock them, so this succeeds where the single rename did
 * not.
 *
 * Each entry is an atomic rename in its own right, which is what makes the
 * whole thing resumable: an entry that has already moved is simply not in the
 * source list next time, and one that has not is retried.
 *
 * Never overwrites. If a name exists on both sides the target copy wins and the
 * source copy is left alone, because the target is the one being written to
 * from now on — clobbering it would restore stale state and lose whatever has
 * happened since. Anything skipped stays in the old folder, where the user can
 * still find it.
 */
function moveContents(legacy: string, target: string): void {
  fs.mkdirSync(target, { recursive: true });

  let entries: string[];
  try {
    entries = fs.readdirSync(legacy);
  } catch (err) {
    console.error(`[paths] Could not read ${legacy}: ${(err as Error).message}`);
    return;
  }

  let moved = 0;
  const skipped: string[] = [];

  for (const entry of entries) {
    const from = path.join(legacy, entry);
    const to = path.join(target, entry);

    if (fs.existsSync(to)) {
      skipped.push(entry);
      continue;
    }
    try {
      fs.renameSync(from, to);
      moved += 1;
    } catch (err) {
      skipped.push(entry);
      console.error(`[paths] Could not move ${from}: ${(err as Error).message}`);
    }
  }

  console.log(`[paths] Moved ${moved} entries from ${legacy} to ${target}`);

  if (skipped.length > 0) {
    console.warn(`[paths] Left behind in ${legacy}: ${skipped.join(', ')}`);
    return;
  }

  // Emptied successfully — drop the shell. Non-recursive on purpose: it should
  // be empty by now, and if it somehow is not, refusing to delete is correct.
  // Failure here is cosmetic, so it is not reported as an error: an empty
  // leftover directory costs nothing.
  try {
    fs.rmdirSync(legacy);
  } catch {
    /* Still held open (that is why we are here); harmless once empty. */
  }
}

export const ROOT: string = (() => {
  const override = process.env.BLXXDLAUNCHER_HOME ?? process.env.MYCUSTOMCLIENT_HOME;
  if (override && override.trim().length > 0) {
    return path.resolve(override);
  }
  const target = path.join(os.homedir(), DIR_NAME);
  migrateLegacyRoot(target);
  return target;
})();

export const DIRS = {
  root: ROOT,
  assets: path.join(ROOT, 'assets'),
  libraries: path.join(ROOT, 'libraries'),
  versions: path.join(ROOT, 'versions'),
  natives: path.join(ROOT, 'natives'),
  runtime: path.join(ROOT, 'runtime'),
  instances: path.join(ROOT, 'instances'),
  launcherState: path.join(ROOT, 'launcher'),
} as const;

/** Per-profile isolated game directory. */
export function instanceDir(profileId: string): string {
  return path.join(DIRS.instances, profileId);
}

/** Per-profile mods folder (created on demand). */
export function instanceModsDir(profileId: string): string {
  return path.join(instanceDir(profileId), 'mods');
}

/** Per-version natives folder. MCLC extracts LWJGL .dll/.so/.dylib here. */
export function nativesDir(versionId: string): string {
  return path.join(DIRS.natives, versionId);
}

/** mkdir -p for every well-known directory. Idempotent, safe to call on boot. */
export function ensureLayout(): void {
  for (const dir of Object.values(DIRS)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** mkdir -p helper for paths derived at runtime. */
export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
