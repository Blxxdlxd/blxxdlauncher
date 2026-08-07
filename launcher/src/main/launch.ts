/**
 * The launch pipeline: profile -> provisioned runtime -> JVM invocation.
 *
 * Responsibilities, in order:
 *   1. Provision the loader (see loader-install.ts).
 *   2. Materialise the isolated per-profile game directory.
 *   3. Stage the compiled client-core jar (classpath + optionally mods/).
 *   4. Assemble the exact JVM argument vector.
 *   5. Hand the whole thing to MCLC and stream its telemetry back to the UI.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client, type ILauncherOptions, type IUser } from 'minecraft-launcher-core';

import { DIRS, ensureDir, instanceDir, instanceModsDir } from './paths';
import { ensureLoaderInstalled } from './loader-install';
import { ensureAssets } from './assets';
import { getAuthorization } from './auth';
import { resolveProfile, markPlayed } from './instances';
import { MODERN_JAVA } from './profiles';
import type { ClientProfile, LaunchEvent, McAuthorization } from '../shared/types';

export type EventSink = (event: LaunchEvent) => void;

/** Guard against a double-click spawning two JVMs against one game directory. */
const running = new Set<string>();

/**
 * Rate-limit progress frames sent over IPC.
 *
 * MCLC emits one `progress`/`download-status` event per file. A cold 1.21 asset
 * pull is ~3,900 files, and each event is a structured-clone across the process
 * boundary plus a renderer wake-up. Forwarding all of them floods the IPC
 * channel and makes the UI janky for no benefit — nobody can read a bar that
 * updates 500 times a second. ~20 fps is smooth and three orders of magnitude
 * cheaper.
 *
 * The final frame of a run still gets through: the renderer drops the bar on an
 * idle timer, so a swallowed trailing update cannot leave it stuck.
 */
const PROGRESS_MIN_INTERVAL_MS = 50;

function throttleProgress(emit: EventSink): (task: string, current: number, total: number) => void {
  let lastSentAt = 0;
  return (task: string, current: number, total: number) => {
    const now = Date.now();
    // Always let a completion frame through so the bar reaches 100%.
    const isFinal = total > 0 && current >= total;
    if (!isFinal && now - lastSentAt < PROGRESS_MIN_INTERVAL_MS) {
      return;
    }
    lastSentAt = now;
    emit({ kind: 'progress', task, current, total });
  };
}

/**
 * Verify the resolved JVM is the right major version before anything touches
 * the network or the disk.
 *
 * Worth doing eagerly: running the NeoForge installer under Java 8 does not
 * fail fast — it downloads libraries for a minute or two and only then dies
 * partway through patching, leaving a half-populated version directory that
 * looks installed to `isLoaderInstalled`. Checking `java -version` up front
 * costs ~200 ms and turns a confusing broken install into one clear sentence.
 */
