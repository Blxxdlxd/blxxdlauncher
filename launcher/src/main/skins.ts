/**
 * Player skin lookup, for the head shown next to an account name.
 *
 * Mojang splits this across two hosts: the session server returns a profile
 * whose `textures` property is base64-encoded JSON, and that JSON points at the
 * actual PNG on textures.minecraft.net.
 *
 * The whole skin is handed to the renderer as a data URI and cropped in CSS
 * rather than being cut up here. A 64x64 PNG is about two kilobytes encoded, so
 * there is nothing to gain from server-side image processing, and CSS can layer
 * the hat over the face in a way `nativeImage` cannot composite anyway.
 *
 * Requests go through the main process because the renderer's CSP sets
 * `connect-src 'none'`, and because caching belongs on this side.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { DIRS, ensureDir } from './paths';

const PROFILE_URL = 'https://sessionserver.mojang.com/session/minecraft/profile/';

/**
 * Skins change rarely and the session server is rate limited per IP, so a day
 * is generous. A stale cache is still served when the network is unavailable —
 * an offline launcher showing the right head beats one showing none.
 */
const TTL_MS = 24 * 60 * 60 * 1000;

const SKINS_DIR = path.join(DIRS.launcherState, 'skins');

/** Decoded data URIs, keyed by dashless UUID. Cleared on restart. */
const memory = new Map<string, string>();

/**
 * UUIDs arrive over IPC and are interpolated into both a URL and a file path,
 * so they are validated rather than trusted: hex and dashes only, nothing that
 * could climb out of the cache directory or alter the request path.
 */
function normaliseUuid(uuid: string): string | null {
  const stripped = uuid.replace(/-/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(stripped) ? stripped : null;
}

function cachePath(uuid: string): string {
  return path.join(SKINS_DIR, `${uuid}.png`);
}

function toDataUri(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`;
}

function readCache(uuid: string): { png: Buffer; ageMs: number } | null {
  try {
    const file = cachePath(uuid);
    const stat = fs.statSync(file);
    return { png: fs.readFileSync(file), ageMs: Date.now() - stat.mtimeMs };
  } catch {
    return null;
  }
}

interface TexturePayload {
  readonly textures?: {
    readonly SKIN?: { readonly url?: string };
  };
}

interface ProfileResponse {
  readonly properties?: ReadonlyArray<{ readonly name?: string; readonly value?: string }>;
}

/** Resolve the skin PNG's URL, or null when the account uses a default skin. */
async function resolveSkinUrl(uuid: string, signal: AbortSignal): Promise<string | null> {
  const response = await fetch(`${PROFILE_URL}${uuid}`, {
    headers: { accept: 'application/json' },
    signal,
  });

  // 204 is the session server's "no such profile"; 429 is the rate limiter.
  if (!response.ok || response.status === 204) return null;

  const profile = (await response.json()) as ProfileResponse;
  const encoded = profile.properties?.find((p) => p.name === 'textures')?.value;
  if (typeof encoded !== 'string') return null;

  const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as TexturePayload;
  const url = decoded.textures?.SKIN?.url;

  // Pin the host. The URL comes from a remote response, and this is the only
  // place the launcher would follow one; textures.minecraft.net is where Mojang
  // serves them, and anything else is not a skin we should be fetching.
  if (typeof url !== 'string') return null;
  try {
    if (new URL(url).host !== 'textures.minecraft.net') return null;
  } catch {
    return null;
  }
  return url;
}

/**
 * The skin PNG for a player, as a data URI, or null when they have no custom
 * skin and for any failure. Callers render an initial in that case.
 */
export async function getSkin(rawUuid: string): Promise<string | null> {
  const uuid = normaliseUuid(rawUuid);
  if (!uuid) return null;

  const cached = memory.get(uuid);
  if (cached) return cached;

  const onDisk = readCache(uuid);
  if (onDisk && onDisk.ageMs < TTL_MS) {
    const uri = toDataUri(onDisk.png);
    memory.set(uuid, uri);
    return uri;
  }

  // Neither request should hold up the UI; the head is decoration.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const url = await resolveSkinUrl(uuid, controller.signal);
    if (!url) return onDisk ? toDataUri(onDisk.png) : null;

    const skin = await fetch(url, { signal: controller.signal });
    if (!skin.ok) return onDisk ? toDataUri(onDisk.png) : null;

    const png = Buffer.from(await skin.arrayBuffer());

    // A skin is 64x64 (or legacy 64x32) and never large. Anything past this is
    // not something to cache or hand to the renderer.
    if (png.length === 0 || png.length > 256 * 1024) {
      return onDisk ? toDataUri(onDisk.png) : null;
    }

    ensureDir(SKINS_DIR);
    fs.writeFileSync(cachePath(uuid), png);

    const uri = toDataUri(png);
    memory.set(uuid, uri);
    return uri;
  } catch (err) {
    // Offline, timed out, rate limited: fall back to whatever we last saw.
    console.warn(`[skins] ${uuid}: ${(err as Error).message}`);
    return onDisk ? toDataUri(onDisk.png) : null;
  } finally {
    clearTimeout(timer);
  }
}

/** Drop a cached skin so the next request refetches. Used after a fresh login. */
export function forgetSkin(rawUuid: string): void {
  const uuid = normaliseUuid(rawUuid);
  if (!uuid) return;
  memory.delete(uuid);
  try {
    fs.rmSync(cachePath(uuid));
  } catch {
    /* nothing cached */
  }
}
