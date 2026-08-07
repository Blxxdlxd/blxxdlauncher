/**
 * Shared type contracts between the Electron main process and the renderer.
 *
 * This file is intentionally dependency-free so it can be imported from both
 * the Node-side (main) and the sandboxed browser-side (renderer/preload).
 */

/** Which mod loader family a profile boots. Drives installer + classpath strategy. */
export type LoaderKind = 'neoforge' | 'forge' | 'fabric' | 'vanilla';

/** A Minecraft version as listed in Mojang's manifest. */
export interface McVersion {
  readonly id: string;
  readonly type: 'release' | 'snapshot' | 'old';
  readonly releaseTime: string;
}

/** One selectable loader build. */
export interface LoaderBuild {
  readonly version: string;
  /** Upstream's recommended/stable build, or the newest where none is marked. */
  readonly recommended?: boolean;
}

/**
 * Everything needed to install and boot one runtime.
 *
 * Stored *on the instance* rather than looked up from a fixed template list —
 * that is what lets an instance be any Minecraft version on any loader, rather
 * than one of two presets.
 */
export interface RuntimeSpec {
  readonly minecraftVersion: string;
  readonly loader: LoaderKind;
  /** Empty for vanilla. */
  readonly loaderVersion: string;
  /** The version id the loader writes into `<root>/versions/`; the MC id for vanilla. */
  readonly versionId: string;
  /** Installer jar to run. Null for vanilla and Fabric, which need no installer. */
  readonly installerUrl: string | null;
  /** Java major this runtime needs, read from the version's own metadata. */
  readonly javaMajor: number;
}

/**
 * A fully-resolved, launchable profile.
 *
 * Every profile is *isolated*: it gets its own game directory under
 * `<root>/instances/<id>` (own mods/, config/, saves/, options.txt) while
 * sharing the expensive immutable stores (assets/, libraries/, versions/)
 * with the rest of the installation.
 */
export interface ClientProfile {
  /** Stable directory-safe identifier, e.g. "modern-1.21.1". */
  readonly id: string;
  /** Human label shown in the launcher UI. */
  readonly name: string;
  /** Vanilla Minecraft version the loader patches, e.g. "1.21.1". */
  readonly minecraftVersion: string;
  /** Loader family. */
  readonly loader: LoaderKind;
  /**
   * Loader build number.
   *  - neoforge: "21.1.209"
   *  - forge:    "10.13.4.1614-1.7.10"
   */
  readonly loaderVersion: string;
  /**
   * The version id the loader installer writes into `<root>/versions/`.
   * This is what we hand to MCLC as `version.custom`.
   *  - neoforge 21.1.209 -> "neoforge-21.1.209"
   *  - forge 1.7.10      -> "1.7.10-Forge10.13.4.1614-1.7.10"
   */
  readonly versionId: string;
  /** Absolute URL of the loader installer jar (downloaded once, cached). */
  /** Installer jar to run, or null for vanilla and Fabric. */
  readonly installerUrl: string | null;
  /**
   * Absolute path to a JDK/JRE *java executable* for this profile.
   * 1.7.10 requires Java 8; 1.21 requires Java 21. Never share one JVM.
   */
  readonly javaPath: string;
  /** Java major this runtime needs, for the pre-flight version check. */
  readonly javaMajor: number;
  /**
   * Our compiled client-core jar for this era, or null when none matches.
   * Null means "launch plain Minecraft", not an error.
   */
  readonly clientCoreJar: string | null;
  /**
   * Extra `-D`/`-XX` JVM flags appended after the memory flags.
   * Loader-specific bootstrapping lives here (e.g. fml.coreMods.load).
   */
  readonly extraJvmArgs: readonly string[];
  /**
   * Extra jars appended to the runtime `-cp`, ahead of the Minecraft libraries.
   *
   * Normally empty: the client core is delivered through `<gameDir>/mods`, which
   * is the only mechanism either loader actually honours (see launch.ts). This
   * exists for the genuine exceptions — an agent jar, or a library that must be
   * visible to the system class loader before the loader bootstraps.
   */
  readonly extraClasspath: readonly string[];
  /** Heap allocation for this instance. Per-instance, not global. */
  readonly memory: MemorySpec;
}

/** Which host a mod came from. */
export type ModSource = 'modrinth' | 'curseforge';

/** One result from a mod search, already filtered to the instance's runtime. */
export interface ModSearchResult {
  readonly source: ModSource;
  /** Modrinth project id, or the CurseForge mod id as a string. */
  readonly projectId: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly downloads: number;
  readonly iconUrl: string | null;
  readonly author: string;
  /** Whether this instance already has it. */
  readonly installed: boolean;
  /**
   * False when the author has disabled third-party downloads — CurseForge only.
   * The mod is listed but cannot be fetched; {@link websiteUrl} is where to get
   * it by hand.
   */
  readonly downloadable: boolean;
  readonly websiteUrl: string | null;
}

