/**
 * Per-instance artwork.
 *
 * An instance's identity has been a single emoji, which is legible at 40px and
 * says nothing at 200px in the library layout's hero panel. This lets a picture
 * stand in for it.
 *
 * Images are copied into the launcher's own state rather than referenced where
 * the user found them: a wallpaper that moves or gets deleted would otherwise
 * leave a permanently broken instance. They are re-encoded to PNG on the way
 * in, which also normalises whatever the source format was.
 *
 * The renderer receives a data URI, never a path. Its CSP allows `data:` and
 * the page is served from `file://`, where `'self'` does not usefully cover
 * arbitrary local files — and shipping bytes it already trusts is simpler than
 * widening the policy.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { BrowserWindow, dialog, nativeImage } from 'electron';

import { DIRS, ensureDir } from './paths';

const ARTWORK_DIR = path.join(DIRS.launcherState, 'artwork');

/**
 * Longest edge kept, in pixels.
 *
 * The largest this is ever drawn is the hero panel at roughly 200px, so 512
 * covers a 2x display with room to spare. It matters because the image becomes
 * a base64 data URI crossing an IPC boundary on every render — a 4K wallpaper
 * pasted in unresized would be several megabytes of string per instance.
 */
const MAX_EDGE = 512;

/** Decoded data URIs by instance id. */
const memory = new Map<string, string | null>();

/**
 * Instance ids are generated directory-safe, but this is interpolated into a
 * filesystem path from an IPC payload, so it is checked rather than trusted.
 */
function artworkPath(instanceId: string): string | null {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(instanceId) || instanceId.startsWith('.')) return null;
  return path.join(ARTWORK_DIR, `${instanceId}.png`);
}

function toDataUri(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** The stored artwork for an instance, or null when it has none. */
export async function getArtwork(instanceId: string): Promise<string | null> {
  const cached = memory.get(instanceId);
  if (cached !== undefined) return cached;

  const file = artworkPath(instanceId);
  if (file === null) return null;

  try {
    const uri = toDataUri(fs.readFileSync(file));
    memory.set(instanceId, uri);
    return uri;
  } catch {
    memory.set(instanceId, null);
    return null;
  }
}

/**
 * Ask for an image and store it as this instance's artwork.
 *
 * @returns the new artwork as a data URI, or null when the user cancelled
 * @throws when the chosen file is not a decodable image
 */
export async function chooseArtwork(instanceId: string): Promise<string | null> {
  const file = artworkPath(instanceId);
  if (file === null) throw new Error('Bad instance id.');

  const parent = BrowserWindow.getFocusedWindow();
  const result = await (parent
    ? dialog.showOpenDialog(parent, openOptions())
    : dialog.showOpenDialog(openOptions()));

  if (result.canceled || result.filePaths.length === 0) return null;
  const source = result.filePaths[0];
  if (source === undefined) return null;

  const image = nativeImage.createFromPath(source);
  if (image.isEmpty()) {
    // Covers a wrong extension, a corrupt file, and formats Chromium will not
    // decode — all of which reach here looking like a valid path.
    throw new Error('That file could not be read as an image.');
  }

  const { width, height } = image.getSize();
  const scaled =
    Math.max(width, height) > MAX_EDGE
      ? image.resize(width >= height ? { width: MAX_EDGE } : { height: MAX_EDGE })
      : image;

  const png = scaled.toPNG();
  if (png.length === 0) throw new Error('That image could not be converted.');

  ensureDir(ARTWORK_DIR);
  fs.writeFileSync(file, png);

  const uri = toDataUri(png);
  memory.set(instanceId, uri);
  return uri;
}

function openOptions(): Electron.OpenDialogOptions {
  return {
    title: 'Choose instance artwork',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
  };
}

/** Forget an instance's artwork, falling back to its icon. */
export function clearArtwork(instanceId: string): void {
  const file = artworkPath(instanceId);
  memory.set(instanceId, null);
  if (file === null) return;
  try {
    fs.rmSync(file);
  } catch {
    /* nothing stored */
  }
}