function assertJavaVersion(profile: ClientProfile, emit: EventSink): void {
  // Taken from the version's own metadata (`javaVersion.majorVersion`),
  // resolved once when the instance was created.
  //
  // This replaced a per-loader table. The table was fine while there were two
  // fixed profiles and actively wrong the moment any version was creatable:
  // it mapped `vanilla -> 21`, which would have demanded Java 21 for 1.16.5.
  // Mojang publishes the answer per version; a table only guesses.
  const required = profile.javaMajor;

  // -version writes to stderr on every JVM ever shipped.
  const probe = spawnSync(profile.javaPath, ['-version'], { encoding: 'utf8', windowsHide: true });

  if (probe.error) {
    throw new Error(
      `Cannot run the JVM configured for ${profile.name}:\n  ${profile.javaPath}\n` +
        `  ${probe.error.message}\n` +
        `Set it in ${path.join(DIRS.launcherState, 'runtimes.json')}, e.g. {"${required}": "C:\\\\Path\\\\To\\\\jdk-${required}"}`,
    );
  }

  const output = `${probe.stderr ?? ''}${probe.stdout ?? ''}`;
  // Matches both `1.8.0_492` (Java 8 and earlier) and `21.0.11` (9+).
  const match = /version "(\d+)(?:\.(\d+))?/.exec(output);
  if (!match) {
    console.warn(`[launch] Could not parse a version from ${profile.javaPath}; continuing.`);
    return;
  }

  const first = Number(match[1]);
  const major = first === 1 ? Number(match[2] ?? 0) : first;

  // `required` is Mojang's javaVersion.majorVersion, which is a MINIMUM, not an
  // exact requirement — and modded packs regularly need more than the minimum.
  // A single mod whose mixin config declares `compatibilityLevel: JAVA_21` will
  // refuse to initialise on Java 17 and take the whole game down with it, with
  // an error that names the mixin config and never mentions the JVM.
  //
  // So above MODERN_JAVA a newer JVM is accepted. Below it, it is not: the
  // 1.7.10-1.12 LaunchWrapper stack reaches into JDK internals that Java 9
  // sealed, and "newer" there means "crashes differently".
  const acceptable = required >= MODERN_JAVA ? major >= required : major === required;

  if (!acceptable) {
    const wanted = required >= MODERN_JAVA ? `Java ${required} or newer` : `Java ${required}`;
    throw new Error(
      `${profile.name} needs ${wanted}, but the configured JVM is Java ${major}:\n` +
        `  ${profile.javaPath}\n` +
        `Fix it in ${path.join(DIRS.launcherState, 'runtimes.json')} — ` +
        `{"${required}": "<path to your JDK ${required}>"} — then relaunch.`,
    );
  }

  if (major !== required) {
    emit({
      kind: 'status',
      message: `Java ${major} (this version asks for ${required} or newer).`,
    });
  }
}

/**
 * Adapt msmc's `MclcUser` to MCLC's stricter `IUser`.
 *
 * The two types are close but not identical: msmc leaves `name` and
 * `client_token` optional and allows a `"legacy"` account type that MCLC's
 * union does not model. Filling the gaps explicitly here beats an `as never`
 * cast, which would let a missing username through and produce a launch
 * command with `--username undefined`.
 */
function toMclcUser(auth: McAuthorization): IUser {
  if (!auth.access_token || !auth.uuid) {
    throw new Error('Authorization is missing an access token or UUID; sign in again.');
  }

  return {
    access_token: auth.access_token,
    // MCLC only echoes this back into the launch args; msmc does not issue one
    // for Microsoft accounts, and the UUID is a stable, non-secret stand-in.
    client_token: auth.client_token ?? auth.uuid,
    uuid: auth.uuid,
    name: auth.name ?? 'Player',
    /*
     * Must be a JSON *string*, not an object.
     *
     * msmc returns `user_properties: {}`. MCLC substitutes the raw value into
     * the argument array and then ends getLaunchOptions with:
     *
     *   args = args.filter(v => typeof v === 'string' || typeof v === 'number')
     *
     * which silently drops the object. `--userProperties` is then emitted with
     * no value at all, and Minecraft 1.7.10's Main.main NPEs parsing it:
     *
     *   Caused by: java.lang.NullPointerException
     *     at net.minecraft.client.main.Main.main(SourceFile:116)
     *
     * The vanilla launcher passes the literal string "{}", so we do the same.
     * Modern versions never reference ${user_properties}, so this is harmless
     * there.
     *
     * The cast is needed because MCLC declares this as `Partial<any>`, which
     * describes an object — but the game's command line requires a string. The
     * declared type is simply wrong about the runtime contract.
     */
    user_properties: (typeof auth.user_properties === 'string' && auth.user_properties.length > 0
      ? auth.user_properties
      : '{}') as unknown as IUser['user_properties'],
    meta: {
      // Microsoft accounts only; "legacy" cannot occur through the msmc flow.
      type: auth.meta?.type === 'mojang' ? 'mojang' : 'msa',
      demo: auth.meta?.demo ?? false,
    },
  };
}

/**
 * Create mods/, config/, saves/ inside the profile's game directory.
 * Keeping these per-profile is what makes 1.21 and 1.7.10 coexist without
 * a mod manager arbitrating between them.
 */
function prepareInstance(profile: ClientProfile): string {
  const gameDir = ensureDir(instanceDir(profile.id));
  for (const sub of ['mods', 'config', 'saves', 'resourcepacks', 'shaderpacks', 'logs']) {
    ensureDir(path.join(gameDir, sub));
  }
  return gameDir;
}

