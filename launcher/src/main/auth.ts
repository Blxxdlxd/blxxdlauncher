/**
 * Microsoft OAuth 2.0 authentication (Microsoft -> Xbox Live -> XSTS -> Minecraft).
 *
 * We never see, store, or type the user's password. `msmc` opens a real
 * Microsoft-hosted login window (an Electron BrowserWindow pointed at
 * login.microsoftonline.com) and hands us back only the resulting tokens.
 *
 * Persistence model:
 *   - The Minecraft access token is short-lived and is NEVER written to disk.
 *   - The Microsoft refresh token IS persisted, encrypted at rest with
 *     Electron's `safeStorage` (DPAPI on Windows, Keychain on macOS,
 *     libsecret on Linux). Plain-text token files are how launchers get
 *     accounts stolen; don't do it.
 *
 * Several accounts can be stored at once, but only one is *live*: switching
 * runs the full refresh chain for the account being switched to, because a
 * Minecraft access token cannot be minted from anything we keep on disk.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeStorage } from 'electron';
import { Auth } from 'msmc';

import { DIRS, ensureDir } from './paths';
import { forgetSkin } from './skins';
import type { AccountListing, AccountSummary, McAuthorization } from '../shared/types';

/** Encrypted refresh-token store. */
const ACCOUNTS_FILE = path.join(DIRS.launcherState, 'accounts.dat');

/** Single-account file written by builds before the switcher existed. */
const LEGACY_FILE = path.join(DIRS.launcherState, 'account.dat');

interface StoredAccount {
  /** base64 of safeStorage.encryptString(refreshToken) */
  readonly encryptedRefreshToken: string;
  /** Cached, non-secret display data so the UI can render before refresh. */
  readonly name: string;
  readonly uuid: string;
  readonly xuid?: string;
  readonly savedAt: number;
}

interface AccountStore {
  readonly version: 2;
  /** Account the launcher signs in as on start. Null after an explicit sign-out. */
  readonly activeUuid: string | null;
  readonly accounts: readonly StoredAccount[];
}

const EMPTY_STORE: AccountStore = { version: 2, activeUuid: null, accounts: [] };

/**
 * Live session state. Held in the main process only — the renderer receives
 * an `AccountSummary` and never the access token.
 */
let currentAuthorization: McAuthorization | null = null;
let currentAccount: AccountSummary | null = null;

/**
 * `select_account` forces the account picker instead of silently reusing the
 * browser's last Microsoft session — which is exactly what adding a second
 * account depends on.
 */
function createAuthManager(): Auth {
  return new Auth('select_account');
}

/* ------------------------------------------------------------------ store */

/**
 * Read the legacy single-account file, so upgrading builds does not sign the
 * user out. The old file is left where it is: a downgrade should still find it,
 * and it costs one stat call per start.
 */
function readLegacy(): AccountStore | null {
  if (!fs.existsSync(LEGACY_FILE)) return null;
  try {
    const old = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8')) as StoredAccount;
    if (typeof old.encryptedRefreshToken !== 'string' || typeof old.uuid !== 'string') return null;
    return { version: 2, activeUuid: old.uuid, accounts: [old] };
  } catch {
    return null;
  }
}

function readStore(): AccountStore {
  if (fs.existsSync(ACCOUNTS_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')) as AccountStore;
      if (Array.isArray(parsed.accounts)) {
        return {
          version: 2,
          activeUuid: typeof parsed.activeUuid === 'string' ? parsed.activeUuid : null,
          accounts: parsed.accounts.filter(
            (a) => typeof a?.encryptedRefreshToken === 'string' && typeof a?.uuid === 'string',
          ),
        };
      }
    } catch (err) {
      // Do NOT delete the file here — see decryptToken() for why a failure is
      // often recoverable and never worth discarding a credential over.
      console.warn(`[auth] Could not parse ${ACCOUNTS_FILE}: ${(err as Error).message}`);
      return EMPTY_STORE;
    }
  }

  const migrated = readLegacy();
  if (migrated) {
    console.log('[auth] Migrating the single-account file into the account store.');
    writeStore(migrated);
    return migrated;
  }

  return EMPTY_STORE;
}

