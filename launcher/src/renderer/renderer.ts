/**
 * Renderer. Pure DOM, no framework, no Node access — it can only talk to the
 * main process through `window.launcher` (see preload.ts).
 */

/*
 * NOTE: this file deliberately contains no top-level `import` or `export`.
 *
 * Any import statement — even `import type`, which emits nothing itself — makes
 * TypeScript treat the file as a module, and the CommonJS target then prefixes
 * the output with `Object.defineProperty(exports, "__esModule", ...)`. The page
 * loads this as a plain `<script>`, where `exports` does not exist, so the very
 * first line throws `ReferenceError: exports is not defined` and none of the UI
 * ever runs.
 *
 * `import('...')` in *type position* is erased without making the file a
 * module, so the shared contracts stay shared and the output stays a script.
 */
type AccountSummary = import('../shared/types').AccountSummary;
type InstanceSummary = import('../shared/types').InstanceSummary;
type InstanceTemplate = import('../shared/types').InstanceTemplate;
type InstanceDraft = import('../shared/types').InstanceDraft;
type McVersion = import('../shared/types').McVersion;
type LoaderKind = import('../shared/types').LoaderKind;
type LoaderBuild = import('../shared/types').LoaderBuild;
type ModSearchResult = import('../shared/types').ModSearchResult;
type InstalledMod = import('../shared/types').InstalledMod;
type ModSource = import('../shared/types').ModSource;
type LauncherBridge = import('../shared/types').LauncherBridge;
type LaunchEvent = import('../shared/types').LaunchEvent;

// Global augmentation, not `declare global` — that form is only valid inside a
// module, and this file is intentionally a script.
interface Window {
  readonly launcher: LauncherBridge;
}

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
};

const accountName = el<HTMLSpanElement>('account-name');
const btnLogin = el<HTMLButtonElement>('btn-login');
const btnLogout = el<HTMLButtonElement>('btn-logout');
const btnOpenRoot = el<HTMLButtonElement>('btn-open-root');
const instanceGrid = el<HTMLUListElement>('instance-grid');
const btnNewInstance = el<HTMLButtonElement>('btn-new-instance');

const dialog = el<HTMLDialogElement>('instance-dialog');
const dialogForm = el<HTMLFormElement>('instance-form');
const dialogTitle = el<HTMLHeadingElement>('dialog-title');
const dialogConfirm = el<HTMLButtonElement>('dialog-confirm');
const dialogCancel = el<HTMLButtonElement>('dialog-cancel');
const dialogError = el<HTMLParagraphElement>('dialog-error');
const templateBlock = el<HTMLDivElement>('template-block');
const loaderChoices = el<HTMLDivElement>('loader-choices');
const buildBlock = el<HTMLDivElement>('build-block');
const fieldMc = el<HTMLSelectElement>('field-mc');
const fieldSnapshots = el<HTMLInputElement>('field-snapshots');
const fieldBuild = el<HTMLSelectElement>('field-build');
const fieldName = el<HTMLInputElement>('field-name');
const fieldIcon = el<HTMLInputElement>('field-icon');
const fieldMemMax = el<HTMLInputElement>('field-mem-max');
const fieldMemMin = el<HTMLInputElement>('field-mem-min');

const confirmDialog = el<HTMLDialogElement>('confirm-dialog');
const confirmBody = el<HTMLParagraphElement>('confirm-body');
const confirmDeleteFiles = el<HTMLInputElement>('confirm-delete-files');
const confirmOk = el<HTMLButtonElement>('confirm-ok');
const confirmCancel = el<HTMLButtonElement>('confirm-cancel');
const progress = el<HTMLProgressElement>('progress');
const log = el<HTMLPreElement>('log');

let signedIn = false;

/** Treat "within this many px of the bottom" as the user following the tail. */
const STICK_TO_BOTTOM_PX = 24;

function isPinnedToBottom(): boolean {
  return log.scrollHeight - log.scrollTop - log.clientHeight <= STICK_TO_BOTTOM_PX;
}

function append(line: string, cls?: 'err' | 'ok'): void {
  // Decide *before* mutating, or the measurement reflects the new content.
  const pinned = isPinnedToBottom();

  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = `${line}\n`;
  log.appendChild(span);

  // Keep the buffer bounded; modded 1.7.10 packs are extremely chatty.
  // Trimming from the top shortens the scrollable area above the viewport, so
  // a reader who has scrolled up gets yanked. Compensate by subtracting the
  // height we removed from scrollTop.
  if (log.childElementCount > 2_000) {
    const before = log.scrollHeight;
    while (log.childElementCount > 2_000) {
      log.removeChild(log.firstChild!);
    }
    if (!pinned) {
      log.scrollTop = Math.max(0, log.scrollTop - (before - log.scrollHeight));
    }
  }

  // Only auto-follow when the user was already at the bottom. Unconditionally
  // assigning scrollTop fights anyone trying to read back through the log.
  if (pinned) {
    log.scrollTop = log.scrollHeight;
  }
}

