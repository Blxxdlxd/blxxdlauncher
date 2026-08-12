/**
 * Client for the friends/presence directory, run from the launcher.
 *
 * The Java client core speaks this same protocol in game. Having the launcher
 * speak it too is what makes the friends list useful *before* you launch —
 * seeing who is online is most of the reason to open a launcher at all, and
 * that information is worthless if it only appears once you are already in a
 * world.
 *
 * <h2>Authentication</h2>
 * Identity is proved through Mojang, not through any credential this service
 * holds:
 *
 *   1. We send `hello` with a username.
 *   2. The server replies with a random `serverId`.
 *   3. We call Mojang's `joinServer` with our session token and that id.
 *   4. We send `prove`; the server asks Mojang `hasJoined` and gets our UUID.
 *
 * The directory therefore never sees a token, and cannot be impersonated by
 * anyone who has not signed in to Minecraft as that account.
 *
 * <h2>Why the `ws` package</h2>
 * Electron 33 bundles Node 20, which has no global `WebSocket` — that landed
 * unflagged in Node 22. The system Node on a developer's machine may well have
 * it, which makes this an easy thing to test in the wrong runtime and believe
 * works. `ws` is the implementation Node's own global is modelled on.
 *
 * <h2>Lifetime</h2>
 * One connection for the life of the process, reconnecting with backoff. The
 * socket being open *is* the presence signal, so dropping it when a window
 * closes would make the user appear offline to their friends while the launcher
 * is still running.
 */

import WebSocket from 'ws';

import { getAuthorization } from './auth';
import { getSettings } from './settings';
import type { DirectoryState, FriendEntry, PersonRef } from '../shared/types';

const PROTOCOL_VERSION = 2;

/** Mojang's session endpoint. Same one the game itself calls when joining. */
const JOIN_URL = 'https://sessionserver.mojang.com/session/minecraft/join';

/** Backoff bounds. First retry is quick; a dead host is not hammered. */
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

type Listener = (state: DirectoryState) => void;

let socket: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectDelay = RECONNECT_MIN_MS;

/** URL the live socket was opened against, for the same-URL check above. */
let connectedUrl: string | null = null;

/** Set while a connection attempt is deliberate, so a close can decide to retry. */
let wanted = false;

let state: DirectoryState = {
  configured: false,
  status: 'offline',
  username: null,
  friends: [],
  incoming: [],
  outgoing: [],
  blocked: [],
  error: null,
};

const listeners = new Set<Listener>();

export function onDirectoryChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDirectoryState(): DirectoryState {
  return state;
}

function publish(patch: Partial<DirectoryState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (err) {
      console.warn('[directory] listener threw:', (err as Error).message);
    }
  }
}

// ------------------------------------------------------------------ lifecycle

/**
 * Open the connection, or reopen it against a changed URL.
 *
 * Safe to call repeatedly: an existing socket for the same URL is left alone,
 * so a renderer that calls this whenever the friends panel opens does not
 * churn the connection.
 */
export function connectDirectory(): void {
  const url = getSettings().directoryUrl.trim();

  publish({ configured: url.length > 0 });

  if (url.length === 0) {
    disconnectDirectory();
    publish({ status: 'offline', error: null });
    return;
  }

  // Already connected to this exact URL: leave it alone rather than churning
  // the socket every time the panel opens.
  if (socket && socket.readyState <= WebSocket.OPEN && connectedUrl === url) {
    return;
  }

  disconnectDirectory();
  wanted = true;
  open(url);
}

export function disconnectDirectory(): void {
  wanted = false;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    // Handlers off first: close() fires 'close', which would otherwise schedule
    // a reconnect for a connection we are deliberately ending.
    socket.removeAllListeners();
    try {
      socket.close();
    } catch {
      /* already closing */
    }
    socket = null;
  }
}

function open(url: string): void {
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    publish({ status: 'offline', error: `Bad directory URL: ${(err as Error).message}` });
    return;
  }

  socket = ws;
  connectedUrl = url;
  publish({ status: 'connecting', error: null });

  ws.on('open', () => {
    const account = safeAccount();
    if (!account) {
      // Signed out. Not worth retrying in a loop — the panel reconnects once a
      // session exists.
      publish({ status: 'offline', error: 'Sign in to use friends.' });
      disconnectDirectory();
      return;
    }
    send({ op: 'hello', version: PROTOCOL_VERSION, username: account.name });
  });

  ws.on('message', (data: Buffer) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
    } catch {
      return; // Not ours to interpret; ignoring beats killing the socket.
    }
    handle(message);
  });

  ws.on('error', (err: Error) => {
    // 'close' runs next and owns the retry; recording the reason here gives the
    // UI something better than a bare "offline".
    publish({ error: `Could not reach the directory: ${err.message}` });
  });

  ws.on('close', () => {
    socket = null;
    publish({ status: 'offline', username: null });
    if (wanted) scheduleReconnect(url);
  });
}

