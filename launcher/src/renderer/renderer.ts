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
type JavaInstallation = import('../shared/types').JavaInstallation;
type LoaderKind = import('../shared/types').LoaderKind;
type LoaderBuild = import('../shared/types').LoaderBuild;
type ModSearchResult = import('../shared/types').ModSearchResult;
type InstalledMod = import('../shared/types').InstalledMod;
type ModHealth = import('../shared/types').ModHealth;
type ModSource = import('../shared/types').ModSource;
type LauncherBridge = import('../shared/types').LauncherBridge;
type LaunchEvent = import('../shared/types').LaunchEvent;
type LauncherSettings = import('../shared/types').LauncherSettings;
type DirectoryState = import('../shared/types').DirectoryState;
type PersonRef = import('../shared/types').PersonRef;

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
const accountLabel = el<HTMLSpanElement>('account-label');
const accountAvatar = el<HTMLSpanElement>('account-avatar');
const btnAccount = el<HTMLButtonElement>('btn-account');
const btnLogin = el<HTMLButtonElement>('btn-login');
const btnLogout = el<HTMLButtonElement>('btn-logout');
const accountsDialog = el<HTMLDialogElement>('accounts-dialog');
const accountsList = el<HTMLUListElement>('accounts-list');
const accountsError = el<HTMLParagraphElement>('accounts-error');
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
const runtimeBlock = el<HTMLDivElement>('runtime-block');
const fieldMc = el<HTMLSelectElement>('field-mc');
const fieldSnapshots = el<HTMLInputElement>('field-snapshots');
const fieldBuild = el<HTMLSelectElement>('field-build');
const fieldName = el<HTMLInputElement>('field-name');
const fieldIcon = el<HTMLInputElement>('field-icon');
const blockPicker = el<HTMLDivElement>('block-picker');
const artworkBlock = el<HTMLDivElement>('artwork-block');
const artworkPreview = el<HTMLSpanElement>('artwork-preview');
const fieldMemMax = el<HTMLInputElement>('field-mem-max');
const fieldMemMin = el<HTMLInputElement>('field-mem-min');
const fieldJava = el<HTMLSelectElement>('field-java');
const fieldJvm = el<HTMLTextAreaElement>('field-jvm');
const javaHint = el<HTMLParagraphElement>('java-hint');

const confirmDialog = el<HTMLDialogElement>('confirm-dialog');
const confirmBody = el<HTMLParagraphElement>('confirm-body');
const confirmDeleteFiles = el<HTMLInputElement>('confirm-delete-files');
const confirmOk = el<HTMLButtonElement>('confirm-ok');
const confirmCancel = el<HTMLButtonElement>('confirm-cancel');
const heroArt = el<HTMLDivElement>('hero-art');
const heroName = el<HTMLHeadingElement>('hero-name');
const heroBadges = el<HTMLDivElement>('hero-badges');
const heroMeta = el<HTMLParagraphElement>('hero-meta');
const heroDetails = el<HTMLDListElement>('hero-details');
const heroActions = el<HTMLDivElement>('hero-actions');

const settingsDialog = el<HTMLDialogElement>('settings-dialog');
const fieldDirectory = el<HTMLInputElement>('field-directory');
const fieldCfKey = el<HTMLInputElement>('field-cfkey');
const cfKeyHint = el<HTMLParagraphElement>('cfkey-hint');

const fieldTheme = el<HTMLSelectElement>('field-theme');
const fieldStyle = el<HTMLSelectElement>('field-style');
const fieldLayout = el<HTMLSelectElement>('field-layout');

const friendsDialog = el<HTMLDialogElement>('friends-dialog');
const friendsStatus = el<HTMLSpanElement>('friends-status');
const friendsList = el<HTMLUListElement>('friends-list');
const friendsError = el<HTMLParagraphElement>('friends-error');
const friendsAdd = el<HTMLDivElement>('friends-add');
const friendsName = el<HTMLInputElement>('friends-name');

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

/**
 * Skin data URIs already fetched this session, keyed by UUID.
 *
 * `null` is cached too, and deliberately: an account with a default skin, or
 * one whose lookup failed, must not re-request on every render of the switcher.
 * Main keeps its own on-disk cache; this one only avoids the IPC round trip.
 */
const skins = new Map<string, string | null>();

/**
 * Draw a player's head into `node`.
 *
 * The main process hands over the whole skin PNG and the crop happens here: a
 * head is the 8x8 region at (8,8), with the hat layer at (40,8) drawn over it.
 * Two background layers on one element do that with no image processing, and
 * the first layer listed is the one on top.
 *
 * `background-size: <w>px auto` keeps this working for legacy 64x32 skins as
 * well — the offsets are absolute from the top-left either way.
 */
function paintAvatar(node: HTMLElement, skin: string | null, name: string, size: number): void {
  if (!skin) {
    node.style.backgroundImage = '';
    node.textContent = (name.trim()[0] ?? '?').toUpperCase();
    return;
  }

  const scale = size / 8;
  node.textContent = '';
  node.style.backgroundImage = `url("${skin}"), url("${skin}")`;
  node.style.backgroundSize = `${64 * scale}px auto, ${64 * scale}px auto`;
  node.style.backgroundPosition =
    `${-40 * scale}px ${-8 * scale}px, ${-8 * scale}px ${-8 * scale}px`;
}

/** Fetch a head if we have not already, then paint it. Never throws. */
async function showAvatar(node: HTMLElement, account: AccountSummary, size: number): Promise<void> {
  paintAvatar(node, skins.get(account.uuid) ?? null, account.name, size);
  if (skins.has(account.uuid)) return;

  try {
    const skin = await window.launcher.accountSkin(account.uuid);
    skins.set(account.uuid, skin);
    // The node may have been re-rendered or repurposed while the request was in
    // flight; only paint if it is still showing this account.
    if (node.dataset['uuid'] === account.uuid) paintAvatar(node, skin, account.name, size);
  } catch {
    skins.set(account.uuid, null);
  }
}

function setAccount(account: AccountSummary | null): void {
  signedIn = account !== null;
  btnLogin.hidden = signedIn;
  btnAccount.hidden = !signedIn;
  accountLabel.hidden = signedIn;

  if (account) {
    accountName.textContent = account.name;
    accountAvatar.dataset['uuid'] = account.uuid;
    void showAvatar(accountAvatar, account, 28);
  } else {
    accountLabel.textContent = 'Not signed in';
    delete accountAvatar.dataset['uuid'];
  }

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
  accountLabel.textContent = cached ? `${cached.name} — restoring session…` : 'Restoring session…';
  accountLabel.hidden = false;
  btnLogin.hidden = true;
  btnAccount.hidden = true;
  refreshLaunchButtons();
}

/** Instance state, kept so a re-render needs no extra IPC round trip. */
let instances: InstanceSummary[] = [];
let templates: InstanceTemplate[] = [];

/**
 * The instance the library layout is showing.
 *
 * Kept even while another layout is active, so switching to Library does not
 * land on nothing, and switching away and back returns to where you were.
 */
let selectedId: string | null = null;

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