function setAccount(account: AccountSummary | null): void {
  signedIn = account !== null;
  accountName.textContent = account ? account.name : 'Not signed in';
  btnLogin.hidden = signedIn;
  btnLogout.hidden = !signedIn;
  refreshLaunchButtons();
}

/**
 * Transitional state while `restoreSession()` negotiates.
 *
 * That call runs the full Microsoft -> Xbox Live -> XSTS -> Minecraft chain and
 * takes seconds. Previously the UI sat on "Not signed in" with a live sign-in
 * button for that whole window, so the obvious move was to click it — which is
 * why re-authenticating felt mandatory on every start even though the stored
 * session was about to restore itself.
 *
 * Now the cached name is shown straight away and the sign-in button stays
 * hidden until we know the outcome. Launch stays disabled throughout: a cached
 * name is not a valid token.
 */
function setRestoring(cached: AccountSummary | null): void {
  signedIn = false;
  accountName.textContent = cached ? `${cached.name} — restoring session…` : 'Restoring session…';
  btnLogin.hidden = true;
  btnLogout.hidden = true;
  refreshLaunchButtons();
}

/** Instance state, kept so a re-render needs no extra IPC round trip. */
let instances: InstanceSummary[] = [];
let templates: InstanceTemplate[] = [];

/** Instances with a launch in flight, so Play cannot be double-fired. */
const launching = new Set<string>();

function refreshLaunchButtons(): void {
  instanceGrid.querySelectorAll<HTMLButtonElement>('button[data-play]').forEach((node) => {
    const id = node.dataset['play'] ?? '';
    const summary = instances.find((entry) => entry.instance.id === id);
    node.disabled = !signedIn || launching.has(id) || summary?.javaReady === false;
  });
}

function formatSize(bytes: number | null): string {
  if (bytes === null || bytes === 0) return 'empty';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function formatPlayed(at: number | null): string {
  if (at === null) return 'never played';
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function makeButton(label: string, onClick: () => void, className?: string): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  if (className) node.className = className;
  node.addEventListener('click', onClick);
  return node;
}

/** Forge build strings repeat the Minecraft version; drop the duplicate. */
function shortBuild(loaderVersion: string, minecraftVersion: string): string {
  return loaderVersion.startsWith(`${minecraftVersion}-`)
    ? loaderVersion.slice(minecraftVersion.length + 1)
    : loaderVersion;
}

function badge(text: string, kind?: 'muted' | 'warn' | 'error'): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = kind ? `badge ${kind}` : 'badge';
  span.textContent = text;
  return span;
}

function renderInstances(): void {
  instanceGrid.replaceChildren();

  if (instances.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'instance-empty';
    empty.textContent = 'No instances yet — create one to get started.';
    instanceGrid.appendChild(empty);
    return;
  }

  for (const summary of instances) {
    const { instance } = summary;
    const { runtime } = instance;

    const li = document.createElement('li');
    li.className = 'instance-card';
    // Drives the accent stripe and icon tint, so loader families stay
    // distinguishable without reading the badges.
    li.style.setProperty('--accent', summary.accent);

    const icon = document.createElement('div');
    icon.className = 'instance-icon';
    icon.textContent = instance.icon;

    const body = document.createElement('div');
    body.className = 'instance-body';

    const title = document.createElement('h3');
    title.textContent = instance.name;

    const badges = document.createElement('div');
    badges.className = 'badges';
    badges.append(badge(runtime.minecraftVersion));
    badges.append(
      runtime.loader === 'vanilla'
        ? badge('vanilla', 'muted')
        : badge(`${runtime.loader} ${shortBuild(runtime.loaderVersion, runtime.minecraftVersion)}`, 'muted'),
    );
    badges.append(badge(`${instance.memoryMax} heap`, 'muted'));

    // Stated plainly rather than left to be discovered after a download: only
    // 1.21.1-NeoForge and 1.7.10-Forge have a client core built.
    badges.append(
      summary.clientCoreJar !== null
        ? badge('client core')
        : badge('no client core', 'muted'),
    );

    if (!summary.installed) badges.append(badge('not installed', 'warn'));
    if (!summary.javaReady) badges.append(badge(`needs Java ${runtime.javaMajor}`, 'error'));

    const meta = document.createElement('p');
    meta.className = 'instance-meta';
    meta.textContent = `${formatPlayed(instance.lastPlayed)} · ${formatSize(summary.sizeBytes)}`;

    body.append(title, badges, meta);

    const actions = document.createElement('div');
    actions.className = 'instance-actions';

    const play = makeButton('Play', () => void startLaunch(instance.id), 'primary');
    play.dataset['play'] = instance.id;

    actions.append(
      play,
      makeButton('Mods', () => openMods(summary)),
      makeButton('Edit', () => openEditDialog(summary)),
      makeButton('Folder', () => void window.launcher.openInstanceFolder(instance.id)),
      makeButton('Copy', () => void runAction(() => window.launcher.duplicateInstance(instance.id))),
      makeButton('Delete', () => openDeleteDialog(summary), 'danger'),
    );

    li.append(icon, body, actions);
    instanceGrid.appendChild(li);
  }

  refreshLaunchButtons();
}