function scheduleReconnect(url: string): void {
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (wanted) open(url);
  }, reconnectDelay);

  // Exponential, capped. A directory that is down for an hour should not be
  // receiving a connection attempt every two seconds for that hour.
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

// -------------------------------------------------------------------- protocol

function handle(message: Record<string, unknown>): void {
  switch (message['op']) {
    case 'challenge':
      void prove(String(message['serverId'] ?? ''));
      break;

    case 'welcome': {
      reconnectDelay = RECONNECT_MIN_MS; // a real session resets the backoff
      publish({
        status: 'online',
        username: String(message['username'] ?? ''),
        error: null,
      });
      applyRoster(message['roster']);
      break;
    }

    case 'roster':
      applyRoster(message['roster']);
      break;

    case 'presence': {
      const friend = message['friend'] as FriendEntry | undefined;
      if (!friend?.uuid) break;
      // Patched in place rather than triggering a roster fetch: presence is by
      // far the most frequent message and the rest of the picture is unchanged.
      publish({
        friends: state.friends.map((existing) =>
          existing.uuid === friend.uuid ? { ...existing, ...friend } : existing,
        ),
      });
      break;
    }

    case 'request': {
      const from = message['from'] as PersonRef | undefined;
      if (!from?.uuid) break;
      if (state.incoming.some((person) => person.uuid === from.uuid)) break;
      publish({ incoming: [...state.incoming, from] });
      break;
    }

    case 'error':
      publish({ error: String(message['message'] ?? 'Directory error') });
      break;

    default:
      // `invited` and anything newer belong to the in-game client, which is
      // where a join can actually happen. Ignored rather than warned about.
      break;
  }
}

function applyRoster(raw: unknown): void {
  const roster = (raw ?? {}) as {
    friends?: FriendEntry[];
    incoming?: PersonRef[];
    outgoing?: PersonRef[];
    blocked?: PersonRef[];
  };

  publish({
    friends: roster.friends ?? [],
    incoming: roster.incoming ?? [],
    outgoing: roster.outgoing ?? [],
    blocked: roster.blocked ?? [],
  });
}

/**
 * Complete the handshake by asking Mojang to vouch for us.
 *
 * The directory learns our UUID from Mojang's `hasJoined`, never from anything
 * we assert — which is why this is the whole of the authentication.
 */
async function prove(serverId: string): Promise<void> {
  const account = safeAccount();
  if (!account || serverId.length === 0) {
    publish({ error: 'Cannot authenticate: no active session.' });
    return;
  }

  try {
    const response = await fetch(JOIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accessToken: account.accessToken,
        // Mojang wants the id without dashes here, unlike everywhere else.
        selectedProfile: account.uuid.replace(/-/g, ''),
        serverId,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    // 204 No Content is success. Anything else means Mojang will not vouch.
    if (!response.ok) {
      publish({ error: `Mojang refused the session (${response.status}).` });
      return;
    }
    send({ op: 'prove' });
  } catch (err) {
    publish({ error: `Could not reach Mojang: ${(err as Error).message}` });
  }
}

function send(message: Record<string, unknown>): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

/** @returns the signed-in account, or null when signed out or mid-refresh */
function safeAccount(): { name: string; uuid: string; accessToken: string } | null {
  try {
    const auth = getAuthorization();
    if (!auth.access_token || !auth.uuid) return null;
    return { name: auth.name ?? 'Player', uuid: auth.uuid, accessToken: auth.access_token };
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------- actions

/**
 * Every action is fire-and-forget: the server answers by pushing a new roster,
 * which is the single source of truth. Optimistically editing local state would
 * mean two implementations of the same rules, and they would disagree the first
 * time an action was refused.
 */
export function directoryAction(op: string, value: string): void {
  switch (op) {
    case 'add':
      send({ op: 'friend.add', username: value });
      break;
    case 'accept':
      send({ op: 'friend.accept', uuid: value });
      break;
    case 'decline':
      send({ op: 'friend.decline', uuid: value });
      break;
    case 'cancel':
      send({ op: 'friend.cancel', uuid: value });
      break;
    case 'remove':
      send({ op: 'friend.remove', uuid: value });
      break;
    case 'block':
      send({ op: 'block', uuid: value });
      break;
    case 'unblock':
      send({ op: 'unblock', uuid: value });
      break;
    default:
      console.warn('[directory] unknown action', op);
  }
}