/**
 * Deliver the client-core jar into <gameDir>/mods.
 *
 * This is the *only* delivery mechanism, for both eras, and that is a
 * correction to the original design rather than a shortcut:
 *
 *   - 1.21 / ModLauncher builds a mod container — and registers the
 *     `[[mixins]]` config from neoforge.mods.toml — only for jars it finds by
 *     scanning the mods directory. A jar merely on the system classpath is
 *     loaded by the app class loader, which sits *outside* the transforming
 *     module layer, so its mixins never apply.
 *   - 1.7.10 / FML reads the `FMLCorePlugin` manifest attribute off jars in
 *     mods/ and installs the IClassTransformer from there. Our build.gradle
 *     already emits that attribute, so no -Dfml.coreMods.load is needed.
 *
 * We copy rather than symlink: symlinks on Windows need elevation or Developer
 * Mode, and an mtime comparison keeps the copy cheap.
 */
function stageCoreJar(profile: ClientProfile, gameDir: string, emit: EventSink): void {
  // No core for this runtime. Only 1.21.1-NeoForge and 1.7.10-Forge have one
  // built; every other version and loader launches as plain (modded)
  // Minecraft. That is a supported outcome, not a failure — the instance card
  // says so before anyone downloads anything.
  if (profile.clientCoreJar === null) {
    emit({
      kind: 'status',
      message: `No client core for ${profile.minecraftVersion} on ${profile.loader} — launching without it.`,
    });
    return;
  }

  // A named-but-absent core jar. This used to abort the launch, which was the
  // wrong call in both directions.
  //
  // It is not fatal: the instance is a complete, working Minecraft install, and
  // refusing to start it helps nobody. And it is not an odd case — the core jar
  // is built from a separate source tree that a given checkout may simply not
  // have, in which case the old message ("build it first: gradlew ...") named a
  // command the reader has no way to run.
  //
  // So: launch, and say plainly what is missing and what the consequence is.
  // This goes to the runtime log, which is on screen during the launch, and
  // names the exact path — enough to spot a jar that failed to rebuild, rather
  // than wondering mid-session why none of the client's features are there.
  if (!fs.existsSync(profile.clientCoreJar)) {
    emit({
      kind: 'status',
      message:
        `Client core jar not found — launching without it, so no client features this session.\n` +
        `  Expected: ${profile.clientCoreJar}`,
    });
    return;
  }

  const modsDir = ensureDir(instanceModsDir(profile.id));
  const wanted = path.basename(profile.clientCoreJar);
  const dest = path.join(modsDir, wanted);

  sweepStaleCores(modsDir, wanted, emit);

  const src = fs.statSync(profile.clientCoreJar);
  const upToDate = fs.existsSync(dest) && fs.statSync(dest).mtimeMs >= src.mtimeMs;

  if (!upToDate) {
    fs.copyFileSync(profile.clientCoreJar, dest);
    emit({ kind: 'status', message: `Staged ${wanted} into ${path.relative(gameDir, dest)}/` });
  }
}

/**
 * Names this launcher has ever given a core jar.
 *
 * Anchored at both ends against the *file name only*, so it cannot match a
 * user's own download. `blxxdlauncher-core-1.21.1-0.1.0.jar` matches;
 * `journeymap-blxxdlauncher-core-fork.jar` does not.
 */
const CORE_JAR_PATTERN = /^(?:blxxdlauncher|mycustomclient)-core-.+\.jar$/i;

/**
 * Delete core jars in mods/ that are not the one we are about to stage.
 *
 * Necessary because `stageCoreJar` copies to a name derived from the artifact,
 * and that name has changed twice now: once at the rename from MyCustomClient
 * to Blxxdlauncher, and once per version bump. Without a sweep, every rename
 * leaves the previous jar behind and the next launch loads *both*.
 *
 * Two copies is worse than it sounds. On 1.21 the two jars declare different
 * mod ids, so ModLauncher raises no duplicate and instead registers both mixin
 * configs — the same injectors applied twice to the same methods, which is a
 * doubled HUD at best and a mixin apply failure at worst. On 1.7.10 both are
 * coremods, and two IClassTransformers rewriting the same methods in sequence
 * is not survivable.
 *
 * Deliberately narrow: only names matching CORE_JAR_PATTERN, and never the jar
 * being staged. Anything the user put in mods/ themselves is untouchable — the
 * whole point of the isolated instance directory is that it is theirs.
 */
