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
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeStorage } from 'electron';
import { Auth } from 'msmc';

import { DIRS, ensureDir } from './paths';
import type { AccountSummary, McAuthorization } from '../shared/types';

/** Encrypted refresh-token blob on disk. */
const ACCOUNT_FILE = path.join(DIRS.launcherState, 'account.dat');

interface PersistedAccount {
  /** base64 of safeStorage.encryptString(refreshToken) */
  readonly encryptedRefreshToken: string;
  /** Cached, non-secret display data so the UI can render before refresh. */
  readonly name: string;
  readonly uuid: string;
  readonly xuid?: string;
  readonly savedAt: number;
}

/**
 * Live session state. Held in the main process only — the renderer receives
 * an `AccountSummary` and never the access token.
 */
let currentAuthorization: McAuthorization | null = null;
let currentAccount: AccountSummary | null = null;

/**
 * `select_account` forces the account picker instead of silently reusing the
 * browser's last Microsoft session — important for users with alt accounts.
 */
function createAuthManager(): Auth {
  return new Auth('select_account');
}

function writePersisted(refreshToken: string, account: AccountSummary): void {
  ensureDir(DIRS.launcherState);

  if (!safeStorage.isEncryptionAvailable()) {
    // No OS keyring: refuse to persist rather than silently downgrade to
    // plaintext. The user simply logs in again next launch.
    console.warn('[auth] OS encryption unavailable; refresh token will not be persisted.');
    return;
  }

  const payload: PersistedAccount = {
    encryptedRefreshToken: safeStorage.encryptString(refreshToken).toString('base64'),
    name: account.name,
    uuid: account.uuid,
    xuid: account.xuid,
    savedAt: Date.now(),
  };

  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
}

function readPersisted(): { refreshToken: string; account: AccountSummary } | null {
  if (!fs.existsSync(ACCOUNT_FILE)) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;

  try {
    const payload = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8')) as PersistedAccount;
    const refreshToken = safeStorage.decryptString(Buffer.from(payload.encryptedRefreshToken, 'base64'));
    return {
      refreshToken,
      account: { name: payload.name, uuid: payload.uuid, xuid: payload.xuid },
    };
  } catch (err) {
    // Do NOT delete the file here.
    //
    // safeStorage's key is stored in `<userData>/Local State`, DPAPI-protected
    // and scoped to *that* userData directory. So decryption fails for entirely
    // recoverable reasons: a different build of the app, a changed productName,
    // a restored user profile, or a temporarily unavailable OS keyring. Deleting
    // on failure throws away a credential the user will have to re-authorise,
    // to save one warning line per start. The blob is left in place; a
    // successful interactive login overwrites it.
    console.warn(
      `[auth] Could not decrypt ${ACCOUNT_FILE} (${(err as Error).message}). ` +
        'Keeping the file; interactive sign-in required.',
    );
    currentAuthorization = null;
    currentAccount = null;
    return null;
  }
}

function toSummary(auth: McAuthorization): AccountSummary {
  // `name` is optional in msmc's MclcUser: the Minecraft token can resolve
  // before the profile lookup does. Surface that rather than pretending.
  return { name: auth.name ?? 'Unknown account', uuid: auth.uuid, xuid: auth.meta?.xuid };
}

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
  writePersisted(xboxManager.save(), currentAccount);

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
  return readPersisted()?.account ?? null;
}

/**
 * Silent re-authentication on launcher start.
 * Returns null when there is no stored account or the refresh token has been
 * revoked/expired — the caller should then show the "Sign in" button.
 */
export async function restoreSession(): Promise<AccountSummary | null> {
  const stored = readPersisted();
  if (!stored) return null;

  const startedAt = Date.now();
  try {
    const authManager = createAuthManager();

    // refresh() replays the MS refresh token and returns a fresh Xbox manager;
    // the Minecraft token is then re-minted from it (XBL -> XSTS -> MC).
    const xboxManager = await authManager.refresh(stored.refreshToken);
    const minecraft = await xboxManager.getMinecraft();

    currentAuthorization = minecraft.mclc();
    currentAccount = toSummary(currentAuthorization);

    // Microsoft rotates refresh tokens; persist the new one or the next
    // restore will fail.
    writePersisted(xboxManager.save(), currentAccount);

    console.log(`[auth] Session restored for ${currentAccount.name} in ${Date.now() - startedAt} ms`);
    return currentAccount;
  } catch (err) {
    console.warn('[auth] Silent refresh failed, interactive login required:', (err as Error).message);
    clearSession();
    return null;
  }
}

/** Drop in-memory tokens and delete the encrypted blob. */
export function clearSession(): void {
  currentAuthorization = null;
  currentAccount = null;
  try {
    if (fs.existsSync(ACCOUNT_FILE)) fs.rmSync(ACCOUNT_FILE);
  } catch {
    /* best effort */
  }
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