function writeStore(store: AccountStore): void {
  ensureDir(DIRS.launcherState);
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(store), { encoding: 'utf8', mode: 0o600 });
}

/**
 * Add or replace an account and make it the live one.
 *
 * Signing in again as an existing account updates it in place rather than
 * producing a duplicate row with a rotated token.
 */
function upsert(refreshToken: string, account: AccountSummary): void {
  if (!safeStorage.isEncryptionAvailable()) {
    // No OS keyring: refuse to persist rather than silently downgrade to
    // plaintext. The user simply logs in again next launch.
    console.warn('[auth] OS encryption unavailable; refresh token will not be persisted.');
    return;
  }

  const record: StoredAccount = {
    encryptedRefreshToken: safeStorage.encryptString(refreshToken).toString('base64'),
    name: account.name,
    uuid: account.uuid,
    xuid: account.xuid,
    savedAt: Date.now(),
  };

  const store = readStore();
  writeStore({
    version: 2,
    activeUuid: account.uuid,
    accounts: [...store.accounts.filter((a) => a.uuid !== account.uuid), record],
  });
}

function decryptToken(record: StoredAccount): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(record.encryptedRefreshToken, 'base64'));
  } catch (err) {
    // safeStorage's key is stored in `<userData>/Local State`, DPAPI-protected
    // and scoped to *that* userData directory. So decryption fails for entirely
    // recoverable reasons: a different build of the app, a changed productName,
    // a restored user profile, or a temporarily unavailable OS keyring. Deleting
    // on failure throws away a credential the user will have to re-authorise,
    // to save one warning line per start. The record is left in place; a
    // successful interactive login overwrites it.
    console.warn(`[auth] Could not decrypt the token for ${record.name}: ${(err as Error).message}`);
    return null;
  }
}

function toSummary(auth: McAuthorization): AccountSummary {
  // `name` is optional in msmc's MclcUser: the Minecraft token can resolve
  // before the profile lookup does. Surface that rather than pretending.
  return { name: auth.name ?? 'Unknown account', uuid: auth.uuid, xuid: auth.meta?.xuid };
}

/* ----------------------------------------------------------------- public */

/**
 * Interactive login. Opens the Microsoft OAuth window and completes the full
 * XBL -> XSTS -> Minecraft Services chain.
 *
 * Throws with a human-readable message on cancellation, on accounts that do
 * not own Minecraft: Java Edition, or on child accounts blocked by XSTS.
 */
export async function login(): Promise<AccountSummary> {
  const authManager = createAuthManager();

  // msmc drives an Electron BrowserWindow for the OAuth code flow. The window
  // is destroyed by msmc once the redirect carrying ?code= is observed.
  const xboxManager = await authManager.launch('electron', {
    width: 520,
    height: 720,
    resizable: false,
  });

  const minecraft = await xboxManager.getMinecraft();

  currentAuthorization = minecraft.mclc();
  currentAccount = toSummary(currentAuthorization);

  // `save()` lives on the Xbox manager, not the Minecraft token, and yields the
  // *Microsoft refresh token* — the only long-lived secret in the whole chain.
  upsert(xboxManager.save(), currentAccount);

  // A deliberate sign-in is the one moment we know the player is at the
  // keyboard, so it is the right time to pick up a skin they just changed.
  forgetSkin(currentAccount.uuid);

  return currentAccount;
}

/**
 * The account recorded on disk, without touching the network.
 *
 * Exists so the UI can identify the user immediately on start. A full
 * {@link restoreSession} runs Microsoft -> Xbox Live -> XSTS -> Minecraft,
 * which takes seconds; showing "Not signed in" for that whole window makes
 * users click "Sign in" on an account that was about to restore itself.
 *
 * This is display data only — it says nothing about whether the token is
 * still valid, so callers must not enable launching on the strength of it.
 */
export function getCachedAccount(): AccountSummary | null {
  const store = readStore();
  const record = store.accounts.find((a) => a.uuid === store.activeUuid);
  return record ? { name: record.name, uuid: record.uuid, xuid: record.xuid } : null;
}

/**
 * Every stored account, plus which one is live. Cached display data only, for
 * the same reason as {@link getCachedAccount}.
 */