/** "…/jdk-21.0.11/bin/javaw.exe" -> "jdk-21.0.11". The rest is noise here. */
function javaLabel(summary: InstanceSummary): string {
  const { instance } = summary;
  if (!summary.javaReady || summary.javaPath === null) {
    return `not found — needs Java ${instance.runtime.javaMajor}`;
  }
  const parts = summary.javaPath.split(/[\/]/).filter((p) => p.length > 0);
  // Drop the trailing "bin/javaw.exe" to leave the JDK's own directory name.
  const home = parts.length >= 3 ? parts[parts.length - 3] : parts[parts.length - 1];
  return instance.javaPathOverride === null ? `${home} (automatic)` : `${home} (pinned)`;
}

/** Last path segment, for showing a jar without its directory. */
function basename(p: string): string {
  const parts = p.split(/[\/]/);
  return parts[parts.length - 1] ?? p;
}

function formatDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** One `dt`/`dd` pair. Returns the `dd` so async values can fill it in later. */
function detail(list: HTMLDListElement, term: string, value: string): HTMLElement {
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.textContent = value;
  list.append(dt, dd);
  return dd;
}

/* ------------------------------------------------------------ block icons */

/*
 * Isometric block icons, drawn here rather than shipped as image files.
 *
 * These are original drawings in the block idiom, not Minecraft's own icon
 * assets — those belong to Mojang and are not ours to bundle into a build that
 * gets handed to other people.
 *
 * Generating them costs nothing at runtime and gains two things over a sprite
 * sheet: they are resolution-independent, so the 40px card tile and the 200px
 * hero panel are both crisp, and a new block is one row in the table below.
 */

/** Which face a pattern is being asked about. */
type FaceKind = 'top' | 'left' | 'right';

/**
 * Per-cell detail on top of the base colour and noise.
 *
 * Returns a brightness multiplier, an outright colour, or null to leave the
 * cell alone. Multipliers do most of the work: mortar, plank seams and gem
 * facets are all just "lighter here, darker there", and staying multiplicative
 * means the pattern survives whatever base colour the block declares.
 */
type BlockPattern = (face: FaceKind, i: number, j: number) => number | string | null;

interface BlockDef {
  readonly id: string;
  readonly label: string;
  /** Base colour of the side faces. */
  readonly side: string;
  /** Top face, when it differs — grass being the obvious case. */
  readonly top?: string;
  /** 0 = flat, 1 = heavily speckled. Cobblestone is rough, gold is smooth. */
  readonly noise?: number;
  /**
   * Spill the top colour over the first rows of the side faces, with a ragged
   * lower edge. Grass needs it: the green overhangs the dirt rather than
   * meeting it at a clean seam, and without it the cube reads as two materials
   * stacked instead of one block.
   */
  readonly fringe?: boolean;
  readonly pattern?: BlockPattern;
  /**
   * Cells across one face, when the default does not divide the way a pattern
   * needs. A 3x3 grid with its own gridlines needs 7 (four lines, three cells);
   * on 8 the lines cannot reach both edges and the grid comes out lopsided.
   */
  readonly steps?: number;
}

/** Cells across one face, unless a block asks for its own. */
const STEPS = 8;

/**
 * A bevelled metal plate: darker outer edge, bright highlight just inside it.
 *
 * Iron and gold blocks are near-flat surfaces in game, so they should not carry
 * gem marks at all — the frame is what separates them from a plain cube.
 */
const plate =
  (bright: number, dim: number): BlockPattern =>
  (_face, i, j) => {
    const last = STEPS - 1;
    if (i === 0 || j === 0 || i === last || j === last) return dim;
    if (i === 1 || j === 1 || i === last - 1 || j === last - 1) return bright;
    return null;
  };

/**
 * A hand-drawn texture: one string per row, one character per cell.
 *
 * Some textures cannot be expressed as arithmetic. Cobblestone is irregular
 * stones with cracks between them, and any modulo that produces "a crack every
 * n cells" produces a zigzag lattice instead. Drawing the cells out is both
 * shorter and the only way to get shapes that are genuinely uneven.
 */
const fromGrid =
  (rows: readonly string[], legend: Readonly<Record<string, number>>): BlockPattern =>
  (_face, i, j) => {
    const row = rows[j % rows.length];
    if (row === undefined) return null;
    const cell = row[i % row.length];
    return cell === undefined ? null : legend[cell] ?? null;
  };

const BLOCKS: readonly BlockDef[] = [
  { id: 'grass', label: 'Grass', side: '#8a6440', top: '#6aa84f', fringe: true, noise: 0.5 },
  { id: 'dirt', label: 'Dirt', side: '#8a6440', noise: 0.55 },
  { id: 'stone', label: 'Stone', side: '#7d7d7d', noise: 0.3 },
  {
    id: 'cobblestone',
    label: 'Cobblestone',
    side: '#7a7a7a',
    // Enough for each chunk to vary internally, not enough to blur the chunks.
    noise: 0.26,
    /*
     * Stone, broken up.
     *
     * The previous version drew cracks between the stones, which at this size
     * turned into a woven lattice — the cracks were as prominent as the stone.
     * This is the same grey in irregular patches of two and three cells with no
     * seams at all, which is what actually reads as cobble on a 40px tile.
     */
    pattern: fromGrid(
      [
        'LLmmmddd',
        'LLmmdddd',
        'ddLLmmLL',
        'ddLLmmLL',
        'dmmLLLmm',
        'mmmLLdmm',
        'LLmmddmm',
        'LLmmdddd',
      ],
      { L: 1.22, m: 1.0, d: 0.79 },
    ),
  },
  {
    id: 'planks',
    label: 'Oak planks',
    side: '#b1854c',
    noise: 0.22,
    pattern: (_f, _i, j) => (j % 3 === 2 ? 0.7 : null),
  },
  {
    id: 'crafting-table',
    label: 'Crafting table',
    side: '#9c6b3c',
    top: '#a9743f',
    noise: 0.25,
    // 7 cells: gridlines at 0, 2, 4, 6 and the three slots at 1, 3, 5. On the
    // default 8 the lines could not reach both edges, which is what made the
    // worktop look off-centre.
    steps: 7,
    pattern: (face, i, j) => {
      if (face === 'top') return i % 2 === 0 || j % 2 === 0 ? 0.66 : 1.1;
      // Sides: tool panel below a lighter lip.
      if (j < 2) return 1.12;
      return j >= 3 && j <= 5 && i >= 1 && i <= 5 ? 0.72 : null;
    },
  },
  {
    id: 'furnace',
    label: 'Furnace',
    side: '#6d6d6d',
    noise: 0.28,
    pattern: (face, i, j) => {
      // A lid seam, so the top is not a blank plate.
      if (face === 'top') return j === 1 || j === 6 ? 0.88 : null;
      // Only the left face gets the opening: a furnace has one front in game,
      // and putting the mouth on both visible sides would read as two furnaces.
      if (face !== 'left') return null;
      if (j <= 1) return 1.14; // stone lip above the opening
      const inMouth = i >= 2 && i <= 5 && j >= 3 && j <= 6;
      if (!inMouth) return null;
      // Lit grate along the bottom of the mouth; bars alternate.
      if (j === 6) return i % 2 === 0 ? '#f0902c' : '#7c3a12';
      // Top row of the mouth is the lintel catching a little light.
      return j === 3 ? '#3d3d3d' : '#1d1d1d';
    },
  },
  {
    id: 'bricks',
    label: 'Bricks',
    side: '#96594a',
    noise: 0.25,
    pattern: (_f, i, j) => {
      // Courses two cells tall, with the vertical joints offset each course.
      if (j % 4 === 3) return 1.45;
      return i % 4 === (Math.floor(j / 4) % 2 === 0 ? 3 : 1) ? 1.45 : null;
    },
  },
  { id: 'sand', label: 'Sand', side: '#dbd2a2', noise: 0.24 },
  { id: 'netherrack', label: 'Netherrack', side: '#7a3b3b', noise: 0.8 },
  { id: 'end-stone', label: 'End stone', side: '#dcdfa6', noise: 0.42 },
  {
    id: 'obsidian',
    label: 'Obsidian',
    // Much darker, and the flecks are barely lighter than the base. The bright
    // violet this had before read as amethyst or crying obsidian — obsidian is
    // near-black glass with a faint sheen, and the sheen has to stay faint.
    side: '#17131f',
    noise: 0.3,
    pattern: (_f, i, j) => ((i * 3 + j * 5) % 11 === 0 ? '#2b2440' : null),
  },
  {
    id: 'bedrock',
    label: 'Bedrock',
    side: '#606060',
    /*
     * Speckle was right; it just had nowhere near enough range.
     *
     * The drawn version came out striped, because runs of two and three cells
     * on a grid this small line up into bands however they are arranged. Noise
     * above 1 widens the swing past what any other block uses, which is what
     * gives bedrock its blown-out light and near-black cells.
     */
    noise: 1.85,
  },
  { id: 'diamond', label: 'Diamond block', side: '#4aedd9', noise: 0.2, pattern: plate(1.16, 0.84) },
  { id: 'emerald', label: 'Emerald block', side: '#41d97e', noise: 0.2, pattern: plate(1.16, 0.84) },
  { id: 'gold', label: 'Gold block', side: '#f4cf3e', noise: 0.12, pattern: plate(1.1, 0.86) },
  { id: 'iron', label: 'Iron block', side: '#d6d6d6', noise: 0.12, pattern: plate(1.08, 0.88) },
  { id: 'lapis', label: 'Lapis block', side: '#2a48a8', noise: 0.35, pattern: plate(1.28, 0.8) },
  { id: 'redstone', label: 'Redstone block', side: '#a91e1e', noise: 0.35, pattern: plate(1.26, 0.8) },
  {
    id: 'glowstone',
    label: 'Glowstone',
    // Darker amber than before, so the lit cells have somewhere to be brighter
    // *than*. On the old base the highlights clipped to near-white and the
    // block lost its colour.
    side: '#c28f33',
    noise: 0.3,
    /*
     * Glowstone is lit specks embedded in amber, in ones and twos at no
     * particular spacing. The plate frame it borrowed from the metal blocks was
     * exactly wrong for it — a frame implies a manufactured surface, and this
     * is the one block in the set that should look like it emits light rather
     * than reflects it.
     */
    pattern: fromGrid(
      [
        'mBmmdmmB',
        'BBmdmmBm',
        'mmmmBmmd',
        'dmBBmmdm',
        'mmBmmBBm',
        'BmmdmBmm',
        'mmBmmmmd',
        'mBBmdmBm',
      ],
      { B: 1.5, m: 1.0, d: 0.76 },
    ),
  },
];

