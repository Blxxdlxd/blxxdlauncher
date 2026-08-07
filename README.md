# Blxxdlauncher

A Minecraft launcher. Electron + TypeScript, Windows-first.

It creates isolated instances on any Minecraft version and any of the four
loaders — NeoForge, Forge, Fabric or plain vanilla — signs in with a Microsoft
account, and installs mods into an instance from Modrinth and CurseForge.

Nothing it does touches `%APPDATA%\.minecraft`. The whole installation lives
under `~/.blxxdlauncher`, so a vanilla launcher install stays pristine and a
third-party mod manager cannot clobber it (or be clobbered by it).

---

## What it does

**Instances.** Each instance is a complete, isolated game directory — its own
`mods/`, `config/`, `saves/`, `resourcepacks/`, `logs/`. Two instances on
different Minecraft versions coexist with no mod manager arbitrating between
them. Heap size and extra JVM flags are per-instance.

**Any version, any loader.** Version lists are pulled live from Mojang's
manifest, the NeoForged Maven, the Forge promotions file and Fabric's meta API,
and cached for six hours. Loader builds are listed per Minecraft version, so
you pick a real build rather than typing one. The required Java major version
comes from the version's own `javaVersion.majorVersion` — not a hardcoded
table, which would demand Java 21 for 1.16.5.

**Mod installation.** Search Modrinth and CurseForge together or separately,
filtered to the instance's loader and Minecraft version. Dependencies are
resolved recursively. Downloads are written to a `.part` file, checked against
the hash the API published, and only then renamed into place — a truncated
download never lands in `mods/` looking installed. An installed-mods list is
kept per instance so mods can be removed by name rather than by guessing which
jar is which.

**Launching.** Loader installers are run headlessly and cached. Assets are
fetched through a bounded worker pool. The JVM argument vector is assembled
explicitly, and the resolved JVM's major version is verified with `java
-version` *before* anything downloads — running the NeoForge installer under
Java 8 otherwise fails halfway through patching and leaves a version directory
that looks installed.

---

## Requirements

- **Node 20+** and **npm** to build.
- **A JDK per era you launch.** Java 21 for modern versions, Java 8 for 1.7.10.
  The launcher will not install one for you. Point it at yours in
  `~/.blxxdlauncher/launcher/runtimes.json`:

  ```json
  { "8": "C:\\Program Files\\Eclipse Adoptium\\jdk-8...", "21": "C:\\Program Files\\Eclipse Adoptium\\jdk-21..." }
  ```

  A file rather than an environment variable on purpose: a variable set in a
  terminal is invisible to a shortcut launched from Explorer, so the app would
  silently pick the wrong JVM and the game would die with
  `UnsupportedClassVersionError`.

- **A Minecraft account.** Sign-in is Microsoft OAuth via `msmc`. There is no
  offline or cracked mode and none will be added.

---

## Build and run

```bash
cd launcher && npm install && npm start
```

Package a Windows build:

```bash
cd launcher && npm run dist
```

The result is `launcher/dist/win-unpacked/Blxxdlauncher.exe`.

---

## CurseForge

CurseForge's Core API requires a per-application key, which you request from
them; it is not something this repo can ship. Without one the launcher searches
Modrinth only and says so in the mod browser — CurseForge is an enhancement,
not a dependency.

To add a key: open an instance's mod browser, click **Add a CurseForge key**,
paste it. It is stored at `~/.blxxdlauncher/launcher/curseforge.key` and is
never written into the repo (`.gitignore` refuses `*.key` regardless).

Two things this launcher deliberately does not do:

- **It does not reconstruct download URLs.** When a project's `downloadUrl` is
  null, the author has opted out of third-party distribution. The launcher
  reports that and links you to the project page. Rebuilding the CDN path from
  the file id — which does work — would be routing around a choice the author
  made on purpose.
- **It does not reuse anybody else's API key.** Keys are issued per application
  and are not transferable.

---

## Layout

```
launcher/src/main/       Electron main process
  main.ts                app bootstrap, IPC surface
  auth.ts                Microsoft OAuth (msmc), token persistence
  paths.ts               ~/.blxxdlauncher layout
  instances.ts           instance registry, create/edit/delete, migration
  profiles.ts            runtime templates, JVM resolution
  versions.ts            cached Mojang/NeoForge/Forge/Fabric catalogues
  loader-install.ts      headless loader installer runs
  assets.ts              bounded-concurrency asset fetch
  launch.ts              JVM argv assembly, MCLC handoff
  mods.ts                Modrinth + CurseForge search, install, dependencies
  curseforge.ts          CurseForge Core API client
  preload.ts             the context bridge

launcher/src/renderer/   the UI (no framework, no bundler)
launcher/src/shared/     types shared across the process boundary
artifacts/               client-core jars, if any (see below)
```

**Security model.** The renderer runs with `contextIsolation: true`,
`sandbox: true`, `nodeIntegration: false`, under a CSP that forbids inline
script. Everything privileged crosses one audited preload bridge, typed with
`satisfies typeof import(...)` so the bridge and the renderer's view of it
cannot drift apart silently.

---

## `artifacts/`

A template may name a client-core jar. If the jar is present it is staged into
the instance's `mods/` and loaded like any other mod. If it is absent — which
is the default state of a fresh clone — the instance launches anyway, and the
runtime log names the path it looked for.

This repo contains the launcher only. The client cores are built from a
separate source tree and are not required to use it: every instance is a
complete, working Minecraft install without one.

---

## Licence

All rights reserved.