async function refreshInstances(): Promise<void> {
  instances = await window.launcher.listInstances();
  renderInstances();
}

/** Run a mutation, then re-read the list so the UI shows what main actually did. */
async function runAction(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
    await refreshInstances();
  } catch (err) {
    append((err as Error).message, 'err');
  }
}

async function startLaunch(id: string): Promise<void> {
  launching.add(id);
  refreshLaunchButtons();
  append(`> launching ${id}`);
  try {
    await window.launcher.launch(id);
  } catch (err) {
    append(`launch failed: ${(err as Error).message}`, 'err');
  } finally {
    launching.delete(id);
    // Re-read rather than patch: lastPlayed changed in main.
    void refreshInstances();
  }
}

/* ------------------------------------------------------------------ dialogs */

/**
 * Which instance the dialog is editing, or null when creating.
 *
 * One dialog serves both jobs because the fields are identical bar the version
 * picker — which is hidden when editing, since changing the era under an
 * existing instance would leave its mods and worlds attached to a runtime that
 * cannot load them.
 */
let editing: InstanceSummary | null = null;

/** Version catalogue, fetched lazily the first time the dialog opens. */
let mcVersions: McVersion[] = [];
let availableLoaders: LoaderKind[] = [];
let chosenLoader: LoaderKind = 'vanilla';

const LOADER_ACCENTS: Record<LoaderKind, string> = {
  neoforge: '#5B8CFF',
  forge: '#FFB454',
  fabric: '#C8A2F0',
  vanilla: '#6EE7A8',
};

const LOADER_BLURBS: Record<LoaderKind, string> = {
  neoforge: 'Modern Forge fork. 1.20.2 and newer.',
  forge: 'The long-running loader. Almost every version.',
  fabric: 'Lightweight and fast to update.',
  vanilla: 'Unmodded Minecraft.',
};

/**
 * Which combinations a client core exists for.
 *
 * Mirrors `clientCoreFor` in main. Duplicated deliberately rather than fetched:
 * it is two entries, it decides only whether to draw a note in the dialog, and
 * an IPC round trip on every loader click to render one line of text is not
 * worth the latency. The card badges come from main and are authoritative.
 */
function hasClientCore(minecraftVersion: string, loader: LoaderKind): boolean {
  return (
    (minecraftVersion === '1.21.1' && loader === 'neoforge') ||
    (minecraftVersion === '1.7.10' && loader === 'forge')
  );
}

function renderMcVersions(): void {
  const showSnapshots = fieldSnapshots.checked;
  const previous = fieldMc.value;

  fieldMc.replaceChildren();
  for (const version of mcVersions) {
    // "old" covers the 2009-2011 alpha/beta builds. They are in the manifest
    // but no loader here supports them, so listing them is noise.
    if (version.type === 'old') continue;
    if (version.type === 'snapshot' && !showSnapshots) continue;

    const option = document.createElement('option');
    option.value = version.id;
    option.textContent = version.type === 'snapshot' ? `${version.id}  (snapshot)` : version.id;
    fieldMc.appendChild(option);
  }

  // Keep the selection across a snapshot toggle when it is still in the list.
  if (previous && fieldMc.querySelector(`option[value="${CSS.escape(previous)}"]`)) {
    fieldMc.value = previous;
  }
}