/** Deterministic PRNG, so a block looks identical every time it is drawn. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

/** Multiply a hex colour's channels, clamping at 255. */
function shade(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16);
  const channel = (shift: number): string =>
    Math.min(255, Math.round(((n >> shift) & 0xff) * factor))
      .toString(16)
      .padStart(2, '0');
  return '#' + channel(16) + channel(8) + channel(0);
}

interface Face {
  readonly o: readonly [number, number];
  readonly u: readonly [number, number];
  readonly v: readonly [number, number];
  readonly light: number;
  readonly colour: string;
  /** Which face this is, for patterns that treat one differently. */
  readonly kind: FaceKind;
}

/**
 * One isometric cube as an SVG data URI.
 *
 * Each of the three faces is a parallelogram split into a 4x4 grid of cells,
 * every cell shaded a little differently from a seeded random — which is what
 * reads as a pixel texture rather than three flat panels. Face brightness does
 * the rest: the top catches the light, the right face is in shadow.
 */
/** Generated icons, by block id. Each is a few kilobytes and never changes. */
const blockCache = new Map<string, string | null>();

/**
 * One isometric cube as an SVG data URI.
 *
 * Each of the three faces is a parallelogram split into an 8x8 grid of cells,
 * every cell shaded a little differently from a seeded random — which is what
 * reads as a pixel texture rather than three flat panels. Face brightness does
 * the rest: the top catches the light, the right face is in shadow.
 *
 * A block's `pattern` then overrides individual cells, which is what separates
 * bricks from planks from a plain cube. Without it every block was a coloured
 * box and only the hue told them apart.
 */
function blockIcon(id: string): string | null {
  const hit = blockCache.get(id);
  if (hit !== undefined) return hit;

  const def = BLOCKS.find((block) => block.id === id);
  if (!def) {
    blockCache.set(id, null);
    return null;
  }

  const cells: string[] = [];
  const jitter = def.noise ?? 0.4;
  const steps = def.steps ?? STEPS;

  // Origin, then the two edge vectors that sweep out each face.
  const faces: readonly Face[] = [
    { o: [0, 8], u: [16, -8], v: [16, 8], light: 1.0, colour: def.top ?? def.side, kind: 'top' },
    { o: [0, 8], u: [16, 8], v: [0, 16], light: 0.78, colour: def.side, kind: 'left' },
    { o: [16, 16], u: [16, -8], v: [0, 16], light: 0.58, colour: def.side, kind: 'right' },
  ];

  /*
   * One random stream for the whole cube, consumed in face order.
   *
   * This is the arrangement the icons had when the grass fringe was picked, and
   * the fringe is a function of where in the stream a face lands — so anything
   * that changes the consumption order changes the edge. Hence the discarded
   * segment below rather than a tidier per-face seed: the tidier version draws
   * a different fringe.
   *
   * Segments come out as top, then left, then right. Both visible side faces
   * use the left segment, because that is the face whose edge was chosen; the
   * right one is simply never drawn.
   */
  const rand = seeded(hashOf(def.id));
  const segment = (): ReadonlyArray<ReadonlyArray<{ roll: number; variation: number }>> => {
    const grid: { roll: number; variation: number }[][] = [];
    for (let x = 0; x < steps; x++) {
      const column: { roll: number; variation: number }[] = [];
      for (let y = 0; y < steps; y++) {
        // Both draws happen every cell, whether or not they are used, so the
        // sequence — and therefore the texture — stays identical between blocks
        // that do and do not have a fringe.
        const roll = rand();
        column.push({ roll, variation: 1 + (rand() - 0.5) * jitter * 0.55 });
      }
      grid.push(column);
    }
    return grid;
  };

  const topTexture = segment();
  const sideTexture = segment();

  for (const face of faces) {
    const isSide = face.kind !== 'top';
    const grid = isSide ? sideTexture : topTexture;

    for (let i = 0; i < steps; i++) {
      for (let j = 0; j < steps; j++) {
        /*
         * No mirroring: both side faces draw the chosen texture the same way
         * round, so the left face is a copy of the right rather than its
         * reflection. Mirroring reads more symmetrically on the cube, but it
         * is not the edge that was picked.
         */
        const tx = i;
        const cell = grid[tx]?.[j];
        const roll = cell?.roll ?? 0;
        const variation = cell?.variation ?? 1;

        /*
         * Grass overhang. The first two rows are always green, so the top edge
         * is unbroken all the way round — a gap there reads as a missing pixel
         * rather than as texture. Row two is where the raggedness lives, and
         * the leading column is forced on so the front corner keeps the deeper
         * overhang instead of being the one place the fringe is thinnest.
         */
        const fringed =
          def.fringe === true && isSide && (j < 2 || (j === 2 && (tx === 0 || roll < 0.45)));

        let base = fringed ? def.top ?? face.colour : face.colour;
        let light = face.light * variation;

        // Pattern is skipped on fringed cells: the grass edge should not also
        // be carrying the dirt's detail.
        if (!fringed) {
          const detail = def.pattern?.(face.kind, tx, j) ?? null;
          if (typeof detail === 'number') light *= detail;
          else if (typeof detail === 'string') base = detail;
        }

        const point = (di: number, dj: number): string => {
          const x = face.o[0] + ((i + di) / steps) * face.u[0] + ((j + dj) / steps) * face.v[0];
          const y = face.o[1] + ((i + di) / steps) * face.u[1] + ((j + dj) / steps) * face.v[1];
          return x.toFixed(2) + ',' + y.toFixed(2);
        };
        const pts = [point(0, 0), point(1, 0), point(1, 1), point(0, 1)].join(' ');
        cells.push('<polygon points="' + pts + '" fill="' + shade(base, light) + '"/>');
      }
    }
  }

  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">' +
    cells.join('') +
    '</svg>';

  // encodeURIComponent, not base64: it keeps the markup readable in devtools,
  // and it escapes the '#' in every fill — unescaped, the first one would be
  // read as the start of a URL fragment and cut the image off.
  const uri = 'data:image/svg+xml,' + encodeURIComponent(svg);
  blockCache.set(id, uri);
  return uri;
}