/** A downloadable build of one mod that fits the instance. */
export interface ModVersion {
  readonly versionId: string;
  readonly name: string;
  readonly versionNumber: string;
  /** `release`, `beta` or `alpha`. */
  readonly versionType: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly datePublished: string;
}

/** A jar present in an instance's mods folder. */
export interface InstalledMod {
  readonly fileName: string;
  readonly title: string;
  /** Null for a jar we did not install — dropped in by hand, or the client core. */
  readonly projectId: string | null;
  readonly enabled: boolean;
  /** Installed automatically to satisfy another mod's requirement. */
  readonly dependency: boolean;
  readonly sizeBytes: number;
  readonly external: boolean;
  /** Where it came from, or null for a jar we did not install. */
  readonly source: ModSource | null;
}

/** Memory allocation, expressed the way MCLC wants it. */
export interface MemorySpec {
  readonly max: string;
  readonly min: string;
}

/**
 * An immutable base an instance is created from.
 *
 * Templates are the parts nobody should be editing per instance: which loader
 * build to install, which JVM era it needs, which client-core jar matches, and
 * the GC flags appropriate to that era. Getting any of those wrong produces a
 * crash that is genuinely hard to attribute, so they are not user-facing knobs.
 */
export interface InstanceTemplate {
  readonly id: string;
  readonly name: string;
  /** One-line description shown in the create dialog. */
  readonly summary: string;
  readonly minecraftVersion: string;
  readonly loader: LoaderKind;
  readonly loaderVersion: string;
  readonly versionId: string;
  readonly installerUrl: string;
  readonly javaMajor: 8 | 21;
  /** Resolved at startup; empty string when no matching JDK was found. */
  readonly javaPath: string;
  readonly clientCoreJar: string;
  readonly extraJvmArgs: readonly string[];
  readonly extraClasspath: readonly string[];
  /** Accent colour for the instance card, so eras are distinguishable. */
  readonly accent: string;
}

/**
 * A user-created instance: a name, a template, and the handful of settings
 * that genuinely vary between two installs of the same version.
 *
 * Mutable by design — this is the persisted document, written back to
 * `launcher/instances.json` on every edit.
 */
export interface Instance {
  /** Directory-safe, stable for the life of the instance. Never reused. */
  readonly id: string;
  name: string;
  /** What to install and boot. Fixed for the life of the instance. */
  readonly runtime: RuntimeSpec;
  memoryMax: string;
  memoryMin: string;
  /** Appended after the template's own flags, so a user flag wins a conflict. */
  extraJvmArgs: string[];
  /** Single emoji or letter drawn on the card. */
  icon: string;
  readonly createdAt: number;
  lastPlayed: number | null;
}

/** An instance plus everything the UI needs to draw and judge it. */
export interface InstanceSummary {
  readonly instance: Instance;
  readonly directory: string;
  /** Accent colour, derived from the loader family. */
  readonly accent: string;
  /** Resolved java executable, or null when no JDK of the right major was found. */
  readonly javaPath: string | null;
  /** False when the JVM could not be resolved — Launch is blocked. */
  readonly javaReady: boolean;
  /** Whether the loader version has already been installed under versions/. */
  readonly installed: boolean;
  /**
   * The client-core jar that matches this runtime, or null when none exists.
   *
   * Null is the normal case for anything other than 1.21.1-NeoForge and
   * 1.7.10-Forge: those are the only two eras a core has been built for, so
   * every other instance launches as plain (modded) Minecraft.
   */
  readonly clientCoreJar: string | null;
  /** Bytes on disk for this instance's own directory, or null if uncomputed. */
  readonly sizeBytes: number | null;
}

/** What the create dialog submits. */
export interface InstanceDraft {
  readonly name: string;
  readonly minecraftVersion: string;
  readonly loader: LoaderKind;
  /** Ignored for vanilla. */
  readonly loaderVersion: string;
  readonly memoryMax: string;
  readonly memoryMin: string;
  readonly icon: string;
}

/** Fields an existing instance allows editing. */
export interface InstancePatch {
  readonly name?: string;
  readonly memoryMax?: string;
  readonly memoryMin?: string;
  readonly icon?: string;
  readonly extraJvmArgs?: string[];
}

/**
 * The authorization object MCLC consumes.
 *
 * Structurally mirrors msmc's `MclcUser` (msmc/types/assets.d.ts) so the value
 * returned by `Minecraft#mclc()` assigns to it without a cast. Redeclared here
 * rather than imported so this module stays dependency-free and usable from the
 * sandboxed renderer.
 */
export interface McAuthorization {
  access_token: string;
  client_token?: string;
  uuid: string;
  /** Optional in msmc's type: a token can resolve before the profile does. */
  name?: string;
  meta?: {
    refresh?: string;
    exp?: number;
    type: 'mojang' | 'msa' | 'legacy';
    xuid?: string;
    demo?: boolean;
  };
  user_properties?: unknown;
}