async function refreshLoaders(): Promise<void> {
  const version = fieldMc.value;
  loaderChoices.replaceChildren();
  loaderChoices.textContent = 'Checking loaders…';

  try {
    availableLoaders = await window.launcher.listLoaders(version);
  } catch (err) {
    availableLoaders = ['vanilla'];
    append(`could not list loaders: ${(err as Error).message}`, 'err');
  }

  // The version may have changed while that was in flight.
  if (fieldMc.value !== version) return;

  if (!availableLoaders.includes(chosenLoader)) {
    // Prefer a mod loader over vanilla — someone opening this dialog is
    // usually here to mod something.
    chosenLoader = availableLoaders.find((loader) => loader !== 'vanilla') ?? 'vanilla';
  }

  renderLoaderChoices();
  await refreshBuilds();
}

function renderLoaderChoices(): void {
  loaderChoices.replaceChildren();

  for (const loader of availableLoaders) {
    const choice = document.createElement('button');
    choice.type = 'button';
    choice.className = loader === chosenLoader ? 'template-choice selected' : 'template-choice';
    choice.style.setProperty('--accent', LOADER_ACCENTS[loader]);

    const name = document.createElement('strong');
    name.textContent = loader === 'neoforge' ? 'NeoForge' : loader[0]!.toUpperCase() + loader.slice(1);

    const detail = document.createElement('span');
    detail.textContent = hasClientCore(fieldMc.value, loader)
      ? `${LOADER_BLURBS[loader]}  ·  client core available`
      : LOADER_BLURBS[loader];

    choice.append(name, detail);
    choice.addEventListener('click', () => {
      chosenLoader = loader;
      renderLoaderChoices();
      void refreshBuilds();
    });
    loaderChoices.appendChild(choice);
  }
}

async function refreshBuilds(): Promise<void> {
  if (chosenLoader === 'vanilla') {
    buildBlock.hidden = true;
    fieldBuild.replaceChildren();
    return;
  }

  buildBlock.hidden = false;
  fieldBuild.replaceChildren();

  const loading = document.createElement('option');
  loading.textContent = 'Loading…';
  fieldBuild.appendChild(loading);

  const version = fieldMc.value;
  const loader = chosenLoader;

  let builds: LoaderBuild[] = [];
  try {
    builds = await window.launcher.listLoaderBuilds(version, loader);
  } catch (err) {
    append(`could not list ${loader} builds: ${(err as Error).message}`, 'err');
  }

  // Discard a response that arrived after the user moved on.
  if (fieldMc.value !== version || chosenLoader !== loader) return;

  fieldBuild.replaceChildren();
  for (const build of builds) {
    const option = document.createElement('option');
    option.value = build.version;
    // Forge build strings repeat the Minecraft version; strip it so the list
    // reads as build numbers rather than a column of identical prefixes.
    const label = build.version.startsWith(`${version}-`)
      ? build.version.slice(version.length + 1)
      : build.version;
    option.textContent = build.recommended ? `${label}  ★` : label;
    fieldBuild.appendChild(option);
  }

  if (builds.length === 0) {
    const none = document.createElement('option');
    none.textContent = 'none available';
    none.value = '';
    fieldBuild.appendChild(none);
  }
}

async function openCreateDialog(): Promise<void> {
  editing = null;

  dialogTitle.textContent = 'New instance';
  dialogConfirm.textContent = 'Create';
  templateBlock.hidden = false;

  fieldName.value = '';
  fieldIcon.value = '⬦';
  fieldMemMax.value = '8G';
  fieldMemMin.value = '4G';
  dialogError.hidden = true;

  dialog.showModal();
  fieldName.focus();

  if (mcVersions.length === 0) {
    try {
      mcVersions = await window.launcher.listMinecraftVersions();
    } catch (err) {
      dialogError.textContent = `Could not load version list: ${(err as Error).message}`;
      dialogError.hidden = false;
      return;
    }
  }

  renderMcVersions();
  await refreshLoaders();
}

function openEditDialog(summary: InstanceSummary): void {
  editing = summary;

  dialogTitle.textContent = `Edit ${summary.instance.name}`;
  dialogConfirm.textContent = 'Save';
  // Hidden, not disabled: the era is fixed for the life of an instance.
  templateBlock.hidden = true;

  fieldName.value = summary.instance.name;
  fieldIcon.value = summary.instance.icon;
  fieldMemMax.value = summary.instance.memoryMax;
  fieldMemMin.value = summary.instance.memoryMin;
  dialogError.hidden = true;

  dialog.showModal();
  fieldName.focus();
}

const MEMORY_PATTERN = /^\d+[MmGg]$/;