/** True for an icon value that names a block rather than being a glyph. */
function isBlockIcon(icon: string): boolean {
  return icon.startsWith('block:');
}

/**
 * Draw an instance's icon into a tile: a block picture, or the glyph itself.
 * Artwork, when set, is painted over this by paintArtwork().
 */
function paintIcon(node: HTMLElement, icon: string): void {
  const uri = isBlockIcon(icon) ? blockIcon(icon.slice('block:'.length)) : null;
  if (uri === null) {
    node.style.backgroundImage = '';
    node.textContent = icon;
    node.classList.remove('has-block');
    return;
  }
  node.textContent = '';
  node.style.backgroundImage = 'url("' + uri + '")';
  node.classList.add('has-block');
}

function badge(text: string, kind?: 'muted' | 'warn' | 'error'): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = kind ? `badge ${kind}` : 'badge';
  span.textContent = text;
  return span;
}

/**
 * Artwork already fetched this session, by instance id.
 *
 * `null` is cached as well as images: an instance with no artwork must not
 * re-ask on every re-render, and re-renders happen on every launch event.
 */
const artwork = new Map<string, string | null>();

/**
 * Show `uri` as the tile's picture, or fall back to the icon glyph.
 *
 * `cover` rather than `contain`: these tiles are square and screenshots are
 * not, and letterboxing a 16:9 image inside a 40px square leaves almost no
 * picture. Cropping the edges of a decorative image loses nothing.
 */
function paintArtwork(node: HTMLElement, uri: string | null, glyph: string): void {
  if (uri === null) {
    node.classList.remove('has-art');
    paintIcon(node, glyph);
    return;
  }
  node.textContent = '';
  node.style.backgroundImage = `url("${uri}")`;
  node.classList.remove('has-block');
  node.classList.add('has-art');
}

/** Fetch artwork if not already known, then paint it. Never throws. */
async function showArtwork(node: HTMLElement, id: string, glyph: string): Promise<void> {
  paintArtwork(node, artwork.get(id) ?? null, glyph);
  if (artwork.has(id)) return;

  try {
    const uri = await window.launcher.instanceArtwork(id);
    artwork.set(id, uri);
    // The node may have been replaced by a re-render while this was in flight.
    if (node.dataset['art'] === id) paintArtwork(node, uri, glyph);
  } catch {
    artwork.set(id, null);
  }
}

function renderInstances(): void {
  instanceGrid.replaceChildren();
  el<HTMLSpanElement>('instance-count').textContent =
    instances.length === 0 ? '' : String(instances.length);

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
    li.dataset['instance'] = instance.id;
    // Drives the accent stripe and icon tint, so loader families stay
    // distinguishable without reading the badges.
    li.style.setProperty('--accent', summary.accent);

    const icon = document.createElement('div');
    icon.className = 'instance-icon';
    paintIcon(icon, instance.icon);
    icon.dataset['art'] = instance.id;
    void showArtwork(icon, instance.id, instance.icon);

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

    // The library layout hides the badges to keep rows compact, which left the
    // sidebar showing names alone. This says the same thing in one line.
    const sub = document.createElement('p');
    sub.className = 'instance-sub';
    sub.textContent =
      runtime.loader === 'vanilla'
        ? `${runtime.minecraftVersion} · vanilla`
        : `${runtime.minecraftVersion} · ${runtime.loader}`;

    body.append(title, sub, badges, meta);

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

    if (instance.id === selectedId) li.classList.add('selected');

    // Selecting is harmless in every layout — only Library shows the result —
    // so there is no need to ask which one is active. Clicks on the card's own
    // buttons are ignored; those already do something.
    li.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('button')) return;
      select(instance.id);
    });

    instanceGrid.appendChild(li);
  }

  // Default to the first instance so the hero is never empty on a fresh start,
  // and recover if the selected one has since been deleted.
  if (!instances.some((entry) => entry.instance.id === selectedId)) {
    selectedId = instances[0]?.instance.id ?? null;
    instanceGrid.querySelector('.instance-card')?.classList.add('selected');
  }

  renderHero();
  refreshLaunchButtons();
}

function select(id: string): void {
  if (selectedId === id) return;
  selectedId = id;

  // Toggle the class in place rather than re-rendering: a full render rebuilds
  // every card and would drop the list's scroll position on each click.
  instanceGrid.querySelectorAll<HTMLLIElement>('.instance-card').forEach((node) => {
    node.classList.toggle('selected', node.dataset['instance'] === id);
  });
  renderHero();
}

/**
 * Fill the hero panel from the selected instance.
 *
 * Builds its own buttons rather than moving the card's: the card's are hidden
 * by CSS in this layout, and reparenting them would leave the other layouts
 * with no buttons at all after a switch.
 */
/**
 * Newest request wins.
 *
 * Counting mods is a directory read in the main process, and clicking down a
 * list of instances fires one per click. Without this, a slow early read can
 * land after a fast later one and leave the wrong count on screen.
 */
let modCountToken = 0;

async function fillModCount(instanceId: string, cell: HTMLElement): Promise<void> {
  const token = ++modCountToken;
  try {
    const mods = await window.launcher.listInstalledMods(instanceId);
    if (token !== modCountToken) return;
    const enabled = mods.filter((mod) => mod.enabled).length;
    const disabled = mods.length - enabled;
    cell.textContent =
      mods.length === 0 ? 'none' : disabled === 0 ? `${enabled}` : `${enabled} on · ${disabled} off`;
  } catch {
    if (token === modCountToken) cell.textContent = 'could not read';
  }
}

