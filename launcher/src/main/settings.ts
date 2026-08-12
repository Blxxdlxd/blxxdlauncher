/**
 * Launcher preferences: appearance, and whatever else accumulates.
 *
 * Deliberately separate from `instances.json`. That file is a record of what
 * the user has built and is the one thing here worth backing up; this is
 * throwaway presentation state. Mixing them would mean a corrupt theme name
 * could take the instance list down with it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { DIRS, ensureDir } from './paths';
import { DEFAULT_DIRECTORY_URL } from './edition';
import type { LauncherSettings } from '../shared/types';

const SETTINGS_FILE = path.join(DIRS.launcherState, 'settings.json');

/**
 * What a fresh install looks like.
 *
 * `midnight` and `compact` are the appearance the launcher shipped with, so an
 * existing user who has never opened the picker sees no change.
 */
const DEFAULTS: LauncherSettings = {
  theme: 'midnight',
  layout: 'compact',
  directoryUrl: DEFAULT_DIRECTORY_URL,
};

/**
 * Every theme the stylesheet defines. Validated against, so a hand-edited or
 * downgraded settings file cannot leave the UI referencing a `data-theme` that
 * has no rules — which renders as an unstyled page rather than an error.
 */
export const THEMES = [
  'midnight', 'slate', 'nord', 'ember', 'daylight',
  'win95', 'xbox360',
] as const;

/** Every layout the stylesheet defines. */
export const LAYOUTS = ['compact', 'grid', 'library'] as const;

let cached: LauncherSettings | null = null;

export function getSettings(): LauncherSettings {
  if (cached) return cached;

  try {
    // Strip a UTF-8 BOM: every native Windows editor writes one and JSON.parse
    // rejects it. Same guard as runtimes.json, for the same reason.
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8').replace(/^﻿/, '');
    const parsed = JSON.parse(raw) as Partial<LauncherSettings>;

    cached = {
      theme: isTheme(parsed.theme) ? parsed.theme : DEFAULTS.theme,
      layout: isLayout(parsed.layout) ? parsed.layout : DEFAULTS.layout,
      directoryUrl:
        typeof parsed.directoryUrl === 'string' && parsed.directoryUrl.length > 0
          ? parsed.directoryUrl
          : DEFAULT_DIRECTORY_URL,
    };
  } catch {
    // Absent on first run, and unreadable is not worth failing a launch over.
    cached = { ...DEFAULTS };
  }
  return cached;
}

/**
 * Merge a partial update and persist.
 *
 * @returns the settings as they now stand, so the caller needs no second read
 */
export function updateSettings(patch: Partial<LauncherSettings>): LauncherSettings {
  const current = getSettings();

  // Each field validated independently: an unknown theme should not also
  // discard a perfectly good layout in the same call. Built as one literal
  // because LauncherSettings is readonly — the type is shared with the
  // renderer, where nothing should be mutating it in place.
  const next: LauncherSettings = {
    theme: isTheme(patch.theme) ? patch.theme : current.theme,
    layout: isLayout(patch.layout) ? patch.layout : current.layout,
    directoryUrl:
      typeof patch.directoryUrl === 'string' ? patch.directoryUrl.trim() : current.directoryUrl,
  };

  cached = next;

  try {
    ensureDir(DIRS.launcherState);
    fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch (err) {
    // The in-memory value still applies, so the UI updates either way — it just
    // will not survive a restart.
    console.warn('[settings] Could not write settings.json:', (err as Error).message);
  }

  return next;
}

function isTheme(value: unknown): value is LauncherSettings['theme'] {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

function isLayout(value: unknown): value is LauncherSettings['layout'] {
  return typeof value === 'string' && (LAYOUTS as readonly string[]).includes(value);
}
