/**
 * Electron main process — application entry point.
 *
 * Security posture (non-negotiable for anything that holds OAuth tokens):
 *   - nodeIntegration:  false   the renderer is a plain web page
 *   - contextIsolation: true    preload and page have separate JS worlds
 *   - sandbox:          true    renderer runs in an OS sandbox
 *   - a strict CSP, and every external navigation/window kicked out to the
 *     system browser
 *
 * The renderer can only reach Node through the narrow, hand-audited IPC
 * surface declared in shared/types.ts.
 */

import * as path from 'node:path';
import { app, BrowserWindow, ipcMain, shell, session } from 'electron';

import { ensureLayout, DIRS } from './paths';
import { login, restoreSession, clearSession, getAccount, getCachedAccount } from './auth';
import { detectJavaInstallations, listTemplates } from './profiles';
import { listAvailableLoaders, listLoaderBuilds, listMinecraftVersions } from './versions';
import {
  createInstance,
  deleteInstance,
  duplicateInstance,
  getInstanceSummary,
  listInstances,
  listProfiles,
  updateInstance,
} from './instances';
import { isConfigured as curseforgeConfigured, setApiKey as setCurseForgeKey } from './curseforge';
import {
  installMod,
  checkInstanceMods,
  listInstalledMods,
  listModVersions,
  removeMod,
  searchMods,
  setModEnabled,
} from './mods';
import { launchProfile } from './launch';
import { IPC } from '../shared/types';
import type {
  AccountSummary,
  InstalledMod,
  InstanceDraft,
  InstancePatch,
  InstanceSummary,
  InstanceTemplate,
  JavaInstallation,
  LaunchEvent,
  LoaderBuild,
  LoaderKind,
  McVersion,
  ModHealth,
} from '../shared/types';

/**
 * Last-resort diagnostics.
 *
 * MCLC does its asset work inside an unbounded `Promise.all` and swallows
 * failures in `launch()`, returning null. When something inside that goes wrong
 * the launcher just goes quiet mid-run with nothing in the UI. These two
 * handlers make sure a rejection or throw that escapes our own try/catch is at
 * least printed rather than vanishing.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (error) => {
  console.error('[main] uncaughtException:', error.stack ?? error.message);
});

/** Single-instance lock: two launchers sharing one game directory corrupts saves. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

/** Push a launch telemetry frame to the UI, if it still exists. */
function emitToRenderer(event: LaunchEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.launchEvent, event);
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1_100,
    height: 700,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#11131a',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // A preload that throws fails *silently*: the window still renders its static
  // HTML, but `window.launcher` is never defined and every dynamic feature dies
  // on the first property access. Without this listener the only symptom is an
  // empty-looking UI with nothing in any log.
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[preload] FAILED ${preloadPath}\n${error.stack ?? error.message}`);
  });

  // Surface renderer-side console errors in the main process log too.
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      console.error(`[renderer] ${message} (${sourceId}:${line})`);
    }
  });

  // Anything trying to open a new window goes to the user's real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Block in-place navigation away from our own bundled page.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  void mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

/**
 * Content-Security-Policy for the launcher UI only.
 *
 * Deliberately NOT applied to the Microsoft OAuth window: msmc creates its own
 * BrowserWindow against login.microsoftonline.com, which needs Microsoft's own
 * CSP and script sources. We scope ours by URL so we never break the login flow.
 */
function installContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!details.url.startsWith('file://')) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          // img-src additionally allows Modrinth's asset host, and only that:
          // mod icons come straight from their CDN. Everything else stays shut,
          // including connect-src — the renderer never makes a request itself,
          // all API traffic goes through the main process.
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: https://cdn.modrinth.com https://media.forgecdn.net; connect-src 'none'; " +
            "object-src 'none'; base-uri 'none'; form-action 'none'",
        ],
      },
    });
  });

  // Refuse every permission request (camera, geolocation, notifications…).
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}

/*
 * Input validation for the instance handlers.
 *
 * The renderer is sandboxed and cannot be trusted to send well-formed payloads
 * — a compromised page or a bug either side of the bridge arrives here as
 * `unknown`. These narrow it explicitly rather than casting, so a bad message
 * is a clear error instead of an `undefined` propagating into the filesystem.
 */

function asId(value: unknown, channel: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${channel} expects a non-empty instance id`);
  }
  return value;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * A bare filename, with no path in it.
 *
 * The renderer supplies these and they end up in `rmSync` and `renameSync`.
 * `mods.ts` also refuses anything that resolves outside the mods folder, but
 * rejecting separators here means a traversal attempt never reaches the
 * filesystem layer at all.
 */
