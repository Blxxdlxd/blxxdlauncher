/**
 * Preload bridge.
 *
 * Runs in an isolated world with access to a *subset* of Electron APIs, then
 * exposes exactly one frozen object to the page. The renderer never sees
 * `ipcRenderer`, `require`, or any access token.
 */

import { contextBridge, ipcRenderer } from 'electron';

// `import type` is fully erased, so these cost nothing at runtime.
import type {
  AccountSummary,
  ClientProfile,
  InstalledMod,
  InstanceDraft,
  InstancePatch,
  InstanceSummary,
  InstanceTemplate,
  JavaInstallation,
  LaunchEvent,
  LauncherBridge,
  LoaderBuild,
  LoaderKind,
  McVersion,
  ModHealth,
  ModSearchResult,
  ModSource,
  ModVersion,
} from '../shared/types';

/**
 * Channel names are declared inline rather than imported from shared/types.
 *
 * A sandboxed preload (`sandbox: true`) runs through Electron's own tiny module
 * loader, whose `require` resolves only a whitelist — electron, events, timers,
 * url. A relative `require('../shared/types')` throws `module not found`, the
 * preload aborts, and `window.launcher` is silently never defined: the window
 * still paints its static HTML, so the failure looks like an empty UI rather
 * than an error. (`main.ts` now logs `preload-error` so this can never hide
 * again.)
 *
 * `satisfies` keeps the duplication honest — these literals are checked against
 * the shared constant at compile time, in both directions, so any drift is a
 * build failure rather than a dead button.
 */
const IPC = {
  authLogin: 'auth:login',
  authRestore: 'auth:restore',
  authCached: 'auth:cached',
  authLogout: 'auth:logout',
  profilesList: 'profiles:list',
  templatesList: 'templates:list',
  versionsMinecraft: 'versions:minecraft',
  javaList: 'java:list',
  modsCheck: 'mods:check',
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
} as const satisfies typeof import('../shared/types').IPC;

const bridge: LauncherBridge = {
  login: () => ipcRenderer.invoke(IPC.authLogin) as Promise<AccountSummary>,

  cachedAccount: () => ipcRenderer.invoke(IPC.authCached) as Promise<AccountSummary | null>,

  restoreSession: () => ipcRenderer.invoke(IPC.authRestore) as Promise<AccountSummary | null>,

  logout: () => ipcRenderer.invoke(IPC.authLogout) as Promise<void>,

  listProfiles: () => ipcRenderer.invoke(IPC.profilesList) as Promise<ClientProfile[]>,

  listTemplates: () => ipcRenderer.invoke(IPC.templatesList) as Promise<InstanceTemplate[]>,

  listMinecraftVersions: () => ipcRenderer.invoke(IPC.versionsMinecraft) as Promise<McVersion[]>,

  listJavaInstallations: () => ipcRenderer.invoke(IPC.javaList) as Promise<JavaInstallation[]>,

  checkMods: (instanceId: string) =>
    ipcRenderer.invoke(IPC.modsCheck, instanceId) as Promise<ModHealth>,

  listLoaders: (minecraftVersion: string) =>
    ipcRenderer.invoke(IPC.versionsLoaders, minecraftVersion) as Promise<LoaderKind[]>,

  listLoaderBuilds: (minecraftVersion: string, loader: LoaderKind) =>
    ipcRenderer.invoke(IPC.versionsBuilds, minecraftVersion, loader) as Promise<LoaderBuild[]>,

  listInstances: () => ipcRenderer.invoke(IPC.instancesList) as Promise<InstanceSummary[]>,

  createInstance: (draft: InstanceDraft) =>
    ipcRenderer.invoke(IPC.instanceCreate, draft) as Promise<InstanceSummary>,

  updateInstance: (id: string, patch: InstancePatch) =>
    ipcRenderer.invoke(IPC.instanceUpdate, id, patch) as Promise<InstanceSummary>,

  duplicateInstance: (id: string) =>
    ipcRenderer.invoke(IPC.instanceDuplicate, id) as Promise<InstanceSummary>,

  deleteInstance: (id: string, deleteFiles: boolean) =>
    ipcRenderer.invoke(IPC.instanceDelete, id, deleteFiles) as Promise<void>,

  openInstanceFolder: (id: string) =>
    ipcRenderer.invoke(IPC.instanceOpenFolder, id) as Promise<void>,

  searchMods: (instanceId: string, query: string, offset: number, only: ModSource | null) =>
    ipcRenderer.invoke(IPC.modsSearch, instanceId, query, offset, only) as Promise<{
      total: number;
      results: ModSearchResult[];
    }>,

  listModVersions: (instanceId: string, projectId: string) =>
    ipcRenderer.invoke(IPC.modsVersions, instanceId, projectId) as Promise<ModVersion[]>,

  installMod: (instanceId: string, projectId: string, versionId: string | null, source: ModSource) =>
    ipcRenderer.invoke(IPC.modsInstall, instanceId, projectId, versionId, source) as Promise<string[]>,

  curseforgeConfigured: () => ipcRenderer.invoke(IPC.curseforgeStatus) as Promise<boolean>,

  setCurseforgeKey: (key: string | null) =>
    ipcRenderer.invoke(IPC.curseforgeSetKey, key) as Promise<void>,

  listInstalledMods: (instanceId: string) =>
    ipcRenderer.invoke(IPC.modsInstalled, instanceId) as Promise<InstalledMod[]>,

  setModEnabled: (instanceId: string, fileName: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC.modsToggle, instanceId, fileName, enabled) as Promise<void>,

  removeMod: (instanceId: string, fileName: string) =>
    ipcRenderer.invoke(IPC.modsRemove, instanceId, fileName) as Promise<void>,

  onModEvent: (handler: (message: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => handler(message);
    ipcRenderer.on(IPC.modsEvent, listener);
    return () => ipcRenderer.removeListener(IPC.modsEvent, listener);
  },

  launch: (instanceId: string) => ipcRenderer.invoke(IPC.launchStart, instanceId) as Promise<void>,

  openRoot: () => ipcRenderer.invoke(IPC.openRoot) as Promise<void>,

  /**
   * Subscribe to launch telemetry. Returns an unsubscribe function so the UI
   * cannot leak listeners across re-renders.
   */
  onLaunchEvent: (handler: (event: LaunchEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: LaunchEvent) => handler(payload);
    ipcRenderer.on(IPC.launchEvent, listener);
    return () => ipcRenderer.removeListener(IPC.launchEvent, listener);
  },
};

contextBridge.exposeInMainWorld('launcher', Object.freeze(bridge));