function validateDialog(): string | null {
  if (fieldName.value.trim().length === 0) return 'Give the instance a name.';
  if (!MEMORY_PATTERN.test(fieldMemMax.value.trim())) return 'Max heap must look like 8G or 6144M.';
  if (!MEMORY_PATTERN.test(fieldMemMin.value.trim())) return 'Min heap must look like 4G or 2048M.';
  if (editing !== null) return null;

  if (fieldMc.value.length === 0) return 'Pick a Minecraft version.';
  if (chosenLoader !== 'vanilla' && fieldBuild.value.length === 0) {
    return `No ${chosenLoader} build is available for ${fieldMc.value}.`;
  }
  return null;
}

dialogForm.addEventListener('submit', (event) => {
  // Handled here rather than letting `method="dialog"` close it: the dialog
  // would be gone before the async work started, leaving a failure with
  // nowhere to report itself.
  event.preventDefault();

  const problem = validateDialog();
  if (problem !== null) {
    dialogError.textContent = problem;
    dialogError.hidden = false;
    return;
  }

  const name = fieldName.value.trim();
  const icon = fieldIcon.value.trim();
  const memoryMax = fieldMemMax.value.trim().toUpperCase();
  const memoryMin = fieldMemMin.value.trim().toUpperCase();
  const target = editing;

  dialog.close();

  if (target === null) {
    const loader = chosenLoader;
    void (async () => {
      try {
        const created = await window.launcher.createInstance({
          name,
          minecraftVersion: fieldMc.value,
          loader,
          loaderVersion: loader === 'vanilla' ? '' : fieldBuild.value,
          memoryMax,
          memoryMin,
          icon,
        });
        await refreshInstances();
        // Straight into the mods panel: adding mods is nearly always the next
        // thing after making an instance, and this is what "add mods before
        // it exists" means in practice — the instance is created, then filled,
        // without going hunting for a button.
        if (loader !== 'vanilla') {
          openMods(created);
        }
      } catch (err) {
        append((err as Error).message, 'err');
      }
    })();
    return;
  }

  void runAction(() =>
    window.launcher.updateInstance(target.instance.id, { name, icon, memoryMax, memoryMin }),
  );
});

dialogCancel.addEventListener('click', () => dialog.close());
btnNewInstance.addEventListener('click', () => void openCreateDialog());
fieldMc.addEventListener('change', () => void refreshLoaders());
fieldSnapshots.addEventListener('change', () => {
  renderMcVersions();
  void refreshLoaders();
});

/* ----------------------------------------------------------------- mods */

const modsDialog = el<HTMLDialogElement>('mods-dialog');
const modsTitle = el<HTMLHeadingElement>('mods-title');
const modsTabs = el<HTMLDivElement>('mods-tabs');
const modsBrowse = el<HTMLDivElement>('mods-browse');
const modsInstalledPane = el<HTMLDivElement>('mods-installed');
const modsSearchBox = el<HTMLInputElement>('mods-search');
const modsResults = el<HTMLUListElement>('mods-results');
const modsInstalledList = el<HTMLUListElement>('mods-installed-list');
const modsStatus = el<HTMLParagraphElement>('mods-status');

/** Which instance the panel is showing, or null when closed. */
let modsInstance: InstanceSummary | null = null;

/** Debounce handle, so typing does not fire a request per keystroke. */
let searchTimer = 0;

/** Guards against a slow response overwriting a newer one. */
let searchToken = 0;

function setModsStatus(text: string, kind?: 'err' | 'ok'): void {
  modsStatus.textContent = text;
  modsStatus.className = kind ? `mods-status ${kind}` : 'mods-status';
}

function openMods(summary: InstanceSummary): void {
  modsInstance = summary;
  modsTitle.textContent = `Mods — ${summary.instance.name}`;
  modsSearchBox.value = '';
  modsResults.replaceChildren();
  setModsStatus('');
  selectModTab('installed');
  modsDialog.showModal();
  void refreshInstalledMods();
}

type ModTab = 'installed' | 'all' | 'modrinth' | 'curseforge';

/** Which tab is showing, so a re-search knows what to filter to. */
let modTab: ModTab = 'installed';

/** The host filter the current tab implies; null means every configured one. */
function tabSource(): ModSource | null {
  return modTab === 'modrinth' || modTab === 'curseforge' ? modTab : null;
}

function selectModTab(which: ModTab): void {
  modTab = which;

  modsTabs.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => {
    tab.classList.toggle('selected', tab.dataset['tab'] === which);
  });

  const browsing = which !== 'installed';
  modsBrowse.hidden = !browsing;
  modsInstalledPane.hidden = browsing;

  if (!browsing) return;

  void refreshCurseForgeState();

  // Re-run on every browse tab rather than only when empty: switching from
  // Modrinth to CurseForge has to actually change the results, and the previous
  // tab's rows are the wrong answer.
  void runSearch(modsSearchBox.value);
}

