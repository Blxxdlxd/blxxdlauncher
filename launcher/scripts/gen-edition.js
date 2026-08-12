/*
 * Generate src/main/edition.ts from the environment, before tsc runs.
 *
 * The dev build ships pointing at a private directory server; the public build
 * must not, because that hostname would end up in a repository and in every
 * copy handed out. A generated, git-ignored file keeps the value in the build
 * rather than in the source.
 *
 *   npm run dist        -> no default directory (public)
 *   npm run dist:dev    -> BLXXDLAUNCHER_DIRECTORY baked in
 */
const fs = require('node:fs');
const path = require('node:path');

const url = (process.env.BLXXDLAUNCHER_DIRECTORY ?? '').trim();
const out = path.join(__dirname, '..', 'src', 'main', 'edition.ts');

const body = `/**
 * GENERATED — do not edit, and do not commit.
 *
 * Written by scripts/gen-edition.js at build time. See that file for why the
 * value lives here rather than in settings.ts.
 */

/** Directory this build connects to out of the box. Empty means "ask the user". */
export const DEFAULT_DIRECTORY_URL = ${JSON.stringify(url)};

/** True when this build was made with a directory baked in. */
export const IS_DEV_BUILD = ${JSON.stringify(url.length > 0)};
`;

fs.writeFileSync(out, body, 'utf8');
console.log(`[edition] ${url.length > 0 ? `dev build -> ${url}` : 'public build -> no default directory'}`);