function renderHero(): void {
  const summary = instances.find((entry) => entry.instance.id === selectedId);

  if (!summary) {
    heroName.textContent = instances.length === 0 ? 'No instances yet' : 'Nothing selected';
    heroArt.textContent = '';
    heroBadges.replaceChildren();
    heroMeta.textContent =
      instances.length === 0
        ? 'Create one with New instance — pick a Minecraft version and a loader, and the launcher installs the rest.'
        : 'Pick an instance on the left.';
    heroActions.replaceChildren();
    heroDetails.replaceChildren();
    return;
  }

  const { instance } = summary;
  const { runtime } = instance;

  heroArt.style.setProperty('--accent', summary.accent);
  paintIcon(heroArt, instance.icon);
  heroArt.dataset['art'] = instance.id;
  void showArtwork(heroArt, instance.id, instance.icon);
  heroName.textContent = instance.name;

  heroBadges.replaceChildren(
    badge(runtime.minecraftVersion),
    runtime.loader === 'vanilla'
      ? badge('vanilla', 'muted')
      : badge(`${runtime.loader} ${shortBuild(runtime.loaderVersion, runtime.minecraftVersion)}`, 'muted'),
    badge(`${instance.memoryMax} heap`, 'muted'),
    summary.clientCoreJar !== null ? badge('client core') : badge('no client core', 'muted'),
  );
  if (!summary.installed) heroBadges.append(badge('not installed', 'warn'));
  if (!summary.javaReady) heroBadges.append(badge(`needs Java ${runtime.javaMajor}`, 'error'));

  heroMeta.textContent = formatPlayed(instance.lastPlayed);

  heroDetails.replaceChildren();
  detail(heroDetails, 'Java', javaLabel(summary));
  detail(heroDetails, 'Heap', `${instance.memoryMin} min · ${instance.memoryMax} max`);
  const modsCell = detail(heroDetails, 'Mods', '…');
  detail(heroDetails, 'On disk', formatSize(summary.sizeBytes));
  detail(
    heroDetails,
    'Client core',
    summary.clientCoreJar === null ? 'none for this version' : basename(summary.clientCoreJar),
  );
  if (instance.extraJvmArgs.length > 0) {
    detail(heroDetails, 'JVM flags', `${instance.extraJvmArgs.length} extra`);
  }
  detail(heroDetails, 'Created', formatDate(instance.createdAt));

  void fillModCount(instance.id, modsCell);

  const play = makeButton('Play', () => void startLaunch(instance.id), 'primary');
  play.dataset['play'] = instance.id;

  heroActions.replaceChildren(
    play,
    makeButton('Mods', () => openMods(summary)),
    makeButton('Edit', () => openEditDialog(summary)),
    makeButton('Folder', () => void window.launcher.openInstanceFolder(instance.id)),
    makeButton('Copy', () => void runAction(() => window.launcher.duplicateInstance(instance.id))),
    makeButton('Delete', () => openDeleteDialog(summary), 'danger'),
  );

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
 * Block chosen in the picker, or null when the icon is a typed glyph.
 *
 * Kept beside the text field rather than inside it: the field would otherwise
 * have to show "block:crafting-table", which is the storage format and not
 * something to put in front of anyone.
 */
let chosenBlock: string | null = null;

/** Build the picker once; selection is a class toggle from then on. */
function buildBlockPicker(): void {
  for (const def of BLOCKS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'block-swatch';
    button.dataset['block'] = def.id;
    button.title = def.label;
    // aria-label, because the button's only content is a background image.
    button.setAttribute('aria-label', def.label);
    button.style.backgroundImage = `url("${blockIcon(def.id) ?? ''}")`;
    button.addEventListener('click', () => selectBlock(def.id));
    blockPicker.appendChild(button);
  }
}

function selectBlock(id: string | null): void {
  chosenBlock = id;
  if (id !== null) fieldIcon.value = '';
  for (const node of Array.from(blockPicker.querySelectorAll<HTMLElement>('.block-swatch'))) {
    node.classList.toggle('selected', node.dataset['block'] === id);
  }
}

/** Which instance the dialog is editing, or null when creating.
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
  // Editing works on the instance's own runtime; the create controls are hidden
  // and hold whatever the last create left behind.
  const activeVersion = editing ? editing.instance.runtime.minecraftVersion : fieldMc.value;
  const activeLoader = editing ? editing.instance.runtime.loader : chosenLoader;

  if (activeLoader === 'vanilla') {
    buildBlock.hidden = true;
    fieldBuild.replaceChildren();
    return;
  }

  buildBlock.hidden = false;
  fieldBuild.replaceChildren();

  const loading = document.createElement('option');
  loading.textContent = 'Loading…';
  fieldBuild.appendChild(loading);

  const version = activeVersion;
  const loader = activeLoader;

  let builds: LoaderBuild[] = [];
  try {
    builds = await window.launcher.listLoaderBuilds(version, loader);
  } catch (err) {
    append(`could not list ${loader} builds: ${(err as Error).message}`, 'err');
  }

  // Discard a response that arrived after the user moved on. Not applicable
  // while editing, where neither control can change under us.
  if (!editing && (fieldMc.value !== version || chosenLoader !== loader)) return;

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

  if (editing) {
    const current = editing.instance.runtime.loaderVersion;

    // A build since pulled from the maven still has to appear, or opening the
    // dialog would silently select a different one and saving would move the
    // instance without being asked.
    if (current && !builds.some((build) => build.version === current)) {
      const missing = document.createElement('option');
      missing.value = current;
      missing.textContent = `${current} (installed)`;
      fieldBuild.insertBefore(missing, fieldBuild.firstChild);
    }
    fieldBuild.value = current;
  }
}

async function openCreateDialog(): Promise<void> {
  editing = null;
  // Nothing to attach artwork to until the instance exists.
  artworkBlock.hidden = true;

  dialogTitle.textContent = 'New instance';
  dialogConfirm.textContent = 'Create';
  templateBlock.hidden = false;
  runtimeBlock.hidden = false;

  fieldName.value = '';
  fieldIcon.value = '';
  selectBlock('grass');
  fieldMemMax.value = '8G';
  fieldMemMin.value = '4G';
  fieldJvm.value = '';
  currentRequiredMajor = null;
  void renderJavaChoices(null, null);
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
  // The Minecraft version and loader are fixed for the life of an instance —
  // changing either invalidates every mod in the folder. The build is not: a
  // newer NeoForge for the same Minecraft version is an ordinary thing to want,
  // and nothing in the instance directory cares.
  templateBlock.hidden = false;
  runtimeBlock.hidden = true;
  void refreshBuilds();

  fieldName.value = summary.instance.name;
  // An existing block icon selects its swatch; anything else is a glyph.
  if (isBlockIcon(summary.instance.icon)) {
    fieldIcon.value = '';
    selectBlock(summary.instance.icon.slice('block:'.length));
  } else {
    fieldIcon.value = summary.instance.icon;
    selectBlock(null);
  }
  fieldMemMax.value = summary.instance.memoryMax;
  fieldMemMin.value = summary.instance.memoryMin;
  fieldJvm.value = summary.instance.extraJvmArgs.join('\n');
  currentRequiredMajor = summary.instance.runtime.javaMajor;
  void renderJavaChoices(summary.instance.javaPathOverride, currentRequiredMajor);
  dialogError.hidden = true;

  artworkBlock.hidden = false;
  artworkPreview.dataset['art'] = summary.instance.id;
  void showArtwork(artworkPreview, summary.instance.id, summary.instance.icon);

  dialog.showModal();
  fieldName.focus();
}

/**
 * Detected JVMs, cached for the session.
 *
 * Building this list spawns `java -version` once per candidate, so it is fetched
 * on first need rather than at startup — and kept, because installing a JDK
 * mid-session is rare enough not to justify paying that cost on every open.
 */
let javaInstalls: JavaInstallation[] = [];

async function renderJavaChoices(selected: string | null, requiredMajor: number | null): Promise<void> {
  if (javaInstalls.length === 0) {
    try {
      javaInstalls = await window.launcher.listJavaInstallations();
    } catch (err) {
      // Not fatal: automatic resolution still works, the user just cannot
      // override it this session.
      append(`Could not list Java installations: ${(err as Error).message}`, 'err');
    }
  }

  fieldJava.replaceChildren();

  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = requiredMajor === null ? 'Automatic' : `Automatic (Java ${requiredMajor} or newer)`;
  fieldJava.append(auto);

  for (const install of javaInstalls) {
    const option = document.createElement('option');
    option.value = install.path;
    const label = install.source === 'configured' ? 'configured' : 'detected';
    option.textContent = `Java ${install.major} — ${install.version} (${label})`;
    option.title = install.path;
    fieldJava.append(option);
  }

  // A previously chosen JVM that has since been uninstalled must still appear,
  // or opening the dialog would silently reset the instance to Automatic and
  // the user would only find out when the game launched on the wrong runtime.
  if (selected && !javaInstalls.some((i) => i.path === selected)) {
    const missing = document.createElement('option');
    missing.value = selected;
    missing.textContent = `${selected} (not found)`;
    fieldJava.append(missing);
  }

  fieldJava.value = selected ?? '';
  updateJavaHint(requiredMajor);
}

function updateJavaHint(requiredMajor: number | null): void {
  const chosen = javaInstalls.find((i) => i.path === fieldJava.value);
  if (fieldJava.value.length === 0) {
    javaHint.textContent =
      "Automatic uses the version's own requirement. Pick a newer one if a mod needs it.";
    javaHint.className = 'hint';
    return;
  }
  if (!chosen) {
    javaHint.textContent = 'That JVM was not found on this machine — the instance will fall back to automatic.';
    javaHint.className = 'hint warn';
    return;
  }
  if (requiredMajor !== null && chosen.major < requiredMajor) {
    javaHint.textContent = `Java ${chosen.major} is older than the ${requiredMajor} this version needs. Launch will refuse it.`;
    javaHint.className = 'hint warn';
    return;
  }
  javaHint.textContent = chosen.path;
  javaHint.className = 'hint';
}

fieldJava.addEventListener('change', () => updateJavaHint(currentRequiredMajor));

/** The Java major the instance in the dialog needs, for the hint above. */
let currentRequiredMajor: number | null = null;

/**
 * Split a blob of JVM flags into arguments.
 *
 * Splits on whitespace that is followed by a dash, rather than on whitespace
 * generally. That is what lets a flag carry a path with a space in it —
 * `-Dfoo=C:\Program Files\x -Dbar=1` is two arguments, not four — while a
 * pasted single line of flags still separates correctly. Newlines are
 * whitespace, so one-per-line works without a special case.
 */
function parseJvmArgs(raw: string): string[] {
  return raw
    .split(/\s+(?=-)/)
    .map((arg) => arg.trim())
    .filter((arg) => arg.length > 0);
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
  const icon = chosenBlock !== null ? `block:${chosenBlock}` : fieldIcon.value.trim();
  const memoryMax = fieldMemMax.value.trim().toUpperCase();
  const memoryMin = fieldMemMin.value.trim().toUpperCase();
  const javaPathOverride = fieldJava.value.length > 0 ? fieldJava.value : null;
  const extraJvmArgs = parseJvmArgs(fieldJvm.value);
  const loaderVersion = buildBlock.hidden ? undefined : fieldBuild.value;
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
          javaPathOverride,
          extraJvmArgs,
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
    window.launcher.updateInstance(target.instance.id, {
      name,
      icon,
      memoryMax,
      memoryMin,
      javaPathOverride,
      extraJvmArgs,
      loaderVersion,
    }),
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
const modsHealth = el<HTMLDivElement>('mods-health');
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

/**
 * Warn about a mods folder that disagrees with itself.
 *
 * Hidden entirely when there is nothing wrong: a banner that is always present
 * stops being read, and this one is worth reading.
 *
 * Failures are swallowed rather than surfaced. This is a diagnostic, and a
 * diagnostic that throws its own error into the mods dialog would be worse than
 * one that quietly does nothing.
 */
async function renderModHealth(instanceId: string): Promise<void> {
  modsHealth.hidden = true;
  modsHealth.replaceChildren();

  let health: ModHealth;
  try {
    health = await window.launcher.checkMods(instanceId);
  } catch {
    return;
  }

  if (health.missingFiles.length === 0 && health.unsatisfied.length === 0) return;

  const heading = document.createElement('h4');
  heading.textContent = 'This instance may not launch cleanly';
  modsHealth.appendChild(heading);

  const list = document.createElement('ul');

  for (const title of health.missingFiles) {
    const li = document.createElement('li');
    li.textContent = `${title} is recorded as installed but its file is gone.`;
    list.appendChild(li);
  }

  for (const { modId, requiredBy } of health.unsatisfied) {
    const li = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = modId;
    li.append(code, ` is required by ${requiredBy} but nothing here provides it.`);
    list.appendChild(li);
  }

  modsHealth.appendChild(list);
  modsHealth.hidden = false;
}

/** The jar the launcher stages itself, named by the core build. */
function isClientCore(fileName: string): boolean {
  return /^blxxdlauncher-core(-dev)?-/.test(fileName);
}

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

  void renderModHealth(id);

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
    // `external` means "no entry in the mods manifest", which covers two very
    // different things: a jar the user dropped in, and the client core, which
    // the launcher stages itself on every launch. Calling the core "not
    // installed by the launcher" was flatly wrong — the launcher is what put it
    // there — so the two cases are now named separately.
    //
    // Worth surfacing either way: removing the core quietly turns the instance
    // into plain Minecraft, and removing a hand-added jar cannot be undone by
    // the launcher because it has no idea where it came from.
    if (mod.external) {
      bits.push(mod.projectId === null && isClientCore(mod.fileName) ? 'client core' : 'added manually');
    }
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
    } else if (modTab === 'curseforge' && !curseforgeReady) {
      // No key is a very different problem from "nothing matched", and without
      // saying so the tab just looks broken.
      setModsStatus('No CurseForge API key — put one in ~/.blxxdlauncher/launcher/curseforge.key');
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


/**
 * Whether a CurseForge key is present, tracked only to explain an empty result
 * list on the CurseForge tab.
 *
 * There is no UI for entering one. The key is a one-time setup step, and a
 * panel that keeps offering it afterwards is noise — so it is configured by
 * dropping the file in place:
 *
 *   ~/.blxxdlauncher/launcher/curseforge.key
 *
 * The renderer never sees the key itself, only whether the file exists. There
 * is no reason for a browser context to hold a credential it cannot use.
 */
let curseforgeReady = false;

async function refreshCurseForgeState(): Promise<void> {
  try {
    curseforgeReady = await window.launcher.curseforgeConfigured();
  } catch {
    curseforgeReady = false;
  }
}

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

/* ----------------------------------------------------------- accounts */

/** Disable every control in the dialog while a switch is in flight. */
function setAccountsBusy(busy: boolean): void {
  // Array.from, not for-of: the tsconfig lib does not include DOM.Iterable.
  for (const node of Array.from(accountsDialog.querySelectorAll('button'))) {
    node.disabled = busy;
  }
  accountsDialog.classList.toggle('busy', busy);
}

function showAccountsError(message: string | null): void {
  accountsError.textContent = message ?? '';
  accountsError.hidden = message === null;
}

async function renderAccounts(): Promise<void> {
  const listing = await window.launcher.listAccounts();
  accountsList.replaceChildren();

  if (listing.accounts.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'mod-empty';
    empty.textContent = 'No accounts yet. Add one to get started.';
    accountsList.appendChild(empty);
  }

  for (const account of listing.accounts) {
    const active = account.uuid === listing.activeUuid;

    const row = document.createElement('li');
    row.className = active ? 'account-row active' : 'account-row';

    const avatar = document.createElement('span');
    avatar.className = 'avatar large';
    avatar.dataset['uuid'] = account.uuid;
    void showAvatar(avatar, account, 40);

    const body = document.createElement('div');
    body.className = 'account-row-body';

    const name = document.createElement('strong');
    name.textContent = account.name;

    const state = document.createElement('span');
    state.className = 'account-row-state';
    state.textContent = active ? 'signed in' : 'stored';

    body.append(name, state);

    const actions = document.createElement('div');
    actions.className = 'account-row-actions';

    if (!active) {
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'primary';
      use.textContent = 'Switch';
      use.addEventListener('click', () => {
        void (async () => {
          setAccountsBusy(true);
          showAccountsError(null);
          state.textContent = 'signing in…';
          try {
            setAccount(await window.launcher.switchAccount(account.uuid));
            append(`switched to ${account.name}`, 'ok');
            await renderAccounts();
          } catch (err) {
            showAccountsError((err as Error).message);
            state.textContent = 'stored';
          } finally {
            setAccountsBusy(false);
          }
        })();
      });
      actions.appendChild(use);
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      void (async () => {
        setAccountsBusy(true);
        showAccountsError(null);
        try {
          await window.launcher.removeAccount(account.uuid);
          // Removing the live account ends the session; the others survive.
          if (active) {
            setAccount(null);
            append(`signed out of ${account.name}`);
          } else {
            append(`removed ${account.name}`);
          }
          await renderAccounts();
        } catch (err) {
          showAccountsError((err as Error).message);
        } finally {
          setAccountsBusy(false);
        }
      })();
    });
    actions.appendChild(remove);

    row.append(avatar, body, actions);
    accountsList.appendChild(row);
  }

  // Nothing to sign out of when no account is live.
  btnLogout.hidden = listing.activeUuid === null;
}

/**
 * Interactive sign-in, shared by the top-bar button and "Add account".
 * `select_account` is set on the Microsoft side, so this always shows the
 * picker rather than silently reusing the last session.
 */
async function doLogin(): Promise<void> {
  setAccount(await window.launcher.login());
  append('signed in', 'ok');
}

btnLogin.addEventListener('click', async () => {
  btnLogin.disabled = true;
  try {
    await doLogin();
  } catch (err) {
    append(`sign-in failed: ${(err as Error).message}`, 'err');
  } finally {
    btnLogin.disabled = false;
  }
});

btnAccount.addEventListener('click', () => {
  void (async () => {
    showAccountsError(null);
    try {
      await renderAccounts();
      accountsDialog.showModal();
    } catch (err) {
      append(`could not list accounts: ${(err as Error).message}`, 'err');
    }
  })();
});

el<HTMLButtonElement>('accounts-add').addEventListener('click', () => {
  void (async () => {
    setAccountsBusy(true);
    showAccountsError(null);
    try {
      await doLogin();
      await renderAccounts();
    } catch (err) {
      showAccountsError((err as Error).message);
    } finally {
      setAccountsBusy(false);
    }
  })();
});

el<HTMLButtonElement>('accounts-close').addEventListener('click', () => accountsDialog.close());

btnLogout.addEventListener('click', () => {
  void (async () => {
    setAccountsBusy(true);
    try {
      await window.launcher.logout();
      setAccount(null);
      append('signed out');
      await renderAccounts();
    } catch (err) {
      showAccountsError((err as Error).message);
    } finally {
      setAccountsBusy(false);
    }
  })();
});

/**
 * Repaint every tile showing this instance.
 *
 * The dialog preview, the card and the hero can all be on screen at once, so
 * changing the picture has to reach all three rather than only the control the
 * user clicked.
 */
function refreshArtwork(id: string, uri: string | null, glyph: string): void {
  artwork.set(id, uri);
  for (const node of Array.from(document.querySelectorAll<HTMLElement>(`[data-art="${id}"]`))) {
    paintArtwork(node, uri, glyph);
  }
}

el<HTMLButtonElement>('artwork-choose').addEventListener('click', () => {
  void (async () => {
    if (!editing) return;
    const { id, icon } = editing.instance;
    try {
      const uri = await window.launcher.chooseInstanceArtwork(id);
      // Null means the picker was dismissed, which is not a failure and should
      // leave the existing artwork alone.
      if (uri !== null) refreshArtwork(id, uri, icon);
    } catch (err) {
      dialogError.textContent = (err as Error).message;
      dialogError.hidden = false;
    }
  })();
});

el<HTMLButtonElement>('artwork-clear').addEventListener('click', () => {
  void (async () => {
    if (!editing) return;
    const { id, icon } = editing.instance;
    try {
      await window.launcher.clearInstanceArtwork(id);
      refreshArtwork(id, null, icon);
    } catch (err) {
      dialogError.textContent = (err as Error).message;
      dialogError.hidden = false;
    }
  })();
});

buildBlockPicker();

fieldIcon.addEventListener('input', () => {
  if (fieldIcon.value.trim().length > 0) selectBlock(null);
});

btnOpenRoot.addEventListener('click', () => void window.launcher.openRoot());

el<HTMLButtonElement>('btn-clear-log').addEventListener('click', () => {
  // replaceChildren, not textContent: the log holds one element per line and
  // the empty-state hint keys off :empty, which text nodes would defeat.
  log.replaceChildren();
});

window.launcher.onLaunchEvent(handleLaunchEvent);

/**
 * Startup. Each step is isolated: a failure to restore a session must not stop
 * the workspace list from rendering, and neither failure may reject silently —
 * an unhandled rejection here leaves a blank, uninformative window with no clue
 * in any log the user will think to look at.
 */
/** Last state pushed by main. Re-rendered whenever the dialog is open. */
let directory: DirectoryState | null = null;

function renderFriends(): void {
  if (!directory) return;

  friendsStatus.textContent = directory.configured ? directory.status : 'no directory set';
  friendsStatus.className = `friends-status ${directory.configured ? directory.status : ''}`;

  friendsError.textContent = directory.error ?? '';
  friendsError.hidden = directory.error === null;

  // Nothing to add anyone to without a directory, so the row would only produce
  // errors.
  friendsAdd.hidden = !directory.configured;

  friendsList.replaceChildren();

  if (!directory.configured) {
    friendsList.appendChild(note('Add a friends directory in Settings to use this.'));
    return;
  }

  // Requests first: they are the only thing here needing an answer, and burying
  // them under a long friends list is how they get missed.
  if (directory.incoming.length > 0) {
    friendsList.appendChild(section('Requests'));
    for (const person of directory.incoming) {
      friendsList.appendChild(
        personRow(person, false, null, [
          ['Accept', 'accept', 'primary'],
          ['Decline', 'decline', undefined],
          ['Block', 'block', 'danger'],
        ]),
      );
    }
  }

  friendsList.appendChild(section('Friends'));

  if (directory.friends.length === 0) {
    friendsList.appendChild(
      note(directory.status === 'online' ? 'No friends yet.' : 'Not connected.'),
    );
  } else {
    // Online first, then alphabetical. The list exists to answer "who can I
    // play with", and that order answers it without needing to be read.
    const sorted = [...directory.friends].sort(
      (a, b) => Number(b.online) - Number(a.online) || a.username.localeCompare(b.username),
    );

    for (const friend of sorted) {
      // Hosting is reported, not offered as a button: joining needs a running
      // game, which the launcher does not have.
      const detail = friend.address ? `hosting - ${friend.address}` : null;
      friendsList.appendChild(
        personRow(friend, friend.online, detail, [
          ['Remove', 'remove', undefined],
          ['Block', 'block', 'danger'],
        ]),
      );
    }
  }

  if (directory.outgoing.length > 0) {
    friendsList.appendChild(section('Sent'));
    for (const person of directory.outgoing) {
      friendsList.appendChild(personRow(person, false, null, [['Cancel', 'cancel', undefined]]));
    }
  }

  if (directory.blocked.length > 0) {
    friendsList.appendChild(section('Blocked'));
    for (const person of directory.blocked) {
      friendsList.appendChild(personRow(person, false, null, [['Unblock', 'unblock', undefined]]));
    }
  }
}

function section(label: string): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'friends-section';
  li.textContent = label;
  return li;
}