modsTabs.addEventListener('click', (event) => {
  const tab = (event.target as HTMLElement).closest<HTMLButtonElement>('.tab');
  if (tab?.dataset['tab']) selectModTab(tab.dataset['tab'] as ModTab);
});

async function refreshInstalledMods(): Promise<void> {
  if (!modsInstance) return;
  const id = modsInstance.instance.id;

  modsInstalledList.replaceChildren();

  let mods: InstalledMod[] = [];
  try {
    mods = await window.launcher.listInstalledMods(id);
  } catch (err) {
    setModsStatus((err as Error).message, 'err');
    return;
  }

  if (mods.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'mod-empty';
    empty.textContent = 'Nothing installed yet — use Browse to add some.';
    modsInstalledList.appendChild(empty);
    return;
  }

  for (const mod of mods) {
    const li = document.createElement('li');
    li.className = mod.enabled ? 'mod-row' : 'mod-row disabled';

    const body = document.createElement('div');
    body.className = 'mod-body';

    const title = document.createElement('strong');
    title.textContent = mod.title;

    const meta = document.createElement('span');
    const bits = [formatSize(mod.sizeBytes)];
    if (mod.dependency) bits.push('dependency');
    // Worth surfacing: the client core lives here too, and deleting it would
    // quietly turn the instance into plain Minecraft.
    if (mod.external) bits.push('not installed by the launcher');
    if (!mod.enabled) bits.push('disabled');
    meta.textContent = bits.join(' · ');

    body.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'mod-actions';

    actions.append(
      makeButton(mod.enabled ? 'Disable' : 'Enable', () =>
        void modAction(() => window.launcher.setModEnabled(id, mod.fileName, !mod.enabled)),
      ),
      makeButton('Remove', () =>
        void modAction(() => window.launcher.removeMod(id, mod.fileName)), 'danger',
      ),
    );

    li.append(body, actions);
    modsInstalledList.appendChild(li);
  }
}

async function modAction(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
    await refreshInstalledMods();
  } catch (err) {
    setModsStatus((err as Error).message, 'err');
  }
}

async function runSearch(query: string): Promise<void> {
  if (!modsInstance) return;

  const token = ++searchToken;
  setModsStatus('Searching…');

  try {
    const { results } = await window.launcher.searchMods(
      modsInstance.instance.id, query, 0, tabSource());
    // A slower earlier request must not overwrite a newer result set.
    if (token !== searchToken) return;

    renderSearchResults(results);

    if (results.length > 0) {
      setModsStatus('');
    } else if (modTab === 'curseforge' && !cfPrompt.hidden) {
      // The prompt being visible means no key is configured, which is a very
      // different problem from "nothing matched".
      setModsStatus('Add a CurseForge API key to search CurseForge.');
    } else {
      setModsStatus('No mods matched.');
    }
  } catch (err) {
    if (token === searchToken) setModsStatus((err as Error).message, 'err');
  }
}

function renderSearchResults(results: ModSearchResult[]): void {
  modsResults.replaceChildren();

  for (const mod of results) {
    const li = document.createElement('li');
    li.className = 'mod-row';

    if (mod.iconUrl) {
      const icon = document.createElement('img');
      icon.className = 'mod-icon';
      icon.src = mod.iconUrl;
      icon.alt = '';
      // A broken icon should leave a gap, not a browser error glyph.
      icon.addEventListener('error', () => icon.remove());
      li.appendChild(icon);
    }

    const body = document.createElement('div');
    body.className = 'mod-body';

    const title = document.createElement('strong');
    title.textContent = mod.title;

    const description = document.createElement('span');
    description.textContent = mod.description;

    const meta = document.createElement('span');
    meta.className = 'mod-meta';
    const host = mod.source === 'curseforge' ? 'CurseForge' : 'Modrinth';
    meta.textContent = `${host} · ${formatDownloads(mod.downloads)} downloads · by ${mod.author}`;

    body.append(title, description, meta);

    const actions = document.createElement('div');
    actions.className = 'mod-actions';

    if (!mod.downloadable) {
      // The author has opted out of third-party downloads. Say so and point at
      // the page rather than pretending the button might work.
      const link = makeButton('Open page', () => {
        if (mod.websiteUrl) window.open(mod.websiteUrl, '_blank');
      });
      link.title = 'This author does not allow launchers to download their files.';
      actions.appendChild(link);
    } else {
      const install = makeButton(mod.installed ? 'Installed' : 'Install',
        () => void installMod(mod), mod.installed ? undefined : 'primary');
      install.disabled = mod.installed;
      actions.appendChild(install);
    }

    li.append(body, actions);
    modsResults.appendChild(li);
  }
}