function sweepStaleCores(modsDir: string, keep: string, emit: EventSink): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(modsDir);
  } catch {
    return; // Freshly created and empty, or unreadable; nothing to sweep.
  }

  for (const entry of entries) {
    if (entry === keep || !CORE_JAR_PATTERN.test(entry)) {
      continue;
    }
    try {
      fs.rmSync(path.join(modsDir, entry));
      emit({ kind: 'status', message: `Removed superseded core jar ${entry}` });
    } catch (err) {
      // Worth surfacing rather than swallowing: leaving it in place is exactly
      // the double-load this function exists to prevent, and the user needs to
      // know which file to delete by hand.
      emit({
        kind: 'status',
        message: `Could not remove the old core jar ${entry} — delete it from mods/ by hand: ${(err as Error).message}`,
      });
    }
  }
}

/**
 * Append jars to the runtime classpath.
 *
 * MCLC offers `overrides.classes`, but it is a *replacement*, not an append —
 * launcher.js does `overrides.classes || getClasses(...)`, so supplying it
 * discards every Minecraft library and the game dies on the first
 * NoClassDefFoundError. The supported inspection hook is the `arguments` event,
 * which fires with the assembled argv immediately before spawn; because that
 * argv is the same array object passed to startMinecraft, editing the `-cp`
 * entry in place is the one reliable way to add to it.
 *
 * Returns a teardown function so the listener cannot outlive the launch.
 */
function installClasspathAppender(
  launcher: Client,
  extraJars: readonly string[],
  emit: EventSink,
): () => void {
  if (extraJars.length === 0) {
    return () => undefined;
  }

  const separator = process.platform === 'win32' ? ';' : ':';

  const onArguments = (argv: string[]): void => {
    const cpIndex = argv.indexOf('-cp');
    // -cp must exist and be followed by its value; if MCLC ever changes how it
    // assembles argv, do nothing rather than corrupt the command line.
    if (cpIndex === -1 || cpIndex + 1 >= argv.length) {
      emit({ kind: 'error', message: 'Could not locate -cp in the launch arguments; extra jars were not added.' });
      return;
    }
    argv[cpIndex + 1] = `${extraJars.join(separator)}${separator}${argv[cpIndex + 1]}`;
    emit({ kind: 'status', message: `Appended ${extraJars.length} jar(s) to the classpath` });
  };

  launcher.on('arguments', onArguments);
  return () => launcher.removeListener('arguments', onArguments);
}

/**
 * Extract and resolve the loader's own `arguments.jvm` from its version JSON.
 *
 * **This is mandatory for NeoForge and MCLC does not do it.** MCLC's
 * `getJVM()` only returns a handful of OS-specific defaults and it never reads
 * `arguments.jvm` from the version manifest (grep launcher.js: the only mention
 * of "arguments" is the event it emits). NeoForge 21.1's manifest carries the
 * entire JPMS setup there:
 *
 * ```
 * -p <bootstraplauncher:securejarhandler:asm*:JarJarFileSystems>
 * --add-modules ALL-MODULE-PATH
 * --add-opens   java.base/java.lang.invoke=cpw.mods.securejarhandler
 * --add-exports java.base/sun.security.util=cpw.mods.securejarhandler
 * -DignoreList=... -DlibraryDirectory=...
 * ```
 *
 * Without them `cpw.mods.bootstraplauncher.BootstrapLauncher` dies instantly:
 *
 * ```
 * java.lang.ExceptionInInitializerError
 * Caused by: InaccessibleObjectException: Unable to make field
 *   MethodHandles$Lookup.IMPL_LOOKUP accessible: module java.base
 *   does not "opens java.lang.invoke" to unnamed module
 * ```
 *
 * MCLC's own modern-loader support targets ForgeWrapper rather than
 * BootstrapLauncher, which is why this gap exists for NeoForge.
 *
 * Entries that are rule objects rather than strings are skipped: those encode
 * OS conditionals that MCLC already covers with its own defaults.
 */