function note(text: string): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'mod-empty';
  li.textContent = text;
  return li;
}

function personRow(
  person: PersonRef,
  online: boolean,
  detail: string | null,
  actions: ReadonlyArray<[string, string, 'primary' | 'danger' | undefined]>,
): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'mod-row';

  const left = document.createElement('div');
  left.className = 'friend-row';

  const dot = document.createElement('span');
  dot.className = online ? 'friend-dot online' : 'friend-dot';

  const body = document.createElement('div');
  const name = document.createElement('strong');
  name.textContent = person.username;

  const sub = document.createElement('div');
  sub.className = 'friend-sub';
  sub.textContent = detail ?? (online ? 'online' : 'offline');

  body.append(name, sub);
  left.append(dot, body);

  const buttons = document.createElement('div');
  buttons.className = 'mod-actions';
  for (const [label, op, style] of actions) {
    buttons.appendChild(
      makeButton(label, () => void window.launcher.directoryAction(op, person.uuid), style),
    );
  }

  li.append(left, buttons);
  return li;
}

el<HTMLButtonElement>('btn-friends').addEventListener('click', () => {
  void (async () => {
    try {
      // Asking for the state is also what tells main to connect, so a user with
      // no directory configured never opens a socket at all.
      directory = await window.launcher.getDirectoryState();
      renderFriends();
      friendsDialog.showModal();
    } catch (err) {
      append(`could not open friends: ${(err as Error).message}`, 'err');
    }
  })();
});

