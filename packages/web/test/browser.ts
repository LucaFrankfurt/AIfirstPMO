/**
 * The browser, in as few lines as the client actually needs.
 *
 * The point of these tests is to run the *real* store, outbox and sync engine —
 * not a rewritten copy of them — against the *real* server. That means giving
 * Node the handful of globals those modules reach for: somewhere to keep the
 * client id, a network that can be switched off, and an IndexedDB that survives
 * a simulated restart.
 *
 * Everything here is deliberately dumb. A fake with behaviour of its own is a
 * second implementation to get wrong.
 */

/* ------------------------------------------------------------ localStorage */

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.has(key) ? this.map.get(key)! : null; }
  setItem(key: string, value: string): void { this.map.set(key, String(value)); }
  removeItem(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
  get length(): number { return this.map.size; }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
}

/* --------------------------------------------------------------- IndexedDB */

/**
 * Enough of IndexedDB for `lib/idb.ts`: object stores keyed by one property,
 * transactions that complete on the next tick, and requests that call back.
 *
 * The data lives in a module-level map so that "reload the app" can be
 * expressed as dropping the connection and opening it again.
 */
const DATA = new Map<string, Map<string, Map<string, any>>>();

const later = (fn: () => void): void => { queueMicrotask(fn); };

class FakeRequest<T> {
  result!: T;
  error: unknown = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
}

class FakeObjectStore {
  private rows: Map<string, any>;
  private keyPath: string;
  private tx: FakeTransaction;

  constructor(rows: Map<string, any>, keyPath: string, tx: FakeTransaction) {
    this.rows = rows;
    this.keyPath = keyPath;
    this.tx = tx;
  }

  put(value: any): FakeRequest<void> {
    this.rows.set(String(value[this.keyPath]), structuredClone(value));
    return this.tx.request();
  }

  get(key: string): FakeRequest<any> {
    const request = this.tx.request();
    request.result = this.rows.has(key) ? structuredClone(this.rows.get(key)) : undefined;
    return request;
  }

  getAll(): FakeRequest<any[]> {
    const request = this.tx.request<any[]>();
    request.result = [...this.rows.values()].map((row) => structuredClone(row));
    return request;
  }

  delete(key: string): FakeRequest<void> {
    this.rows.delete(key);
    return this.tx.request();
  }

  clear(): FakeRequest<void> {
    this.rows.clear();
    return this.tx.request();
  }
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: unknown = null;
  private pending: FakeRequest<any>[] = [];
  private settled = false;
  private db: FakeDatabase;

  constructor(db: FakeDatabase) {
    this.db = db;
    // Complete once the microtask queue drains, which is when the calls made
    // inside the caller's synchronous block have all been recorded.
    later(() => {
      this.settled = true;
      for (const request of this.pending) request.onsuccess?.();
      this.oncomplete?.();
    });
  }

  request<T = void>(): FakeRequest<T> {
    const request = new FakeRequest<T>();
    if (this.settled) later(() => request.onsuccess?.());
    else this.pending.push(request);
    return request;
  }

  objectStore(name: string): FakeObjectStore {
    const store = this.db.storeFor(name);
    if (!store) throw new Error(`No object store named ${name}`);
    return new FakeObjectStore(store, name === 'meta' ? 'key' : 'id', this);
  }
}

class FakeDatabase {
  objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };

  private stores: Map<string, Map<string, any>>;

  constructor(stores: Map<string, Map<string, any>>) {
    this.stores = stores;
  }

  storeFor(name: string): Map<string, any> | undefined { return this.stores.get(name); }

  createObjectStore(name: string, _options: { keyPath: string }): void {
    if (!this.stores.has(name)) this.stores.set(name, new Map());
  }

  transaction(_names: string | string[], _mode?: string): FakeTransaction {
    return new FakeTransaction(this);
  }

  close(): void { /* nothing to release */ }
}