function readLoaderJvmArgs(profile: ClientProfile): string[] {
  const manifest = path.join(DIRS.versions, profile.versionId, `${profile.versionId}.json`);
  if (!fs.existsSync(manifest)) {
    return [];
  }

  let parsed: { arguments?: { jvm?: unknown[] } };
  try {
    parsed = JSON.parse(fs.readFileSync(manifest, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    console.warn(`[launch] Could not parse ${manifest}: ${(err as Error).message}`);
    return [];
  }

  const raw = parsed.arguments?.jvm;
  if (!Array.isArray(raw)) {
    return [];
  }

  // Placeholders the launcher is responsible for filling in.
  const substitutions: Record<string, string> = {
    library_directory: DIRS.libraries,
    classpath_separator: process.platform === 'win32' ? ';' : ':',
    version_name: profile.versionId,
  };

  const resolved: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      continue;
    }
    resolved.push(
      entry.replace(/\$\{([a-z_]+)\}/g, (match, key: string) => substitutions[key] ?? match),
    );
  }

  return resolved;
}

/**
 * Build the JVM argument vector.
 *
 * MCLC emits -Xmx/-Xms itself from `memory`, so these are the *additional*
 * flags placed before the main class. Order matters: system properties must
 * precede the launch-wrapper main class, which MCLC appends last.
 */
function buildJvmArgs(profile: ClientProfile): string[] {
  return [
    // Isolate every path-sensitive subsystem inside our root.
    `-Djava.io.tmpdir=${ensureDir(path.join(instanceDir(profile.id), 'tmp'))}`,
    // No -Dorg.lwjgl.librarypath here: MCLC extracts natives itself and emits
    // the matching -Djava.library.path. Setting our own would fight it, and for
    // 1.19+ it would be wrong outright — handler.js extracts to the game
    // directory rather than to a versioned natives folder for those.
    //
    // Point the client core at its own instance directory so it never writes
    // config next to the jar.
    // Both spellings, deliberately. The client core reads the new name and
    // falls back to the old, but a core jar built before the rename only knows
    // the old one — and the launcher must not break an already-installed jar.
    `-Dblxxdlauncher.instanceDir=${instanceDir(profile.id)}`,
    `-Dblxxdlauncher.coreJar=${profile.clientCoreJar}`,
    `-Dmycustomclient.instanceDir=${instanceDir(profile.id)}`,
    `-Dmycustomclient.coreJar=${profile.clientCoreJar}`,
    ...profile.extraJvmArgs,
    // The loader's own JPMS/module setup. Must be present or NeoForge's
    // BootstrapLauncher cannot initialise. See readLoaderJvmArgs.
    ...readLoaderJvmArgs(profile),
  ];
}

/**
 * Strip credentials out of a log line.
 *
 * MCLC emits the entire launch command line at debug level, and that command
 * line contains `--accessToken <JWT>` plus the Xbox `--xuid`. Those went
 * straight into the launcher's log pane — and into any log the user might
 * copy-paste into a bug report. A leaked Minecraft access token is a live
 * account credential until it expires.
 */
function redactSecrets(line: string): string {
  return line
    .replace(/(--accessToken\s+)\S+/g, '$1<redacted>')
    .replace(/(--xuid\s+)\S+/g, '$1<redacted>')
    .replace(/(--clientId\s+)\S+/g, '$1<redacted>')
    // Catch bare JWTs anywhere else in the stream.
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<redacted-jwt>');
}

/**
 * Launch. Resolves once the JVM process has been spawned; the caller keeps
 * receiving `LaunchEvent`s until the game exits.
 */