function asFileName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Expected a file name');
  }
  if (value.includes('/') || value.includes('\\') || value.includes('..')) {
    throw new Error(`Rejected suspicious file name: ${value}`);
  }
  return value;
}

const LOADERS: readonly LoaderKind[] = ['vanilla', 'forge', 'neoforge', 'fabric'];

function asLoader(value: unknown): LoaderKind {
  if (typeof value !== 'string' || !LOADERS.includes(value as LoaderKind)) {
    throw new Error(`Unknown loader: ${String(value)}`);
  }
  return value as LoaderKind;
}

function asDraft(value: unknown): InstanceDraft {
  if (typeof value !== 'object' || value === null) {
    throw new Error('instances:create expects a draft object');
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw['minecraftVersion'] !== 'string' || raw['minecraftVersion'].length === 0) {
    throw new Error('instances:create requires a minecraftVersion');
  }
  return {
    name: asString(raw['name'], 'New Instance'),
    minecraftVersion: raw['minecraftVersion'],
    loader: asLoader(raw['loader']),
    loaderVersion: asString(raw['loaderVersion'], ''),
    memoryMax: asString(raw['memoryMax'], '8G'),
    memoryMin: asString(raw['memoryMin'], '4G'),
    icon: asString(raw['icon'], '⬦'),
  };
}

function asPatch(value: unknown): InstancePatch {
  if (typeof value !== 'object' || value === null) {
    throw new Error('instances:update expects a patch object');
  }
  const raw = value as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  // Only copy keys that are actually present and of the right type: an absent
  // field must stay absent, since `updateInstance` treats undefined as
  // "leave alone" and a stray null would clear a setting.
  for (const key of ['name', 'memoryMax', 'memoryMin', 'icon'] as const) {
    if (typeof raw[key] === 'string') patch[key] = raw[key];
  }
  if (Array.isArray(raw['extraJvmArgs'])) {
    patch['extraJvmArgs'] = raw['extraJvmArgs'].filter((arg): arg is string => typeof arg === 'string');
  }
  return patch as InstancePatch;
}