async function installMod(mod: ModSearchResult): Promise<void> {
  if (!modsInstance) return;
  setModsStatus(`Installing ${mod.title}…`);

  try {
    // Null version means "newest compatible", which the main process resolves
    // against this instance's Minecraft version and loader.
    const files = await window.launcher.installMod(
      modsInstance.instance.id, mod.projectId, null, mod.source);
    setModsStatus(`Installed ${files.length} file${files.length === 1 ? '' : 's'}.`, 'ok');
    await refreshInstalledMods();
    // Re-run the search so the Install button flips to Installed.
    await runSearch(modsSearchBox.value);
  } catch (err) {
    setModsStatus((err as Error).message, 'err');
  }
}

function formatDownloads(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}K`;
  return String(count);
}

/* ------------------------------------------------- CurseForge key setup */

const cfPrompt = el<HTMLParagraphElement>('cf-prompt');
const cfSetupRow = el<HTMLDivElement>('cf-setup-row');
const cfKeyField = el<HTMLInputElement>('cf-key');

/**
 * Show the prompt only while CurseForge is unconfigured.
 *
 * The key is never read back out of the main process — only whether one exists.
 * There is no reason for the renderer to hold a credential it cannot use.
 */
async function refreshCurseForgeState(): Promise<void> {
  let configured = false;
  try {
    configured = await window.launcher.curseforgeConfigured();
  } catch {
    /* treated as unconfigured */
  }
  cfPrompt.hidden = configured;
  if (configured) cfSetupRow.hidden = true;
}

el<HTMLButtonElement>('cf-setup').addEventListener('click', () => {
  cfSetupRow.hidden = !cfSetupRow.hidden;
  if (!cfSetupRow.hidden) cfKeyField.focus();
});

el<HTMLButtonElement>('cf-save').addEventListener('click', () => {
  const key = cfKeyField.value.trim();
  if (key.length === 0) return;
  void (async () => {
    await window.launcher.setCurseforgeKey(key);
    // Cleared immediately: no reason to leave a credential sitting in a DOM
    // node once it has been handed over.
    cfKeyField.value = '';
    await refreshCurseForgeState();
    setModsStatus('CurseForge key saved.', 'ok');
    await runSearch(modsSearchBox.value);
  })();
});

el<HTMLButtonElement>('cf-clear').addEventListener('click', () => {
  void (async () => {
    await window.launcher.setCurseforgeKey(null);
    cfKeyField.value = '';
    await refreshCurseForgeState();
    setModsStatus('CurseForge key removed.');
    await runSearch(modsSearchBox.value);
  })();
});

modsSearchBox.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  // 300ms: long enough that a typed word is one request, short enough not to
  // feel laggy.
  searchTimer = window.setTimeout(() => void runSearch(modsSearchBox.value), 300);
});

el<HTMLButtonElement>('mods-close').addEventListener('click', () => {
  modsDialog.close();
  modsInstance = null;
  // Sizes and the "not installed" badge may have changed.
  void refreshInstances();
});

el<HTMLButtonElement>('mods-folder').addEventListener('click', () => {
  if (modsInstance) void window.launcher.openInstanceFolder(modsInstance.instance.id);
});

// Progress from the main process during a multi-file install.
window.launcher.onModEvent((message) => setModsStatus(message));

/* -------------------------------------------------------------- delete flow */

let pendingDelete: InstanceSummary | null = null;

function openDeleteDialog(summary: InstanceSummary): void {
  pendingDelete = summary;
  confirmBody.textContent =
    `Remove "${summary.instance.name}" from the launcher? ` +
    `Its folder holds ${formatSize(summary.sizeBytes)}.`;
  // Defaults to off. Unticked this is reversible — the worlds survive and the
  // instance can be recreated pointing at them; ticked, it is not.
  confirmDeleteFiles.checked = false;
  confirmDialog.showModal();
}

confirmCancel.addEventListener('click', () => confirmDialog.close());

confirmOk.addEventListener('click', () => {
  const target = pendingDelete;
  const deleteFiles = confirmDeleteFiles.checked;
  pendingDelete = null;
  confirmDialog.close();
  if (target === null) return;
  void runAction(() => window.launcher.deleteInstance(target.instance.id, deleteFiles));
});

/**
 * Progress bar state.
 *
 * Two problems with driving the bar straight from the event:
 *
 *  1. Toggling the `hidden` attribute takes the element out of layout, so
 *     everything below it jumps by its height + margin. MCLC emits a progress
 *     event per downloaded file — ~3,900 of them for a 1.21 asset pull — and
 *     the old code hid the bar every time one file finished. The result was the
 *     log pane visibly bouncing up and down for the whole download. The bar now
 *     keeps its slot in the layout permanently and only toggles `visibility`
 *     via a class, so nothing reflows.
 *  2. Writing to the DOM on every event is thousands of layout invalidations a
 *     second. Updates are coalesced into one write per animation frame.
 */
let pendingProgress: { current: number; total: number } | null = null;
let progressFrame = 0;
let progressIdleTimer = 0;

/** Hide the bar only after the stream genuinely stops, not between files. */
const PROGRESS_IDLE_MS = 600;

function flushProgress(): void {
  progressFrame = 0;
  if (!pendingProgress) return;

  progress.max = pendingProgress.total > 0 ? pendingProgress.total : 100;
  progress.value = pendingProgress.current;
  progress.classList.add('active');
  pendingProgress = null;

  window.clearTimeout(progressIdleTimer);
  progressIdleTimer = window.setTimeout(() => progress.classList.remove('active'), PROGRESS_IDLE_MS);
}

function scheduleProgress(current: number, total: number): void {
  pendingProgress = { current, total };
  if (progressFrame === 0) {
    progressFrame = window.requestAnimationFrame(flushProgress);
  }
}

/** Terminal states: drop the bar immediately and cancel any queued work. */
function stopProgress(): void {
  if (progressFrame !== 0) {
    window.cancelAnimationFrame(progressFrame);
    progressFrame = 0;
  }
  window.clearTimeout(progressIdleTimer);
  pendingProgress = null;
  progress.classList.remove('active');
}

function handleLaunchEvent(event: LaunchEvent): void {
  switch (event.kind) {
    case 'status':
      append(`· ${event.message}`);
      break;
    case 'progress':
      scheduleProgress(event.current, event.total);
      break;
    case 'log':
      append(event.line, event.stream === 'stderr' ? 'err' : undefined);
      break;
    case 'started':
      stopProgress();
      append(`game started (pid ${event.pid})`, 'ok');
      break;
    case 'exited':
      append(`game exited with code ${event.code ?? 'unknown'}`, event.code === 0 ? 'ok' : 'err');
      break;
    case 'error':
      stopProgress();
      append(event.message, 'err');
      break;
  }
}

btnLogin.addEventListener('click', async () => {
  btnLogin.disabled = true;
  try {
    setAccount(await window.launcher.login());
    append('signed in', 'ok');
  } catch (err) {
    append(`sign-in failed: ${(err as Error).message}`, 'err');
  } finally {
    btnLogin.disabled = false;
  }
});

btnLogout.addEventListener('click', async () => {
  await window.launcher.logout();
  setAccount(null);
  append('signed out');
});

btnOpenRoot.addEventListener('click', () => void window.launcher.openRoot());

window.launcher.onLaunchEvent(handleLaunchEvent);

/**
 * Startup. Each step is isolated: a failure to restore a session must not stop
 * the workspace list from rendering, and neither failure may reject silently —
 * an unhandled rejection here leaves a blank, uninformative window with no clue
 * in any log the user will think to look at.
 */
void (async () => {
  try {
    // Templates first: the create dialog cannot be opened without them, and
    // they never change for the life of the process.
    templates = await window.launcher.listTemplates();
    await refreshInstances();
  } catch (err) {
    append(`could not load instances: ${(err as Error).message}`, 'err');
  }

  // Paint the known identity first (instant, no network), then confirm it.
  let cached: AccountSummary | null = null;
  try {
    cached = await window.launcher.cachedAccount();
  } catch {
    /* non-fatal: just means no head start */
  }
  setRestoring(cached);

  try {
    const account = await window.launcher.restoreSession();
    setAccount(account);
    if (account) {
      append(`signed in as ${account.name} (session restored)`, 'ok');
    } else if (cached) {
      append('stored session expired — please sign in again', 'err');
    }
  } catch (err) {
    append(`could not restore session: ${(err as Error).message}`, 'err');
    setAccount(null);
  }
})();

// Anything that still escapes ends up visible rather than in a console nobody
// has open.
window.addEventListener('unhandledrejection', (event) => {
  append(`unhandled: ${String(event.reason)}`, 'err');
});