const indexedDB = {
  open(name: string, _version: number): FakeRequest<FakeDatabase> {
    const stores = DATA.get(name) ?? new Map<string, Map<string, any>>();
    DATA.set(name, stores);
    const fresh = stores.size === 0;
    const request = new FakeRequest<FakeDatabase>();
    request.result = new FakeDatabase(stores);
    later(() => {
      // A database with no stores is one that has never been opened, which is
      // exactly when a browser runs the upgrade.
      if (fresh) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  },
};

/** Forget every connection but keep the data — a page reload, in other words. */
export const reloadPage = (): void => { /* connections hold no state of their own */ };

/** Throw the data away — a different device, or a cleared browser. */
export const wipeStorage = (): void => { DATA.clear(); };

/* ---------------------------------------------------------------- the rest */

class FakeEventTarget {
  private handlers = new Map<string, Set<(event: any) => void>>();
  addEventListener(type: string, handler: (event: any) => void): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
  }
  removeEventListener(type: string, handler: (event: any) => void): void {
    this.handlers.get(type)?.delete(handler);
  }
  dispatchEvent(event: { type: string }): boolean {
    for (const handler of this.handlers.get(event.type) ?? []) handler(event);
    return true;
  }
}

/**
 * The change stream, stubbed out. It only ever triggers a pull, and every test
 * here pulls when it wants to — a real EventSource would make the tests wait on
 * a server push to decide they were done.
 */
class FakeEventSource extends FakeEventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = FakeEventSource.CONNECTING;
  url: string;
  constructor(url: string) {
    super();
    this.url = url;
  }
  close(): void { this.readyState = FakeEventSource.CLOSED; }
}

/** Where the client thinks it is, and whether the network answers. */
export const net = { base: '', online: true, cookie: '' };

/**
 * The network as Node sees it, kept before the shim replaces the global. The
 * tests use it to act as a *second device* — one that is still online while
 * this client is not.
 */
export const directFetch = globalThis.fetch.bind(globalThis);
const realFetch = directFetch;

async function fetchFromClient(input: any, init: RequestInit = {}): Promise<Response> {
  if (!net.online) throw new TypeError('Failed to fetch');
  const path = String(input);
  const url = path.startsWith('/') ? `${net.base}${path}` : path;
  const headers = { ...(init.headers as Record<string, string> | undefined) };
  // Node's fetch has no cookie jar; the session cookie is carried by hand.
  if (net.cookie) headers.cookie = net.cookie;
  const response = await realFetch(url, { ...init, headers });
  const set = response.headers.get('set-cookie');
  if (set) net.cookie = set.split(';')[0];
  return response;
}

/** Install everything. Call once, before importing anything from `src/lib`. */
export function installBrowser(): void {
  const define = (name: string, value: unknown): void => {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  };

  const win = new FakeEventTarget() as any;
  win.location = { pathname: '/', search: '', href: 'http://localhost/' };
  win.history = { replaceState: () => undefined };

  define('localStorage', new MemoryStorage());
  define('sessionStorage', new MemoryStorage());
  define('indexedDB', indexedDB);
  define('EventSource', FakeEventSource);
  define('window', win);
  define('document', {
    visibilityState: 'visible',
    addEventListener: () => undefined,
    documentElement: { lang: 'en', dir: 'ltr' },
  });
  define('navigator', {
    get onLine() { return net.online; },
    language: 'en-GB',
    languages: ['en-GB'],
    storage: undefined,
    userAgent: 'kolibri-test',
  });
  define('fetch', fetchFromClient);
  unrefTimers();
  define('CustomEvent', class {
    type: string;
    detail: unknown;
    constructor(type: string, init: { detail?: unknown } = {}) { this.type = type; this.detail = init.detail; }
  });
}

/**
 * The client polls every minute and retries on a timer. Under a test runner a
 * timer nobody cancels keeps the process alive long after the last assertion,
 * so everything the client schedules is unreferenced: it still fires, it just
 * does not hold the door open. The tests' own waiting uses `realTimeout`.
 */
const realTimeout = globalThis.setTimeout;

function unrefTimers(): void {
  const realInterval = globalThis.setInterval;
  const wrap = (real: (...args: any[]) => any) => (...args: any[]) => {
    const timer = real(...args);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  };
  Object.defineProperty(globalThis, 'setInterval', { value: wrap(realInterval), writable: true, configurable: true });
  Object.defineProperty(globalThis, 'setTimeout', { value: wrap(realTimeout), writable: true, configurable: true });
}

/** Let every queued microtask and timer settle — the client is full of both. */
export const settle = (ms = 0): Promise<void> => new Promise((resolve) => realTimeout(resolve, ms));