export function listAccounts(): AccountListing {
  const store = readStore();
  return {
    activeUuid: store.activeUuid,
    accounts: store.accounts
      .map((a) => ({ name: a.name, uuid: a.uuid, xuid: a.xuid }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * Mint a live Minecraft session from a stored refresh token.
 * Returns null when the account is unknown or its token no longer works.
 */
async function activate(uuid: string): Promise<AccountSummary | null> {
  const store = readStore();
  const record = store.accounts.find((a) => a.uuid === uuid);
  if (!record) return null;

  const refreshToken = decryptToken(record);
  if (!refreshToken) return null;

  // refresh() replays the MS refresh token and returns a fresh Xbox manager;
  // the Minecraft token is then re-minted from it (XBL -> XSTS -> MC).
  const xboxManager = await createAuthManager().refresh(refreshToken);
  const minecraft = await xboxManager.getMinecraft();

  currentAuthorization = minecraft.mclc();
  currentAccount = toSummary(currentAuthorization);

  // Microsoft rotates refresh tokens; persist the new one or the next
  // restore will fail.
  upsert(xboxManager.save(), currentAccount);

  return currentAccount;
}

/**
 * Silent re-authentication on launcher start.
 * Returns null when there is no stored account or the refresh token has been
 * revoked/expired — the caller should then show the "Sign in" button.
 */
export async function restoreSession(): Promise<AccountSummary | null> {
  const store = readStore();
  if (!store.activeUuid) return null;

  const startedAt = Date.now();
  try {
    const account = await activate(store.activeUuid);
    if (!account) return null;
    console.log(`[auth] Session restored for ${account.name} in ${Date.now() - startedAt} ms`);
    return account;
  } catch (err) {
    console.warn('[auth] Silent refresh failed, interactive login required:', (err as Error).message);
    // The token is spent; drop this account but leave any others alone.
    removeAccount(store.activeUuid);
    return null;
  }
}

/**
 * Make a stored account the live one.
 *
 * On failure the previous session is left untouched: a switch that could not
 * reach Xbox Live should not cost the player the session they already had.
 */
export async function switchAccount(uuid: string): Promise<AccountSummary> {
  const previousAuthorization = currentAuthorization;
  const previousAccount = currentAccount;

  try {
    const account = await activate(uuid);
    if (!account) {
      throw new Error('That account needs to be signed in again.');
    }
    console.log(`[auth] Switched to ${account.name}`);
    return account;
  } catch (err) {
    currentAuthorization = previousAuthorization;
    currentAccount = previousAccount;

    // Restore the previous account as the active one, since upsert() may have
    // already moved it before the chain failed.
    if (previousAccount) {
      const store = readStore();
      writeStore({ ...store, activeUuid: previousAccount.uuid });
    }
    throw new Error(`Could not switch account: ${(err as Error).message}`);
  }
}

/**
 * Forget an account's stored credentials.
 *
 * Removing the live account ends the session but leaves the others in place —
 * the switcher can then be used to sign in as one of them.
 */
export function removeAccount(uuid: string): void {
  const store = readStore();
  const remaining = store.accounts.filter((a) => a.uuid !== uuid);

  const wasActive = store.activeUuid === uuid;
  if (wasActive) {
    currentAuthorization = null;
    currentAccount = null;
  }

  writeStore({
    version: 2,
    activeUuid: wasActive ? null : store.activeUuid,
    accounts: remaining,
  });

  // The legacy file holds the same credential; leaving it would resurrect a
  // removed account on the next migration.
  if (remaining.length === 0) {
    try {
      if (fs.existsSync(LEGACY_FILE)) fs.rmSync(LEGACY_FILE);
    } catch {
      /* best effort */
    }
  }
}

/** Sign out of the live account, forgetting its stored credentials. */
export function clearSession(): void {
  const active = readStore().activeUuid;
  currentAuthorization = null;
  currentAccount = null;
  if (active) removeAccount(active);
}

/** Main-process-only accessor used by the launch pipeline. */
export function getAuthorization(): McAuthorization {
  if (!currentAuthorization) {
    throw new Error('Not signed in. Complete Microsoft authentication before launching.');
  }
  return currentAuthorization;
}

export function getAccount(): AccountSummary | null {
  return currentAccount;
}