el<HTMLButtonElement>('friends-close').addEventListener('click', () => friendsDialog.close());

function submitAdd(): void {
  const name = friendsName.value.trim();
  if (name.length === 0) return;
  void window.launcher.directoryAction('add', name);
  friendsName.value = '';
}

el<HTMLButtonElement>('friends-add-btn').addEventListener('click', submitAdd);
friendsName.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') submitAdd();
});

// Pushed, not polled: presence changes on the server's schedule, not ours.
window.launcher.onDirectory((next) => {
  directory = next;
  if (friendsDialog.open) renderFriends();
});

/**
 * Put the appearance on the document.
 *
 * Attributes on the root element rather than classes on body, so the CSS can
 * key off `:root[data-theme=...]` and win against the default block without
 * needing !important anywhere.
 */
function applyAppearance(settings: LauncherSettings): void {
  const root = document.documentElement;
  root.dataset['theme'] = settings.theme;
  root.dataset['style'] = settings.style;
  root.dataset['layout'] = settings.layout;

  fieldTheme.value = settings.theme;
  fieldStyle.value = settings.style;
  fieldLayout.value = settings.layout;
}

/**
 * Apply immediately, persist in the background.
 *
 * Waiting for the write before repainting would put a disk round trip between
 * the click and the colour change on a control whose entire job is to be
 * instant. A failed write is logged; the appearance still changes, it just
 * will not survive a restart.
 */