/** Register the IPC surface. Each handler is a trust boundary — validate inputs. */
function registerIpcHandlers(): void {
  ipcMain.handle(IPC.authLogin, async (): Promise<AccountSummary> => login());

  ipcMain.handle(IPC.authCached, async (): Promise<AccountSummary | null> => getCachedAccount());

  ipcMain.handle(IPC.authRestore, async (): Promise<AccountSummary | null> => restoreSession());

  ipcMain.handle(IPC.authLogout, async (): Promise<void> => {
    clearSession();
  });

  ipcMain.handle(IPC.profilesList, async () => listProfiles());

  ipcMain.handle(IPC.templatesList, async (): Promise<InstanceTemplate[]> => listTemplates());

  ipcMain.handle(IPC.versionsMinecraft, async (): Promise<McVersion[]> => listMinecraftVersions());

  // Probing every candidate costs a process spawn each, so this is requested
  // when the dialog opens rather than kept warm — a JDK can be installed or
  // removed between openings, and a cached list would quietly be wrong.
  ipcMain.handle(IPC.javaList, async (): Promise<JavaInstallation[]> => detectJavaInstallations());

  ipcMain.handle(IPC.versionsLoaders, async (_event, mc: unknown): Promise<LoaderKind[]> => {
    return listAvailableLoaders(asId(mc, 'versions:loaders'));
  });

  ipcMain.handle(
    IPC.versionsBuilds,
    async (_event, mc: unknown, loader: unknown): Promise<LoaderBuild[]> => {
      return listLoaderBuilds(asId(mc, 'versions:builds'), asLoader(loader));
    },
  );

  ipcMain.handle(IPC.instancesList, async (): Promise<InstanceSummary[]> => listInstances());

  ipcMain.handle(IPC.instanceCreate, async (_event, draft: unknown): Promise<InstanceSummary> => {
    return createInstance(asDraft(draft));
  });

  ipcMain.handle(
    IPC.instanceUpdate,
    async (_event, id: unknown, patch: unknown): Promise<InstanceSummary> => {
      return updateInstance(asId(id, 'instances:update'), asPatch(patch));
    },
  );

  ipcMain.handle(IPC.instanceDuplicate, async (_event, id: unknown): Promise<InstanceSummary> => {
    return duplicateInstance(asId(id, 'instances:duplicate'));
  });

  ipcMain.handle(IPC.instanceDelete, async (_event, id: unknown, deleteFiles: unknown) => {
    deleteInstance(asId(id, 'instances:delete'), deleteFiles === true);
  });

  ipcMain.handle(IPC.instanceOpenFolder, async (_event, id: unknown): Promise<void> => {
    // Resolved through the registry rather than by joining the raw id onto a
    // path, so a malformed id cannot open an arbitrary directory.
    await shell.openPath(getInstanceSummary(asId(id, 'instances:open-folder')).directory);
  });

  ipcMain.handle(
    IPC.modsSearch,
    async (_event, id: unknown, query: unknown, offset: unknown, only: unknown) => {
      const source = only === 'modrinth' || only === 'curseforge' ? only : null;
      return searchMods(asId(id, 'mods:search'), asString(query, ''),
          typeof offset === 'number' && offset >= 0 ? offset : 0, source);
    },
  );

  ipcMain.handle(IPC.modsVersions, async (_event, id: unknown, projectId: unknown) => {
    return listModVersions(asId(id, 'mods:versions'), asId(projectId, 'mods:versions'));
  });

  ipcMain.handle(
    IPC.modsInstall,
    async (_event, id: unknown, projectId: unknown, versionId: unknown,
           source: unknown): Promise<string[]> => {
      return installMod(
        asId(id, 'mods:install'),
        asId(projectId, 'mods:install'),
        typeof versionId === 'string' ? versionId : null,
        source === 'curseforge' ? 'curseforge' : 'modrinth',
        // Progress is pushed rather than returned: dependency resolution can
        // take several downloads and a silent spinner is indistinguishable
        // from a hang.
        (message: string) => mainWindow?.webContents.send(IPC.modsEvent, message),
      );
    },
  );

  ipcMain.handle(IPC.modsCheck, async (_event, id: unknown): Promise<ModHealth> =>
    checkInstanceMods(String(id)),
  );

  ipcMain.handle(IPC.modsInstalled, async (_event, id: unknown): Promise<InstalledMod[]> => {
    return listInstalledMods(asId(id, 'mods:installed'));
  });

  ipcMain.handle(IPC.modsToggle, async (_event, id: unknown, file: unknown, enabled: unknown) => {
    setModEnabled(asId(id, 'mods:toggle'), asFileName(file), enabled === true);
  });

  ipcMain.handle(IPC.modsRemove, async (_event, id: unknown, file: unknown) => {
    removeMod(asId(id, 'mods:remove'), asFileName(file));
  });

  ipcMain.handle(IPC.curseforgeStatus, async (): Promise<boolean> => curseforgeConfigured());

  ipcMain.handle(IPC.curseforgeSetKey, async (_event, key: unknown): Promise<void> => {
    setCurseForgeKey(typeof key === 'string' ? key : null);
  });

  ipcMain.handle(IPC.launchStart, async (_event, instanceId: unknown): Promise<void> => {
    if (typeof instanceId !== 'string') {
      throw new Error('launch:start expects an instance id string');
    }
    if (!getAccount()) {
      throw new Error('Sign in with your Microsoft account before launching.');
    }
    await launchProfile(instanceId, emitToRenderer);
  });

  ipcMain.handle(IPC.openRoot, async (): Promise<void> => {
    await shell.openPath(DIRS.root);
  });
}

app.whenReady().then(() => {
  // Create ~/.blxxdlauncher and its subtree before anything reads from it.
  ensureLayout();

  installContentSecurityPolicy();
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  // The game runs as a detached-from-UI child; closing the launcher on Windows
  // and Linux is the expected behaviour and does not kill the JVM.
  if (process.platform !== 'darwin') app.quit();
});