export async function launchProfile(instanceId: string, emit: EventSink): Promise<void> {
  if (running.has(instanceId)) {
    throw new Error(`${instanceId} is already running.`);
  }
  running.add(instanceId);

  try {
    const profile = resolveProfile(instanceId);
    const authorization = getAuthorization();

    // Recorded at launch rather than on exit, so the grid re-sorts immediately
    // and a crashed session still counts as "the one I was just in".
    markPlayed(instanceId);

    emit({ kind: 'status', message: `Preparing ${profile.name}…` });

    // Before any download: a wrong-major JVM poisons the install directory.
    assertJavaVersion(profile, emit);
    emit({ kind: 'status', message: `JVM OK: ${profile.javaPath}` });

    await ensureLoaderInstalled(profile, (message) => emit({ kind: 'status', message }));

    const gameDir = prepareInstance(profile);
    stageCoreJar(profile, gameDir, emit);

    // Provision assets BEFORE handing off to MCLC.
    //
    // MCLC's own asset step dispatches every object concurrently with no
    // timeout; on a cold store ~1,600 of those requests never settle, so its
    // Promise.all never resolves and launch() hangs forever with no error. It
    // only downloads objects that are missing or fail checksum, so arriving
    // with a complete store means it issues zero requests. See assets.ts.
    await ensureAssets(profile, (done, total, label) => {
      emit({ kind: 'status', message: label });
      emit({ kind: 'progress', task: 'assets', current: done, total });
    });

    const launcher = new Client();
    const removeClasspathAppender = installClasspathAppender(launcher, profile.extraClasspath, emit);

    // --- MCLC wiring ------------------------------------------------------
    // Every MCLC line goes through redaction: its debug output includes the
    // full argv, which carries the account access token.
    launcher.on('debug', (line: string) =>
      emit({ kind: 'log', stream: 'stdout', line: redactSecrets(String(line)) }),
    );
    launcher.on('data', (line: string) =>
      emit({ kind: 'log', stream: 'stdout', line: redactSecrets(String(line)) }),
    );
    launcher.on('close', (code: number) => {
      running.delete(instanceId);
      removeClasspathAppender();
      emit({ kind: 'exited', code });
    });
    const emitProgress = throttleProgress(emit);
    launcher.on('progress', (p: { type: string; task: number; total: number }) =>
      emitProgress(p.type, p.task, p.total),
    );
    launcher.on('download-status', (p: { name: string; current: number; total: number }) =>
      emitProgress(p.name, p.current, p.total),
    );

    const options = {
      authorization: toMclcUser(authorization),

      // Shared immutable stores live at the root; mutable state is per-instance.
      root: DIRS.root,

      // `number` selects the vanilla base MCLC downloads (assets, client jar,
      // libraries). `custom` selects the loader-patched version profile the
      // installer wrote — MCLC merges the two manifests, honouring inheritsFrom.
      version: {
        number: profile.minecraftVersion,
        type: 'release',
        custom: profile.versionId,
      },

      // Per-instance heap, not a global constant.
      memory: profile.memory,

      // Per-profile JVM. 1.7.10 on Java 21 will not boot; 1.21 on Java 8 will not boot.
      javaPath: profile.javaPath,

      // Additional JVM args, injected before the main class.
      customArgs: buildJvmArgs(profile),

      // Additional *game* args (after the main class), e.g. --quickPlaySingleplayer.
      customLaunchArgs: [],

      overrides: {
        // Isolated game directory: mods, config, saves, options.txt.
        gameDirectory: gameDir,
        // `directory` and `natives` are deliberately NOT set. `directory` is
        // where the version jar/json live (root/versions/<id> by default, which
        // is what we want), and MCLC already scopes natives per version id —
        // so 1.7.10's LWJGL 2 and 1.21's LWJGL 3 never share an extraction dir
        // without us doing anything. Overriding either only creates ways to
        // get it wrong.
        //
        // `classes` is NOT set either: it replaces the library classpath rather
        // than extending it. See installClasspathAppender above.
        detached: false,
        maxSockets: 8,
      },
    } satisfies ILauncherOptions;

    emit({ kind: 'status', message: `Launching ${profile.versionId} on ${path.basename(profile.javaPath)}…` });

    // MCLC resolves once the child process is spawned.
    const child = await launcher.launch(options as never);

    if (child?.pid) {
      emit({ kind: 'started', pid: child.pid });
    } else {
      running.delete(instanceId);
      throw new Error('MCLC returned no child process — check the debug log above for the failing step.');
    }
  } catch (err) {
    running.delete(instanceId);
    const message = err instanceof Error ? err.message : String(err);
    emit({ kind: 'error', message });
    throw err;
  }
}