function changeAppearance(patch: Partial<LauncherSettings>): void {
  const root = document.documentElement;
  if (patch.theme) root.dataset['theme'] = patch.theme;
  if (patch.style) root.dataset['style'] = patch.style;
  if (patch.layout) root.dataset['layout'] = patch.layout;

  void window.launcher.setSettings(patch).catch((err: Error) => {
    append(`could not save appearance: ${err.message}`, 'err');
  });
}

el<HTMLButtonElement>('btn-settings').addEventListener('click', () => {
  void (async () => {
    try {
      const current = await window.launcher.getSettings();
      fieldDirectory.value = current.directoryUrl;

      // The key itself is never read back out of the main process — only
      // whether one exists. A password field showing a real credential invites
      // it being copied out of a screenshot.
      const configured = await window.launcher.curseforgeConfigured();
      fieldCfKey.value = '';
      cfKeyHint.textContent = configured
        ? 'A key is set. Type a new one to replace it.'
        : 'Needed to browse CurseForge.';

      settingsDialog.showModal();
    } catch (err) {
      append(`could not open settings: ${(err as Error).message}`, 'err');
    }
  })();
});

/** Applied on close rather than per keystroke: these are text fields. */
function commitSettings(): void {
  void (async () => {
    try {
      await window.launcher.setSettings({ directoryUrl: fieldDirectory.value.trim() });

      const key = fieldCfKey.value.trim();
      if (key.length > 0) {
        await window.launcher.setCurseforgeKey(key);
        fieldCfKey.value = '';
      }

      // Re-reading is what makes main reconnect against a changed address.
      directory = await window.launcher.getDirectoryState();
      if (friendsDialog.open) renderFriends();
    } catch (err) {
      append(`could not save settings: ${(err as Error).message}`, 'err');
    }
  })();
}

el<HTMLButtonElement>('settings-close').addEventListener('click', () => {
  commitSettings();
  settingsDialog.close();
});

settingsDialog.addEventListener('close', commitSettings);

fieldTheme.addEventListener('change', () => {
  changeAppearance({ theme: fieldTheme.value as LauncherSettings['theme'] });
});

fieldStyle.addEventListener('change', () => {
  changeAppearance({ style: fieldStyle.value as LauncherSettings['style'] });
});

fieldLayout.addEventListener('change', () => {
  changeAppearance({ layout: fieldLayout.value as LauncherSettings['layout'] });
});

void (async () => {
  try {
    // Appearance first, and awaited: everything after this renders, and doing
    // it later means a visible flash of the default theme on every start.
    applyAppearance(await window.launcher.getSettings());
  } catch (err) {
    append(`could not load appearance: ${(err as Error).message}`, 'err');
  }

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
