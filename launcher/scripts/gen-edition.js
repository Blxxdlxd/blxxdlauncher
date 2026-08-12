/*
 * Generate src/main/edition.ts from the environment, before tsc runs.
 *
 * Two values are baked in per build rather than shipped in source:
 *
 *   BLXXDLAUNCHER_DIRECTORY    friends server this build connects to
 *   BLXXDLAUNCHER_CF_KEY       CurseForge API key, so mod browsing works
 *                              without every recipient applying for their own
 *
 * Both are private. The generated file is git-ignored, so a public build ships
 * with neither and the repository never contains either.
 *
 * Anyone holding a build can extract the key from it — that is unavoidable for
 * a desktop app, and is why this is a deliberate choice about who receives the
 * build rather than something to do by default.
 *
 *   npm run dist        -> nothing baked in
 *   npm run dist:dev    -> both baked in
 */
const fs = require('node:fs');
const path = require('node:path');

const directory = (process.env.BLXXDLAUNCHER_DIRECTORY ?? '').trim();
const curseforgeKey = (process.env.BLXXDLAUNCHER_CF_KEY ?? '').trim();
const out = path.join(__dirname, '..', 'src', 'main', 'edition.ts');

const body = `/**
 * GENERATED — do not edit, and do not commit.
 *
 * Written by scripts/gen-edition.js at build time. See that file for why these
 * values live here rather than in source.
 */

/** Directory this build connects to out of the box. Empty means "ask the user". */
export const DEFAULT_DIRECTORY_URL = ${JSON.stringify(directory)};

/**
 * CurseForge key compiled into this build.
 *
 * A key the user has entered themselves always wins; this is only the fallback
 * so a build can browse CurseForge with no setup.
 */
export const BUNDLED_CURSEFORGE_KEY = ${JSON.stringify(curseforgeKey)};

/** True when this build was made with private values baked in. */
export const IS_DEV_BUILD = ${JSON.stringify(directory.length > 0 || curseforgeKey.length > 0)};
`;

fs.writeFileSync(out, body, 'utf8');

console.log(
  `[edition] directory=${directory || '(none)'} curseforge=${curseforgeKey ? 'bundled' : '(none)'}`,
);