/** Everything the renderer needs to render the account chip. */
export interface AccountSummary {
  readonly name: string;
  readonly uuid: string;
  readonly xuid?: string;
}

/** Progress/telemetry frames pushed from main -> renderer over IPC. */
export type LaunchEvent =
  | { kind: 'status'; message: string }
  | { kind: 'progress'; task: string; current: number; total: number }
  | { kind: 'log'; stream: 'stdout' | 'stderr'; line: string }
  | { kind: 'started'; pid: number }
  | { kind: 'exited'; code: number | null }
  | { kind: 'error'; message: string };

/** IPC channel names, centralised so main/preload/renderer cannot drift. */
export const IPC = {
  authLogin: 'auth:login',
  authRestore: 'auth:restore',
  /** Cached identity from disk, no network. Lets the UI paint before refresh. */
  authCached: 'auth:cached',
  authLogout: 'auth:logout',
  profilesList: 'profiles:list',
  templatesList: 'templates:list',
  versionsMinecraft: 'versions:minecraft',
  versionsLoaders: 'versions:loaders',
  versionsBuilds: 'versions:builds',
  instancesList: 'instances:list',
  instanceCreate: 'instances:create',
  instanceUpdate: 'instances:update',
  instanceDuplicate: 'instances:duplicate',
  instanceDelete: 'instances:delete',
  instanceOpenFolder: 'instances:open-folder',
  modsSearch: 'mods:search',
  modsVersions: 'mods:versions',
  modsInstall: 'mods:install',
  modsInstalled: 'mods:installed',
  modsToggle: 'mods:toggle',
  modsRemove: 'mods:remove',
  modsEvent: 'mods:event',
  curseforgeStatus: 'curseforge:status',
  curseforgeSetKey: 'curseforge:set-key',
  launchStart: 'launch:start',
  launchEvent: 'launch:event',
  openRoot: 'shell:open-root',
} as const;

/** The surface exposed on `window.launcher` by the preload bridge. */
export interface LauncherBridge {
  login(): Promise<AccountSummary>;
  /**
   * Identity cached on disk. Resolves instantly and performs no network I/O, so
   * the UI can show who is signed in while {@link restoreSession} is still
   * negotiating. A cached account is NOT proof of a usable token.
   */
  cachedAccount(): Promise<AccountSummary | null>;
  restoreSession(): Promise<AccountSummary | null>;
  logout(): Promise<void>;
  listProfiles(): Promise<ClientProfile[]>;
  listTemplates(): Promise<InstanceTemplate[]>;
  /** Every Minecraft version Mojang lists, newest first. */
  listMinecraftVersions(): Promise<McVersion[]>;
  /** Which loader families have a build for this version. */
  listLoaders(minecraftVersion: string): Promise<LoaderKind[]>;
  /** Builds of one loader family for this version, newest first. */
  listLoaderBuilds(minecraftVersion: string, loader: LoaderKind): Promise<LoaderBuild[]>;
  listInstances(): Promise<InstanceSummary[]>;
  createInstance(draft: InstanceDraft): Promise<InstanceSummary>;
  updateInstance(id: string, patch: InstancePatch): Promise<InstanceSummary>;
  duplicateInstance(id: string): Promise<InstanceSummary>;
  /** `deleteFiles` also removes the instance's worlds, mods and config. */
  deleteInstance(id: string, deleteFiles: boolean): Promise<void>;
  openInstanceFolder(id: string): Promise<void>;

  /** Search Modrinth, already filtered to this instance's version and loader. */
  /** `only` restricts to one host; null searches every configured one. */
  searchMods(instanceId: string, query: string, offset: number, only: ModSource | null):
    Promise<{ total: number; results: ModSearchResult[] }>;
  listModVersions(instanceId: string, projectId: string): Promise<ModVersion[]>;
  /** Install a mod and its required dependencies. Returns the filenames written. */
  installMod(instanceId: string, projectId: string, versionId: string | null,
             source: ModSource): Promise<string[]>;
  /** Whether a CurseForge API key is configured. */
  curseforgeConfigured(): Promise<boolean>;
  /** Store or clear the CurseForge API key. */
  setCurseforgeKey(key: string | null): Promise<void>;
  listInstalledMods(instanceId: string): Promise<InstalledMod[]>;
  setModEnabled(instanceId: string, fileName: string, enabled: boolean): Promise<void>;
  removeMod(instanceId: string, fileName: string): Promise<void>;
  /** Progress lines while an install runs. Returns an unsubscribe function. */
  onModEvent(handler: (message: string) => void): () => void;
  /** Takes an instance id. */
  launch(instanceId: string): Promise<void>;
  openRoot(): Promise<void>;
  onLaunchEvent(handler: (event: LaunchEvent) => void): () => void;
}
