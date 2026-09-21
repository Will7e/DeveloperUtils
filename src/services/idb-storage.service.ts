// ============================================================
// IndexedDB Storage Service — Durable KV Store for Heavy Data
// ============================================================
// Promise-based key/value wrapper over a single IndexedDB database.
// Heavy, sizeable state (API tester, chat, app state) lives here to
// escape the ~5MB localStorage quota; tiny boot-critical prefs (theme,
// layout, tokens, OAuth handoff) stay in localStorage.
//
// Failure policy:
//  - If IndexedDB is unavailable (private mode, open failure) callers
//    degrade to localStorage transparently via readValue/writeValue.
//  - Any IDB failure sets a session-sticky "broken" flag so the rest
//    of the session consistently uses localStorage. This avoids
//    split-brain, where newer writes land in one store while reads
//    come from the other.
//
// This module must stay dependency-free (no app imports) to avoid
// circular initialization at boot.

const DB_NAME = "intab_storage";
const STORE_NAME = "kv";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;
let idbBroken = false;

/** True while this session may still attempt IndexedDB operations. */
export function isIdbAvailable(): boolean {
  return typeof indexedDB !== "undefined" && !idbBroken;
}

/** Marks IDB unusable for the rest of the session (sticky downgrade). */
function markIdbBroken(err: unknown): void {
  if (!idbBroken) {
    idbBroken = true;
    console.warn("IndexedDB unavailable — using localStorage fallback for this session:", err);
  }
}

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        // Let schema upgrades proceed in other tabs instead of blocking.
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onblocked = () => reject(new Error("IndexedDB open blocked by another tab"));
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    }).catch((err) => {
      markIdbBroken(err);
      throw err;
    });
  }
  return dbPromise;
}

async function getRaw(key: string): Promise<string | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let result: string | null = null;
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => {
      result = (req.result as string | undefined) ?? null;
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

async function putRaw(key: string, value: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

async function removeRaw(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

/**
 * Atomic check-and-set used for the encryption device salt so that
 * concurrent first-boot tabs converge on a single value: IndexedDB
 * serializes readwrite transactions on the store. If the store is
 * empty, `seed` (the legacy localStorage value) is adopted so data
 * written by pre-IDB builds stays decryptable; otherwise `generate`
 * mints a fresh value.
 */
export async function acquireDeviceSalt(
  key: string,
  seed: string | null,
  generate: () => string
): Promise<string> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let finalValue = "";
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(key);
    getReq.onsuccess = () => {
      const existing = (getReq.result as string | undefined) ?? null;
      const value = existing ?? seed ?? generate();
      if (!existing) store.put(value, key);
      finalValue = value;
    };
    getReq.onerror = () => reject(getReq.error);
    tx.oncomplete = () => resolve(finalValue);
    tx.onabort = () => reject(tx.error ?? new Error("salt transaction aborted"));
  });
}

/** Removes the given keys from the IDB store (used by vault reset). */
export async function removeIdbKeys(keys: string[]): Promise<void> {
  if (!isIdbAvailable() || keys.length === 0) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      keys.forEach((k) => store.delete(k));
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("key removal aborted"));
    });
  } catch (err) {
    console.warn("IndexedDB key removal failed:", err);
  }
}

// ── Torn-key healing (cross-session split-brain guard) ─────
//
// The session-sticky "broken" flag keeps a single session consistent, but it
// resets on reload. Without a durable record of which keys fell back to
// localStorage, the next session would prefer IDB and serve the OLDER value
// for that key (readValue only falls back on a miss, never on stale data),
// permanently hiding the newer write.

const TORN_KEYS_MARKER = "intab_idb_torn_keys";

function readTornKeys(): string[] {
  try {
    const raw = localStorage.getItem(TORN_KEYS_MARKER);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed.filter((k) => typeof k === "string") as string[]) : [];
  } catch {
    return [];
  }
}

function writeTornKeys(keys: string[]): void {
  try {
    if (keys.length === 0) localStorage.removeItem(TORN_KEYS_MARKER);
    else localStorage.setItem(TORN_KEYS_MARKER, JSON.stringify(keys));
  } catch {
    /* marker is best-effort metadata */
  }
}

/** Records that `key`'s newest value currently lives only in localStorage. */
function markTornKey(key: string): void {
  const keys = readTornKeys();
  if (!keys.includes(key)) writeTornKeys([...keys, key]);
}

/** Forgets the torn marker for a key (IDB is authoritative again). */
function clearTornKey(key: string): void {
  const keys = readTornKeys();
  if (keys.includes(key)) writeTornKeys(keys.filter((k) => k !== key));
}

/** Drops every fallback marker (vault reset wipes the data they point at). */
export function resetIdbFallbackMarkers(): void {
  writeTornKeys([]);
}

function readFallbackCopy(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

let healPromise: Promise<void> | null = null;

/**
 * Copies fallback-only values back into IndexedDB once per session so IDB is
 * authoritative again. Without this, a write that fell back during a previous
 * session is invisible forever.
 */
function healTornKeys(): Promise<void> {
  if (!healPromise) {
    healPromise = (async () => {
      if (!isIdbAvailable()) return;
      const torn = readTornKeys();
      if (torn.length === 0) return;
      const remaining: string[] = [];
      for (const key of torn) {
        const fallback = readFallbackCopy(key);
        if (fallback === null) {
          // No fallback copy: the IDB value is the only survivor (the fallback
          // was cleared deliberately). Drop the marker, keep the data.
          continue;
        }
        try {
          await putRaw(key, fallback);
          try {
            localStorage.removeItem(key);
          } catch {
            /* ignore */
          }
        } catch {
          remaining.push(key);
        }
      }
      writeTornKeys(remaining);
    })().catch(() => undefined);
  }
  return healPromise;
}

/**
 * Removes every IDB key matching a prefix (vault reset uses this so wiping a
 * whole key family — workspaces, say — cannot leave orphaned ciphertext).
 */
export async function removeIdbKeysByPrefix(prefixes: string[]): Promise<void> {
  if (!isIdbAvailable() || prefixes.length === 0) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      // Collect first, delete after the cursor is exhausted: mutating the store
      // mid-iteration is legal but easy to get subtly wrong.
      const doomed: IDBValidKey[] = [];
      const cursorReq = store.openKeyCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) {
          doomed.forEach((k) => store.delete(k));
          return;
        }
        if (prefixes.some((p) => String(cursor.key).startsWith(p))) doomed.push(cursor.key);
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("prefix removal aborted"));
    });
  } catch (err) {
    console.warn("IndexedDB prefix removal failed:", err);
  }
}

// ── Read/write with localStorage fallback (split-brain guard) ──

/**
 * Reads a value: IndexedDB first; on miss or IDB failure, checks
 * localStorage before returning null so stale-but-newer fallback data is
 * never silently hidden. Keys whose newest value fell back to localStorage in
 * an earlier session are re-synced into IDB first (see healTornKeys), so IDB
 * cannot shadow a newer write across reloads.
 */
export async function readValue(key: string): Promise<string | null> {
  await healTornKeys();
  if (isIdbAvailable()) {
    try {
      const value = await getRaw(key);
      if (value !== null) return value;
    } catch (err) {
      markIdbBroken(err);
    }
  }
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Writes (or removes) a value: IndexedDB primary, localStorage on
 * failure. localStorage errors (quota) propagate to the caller.
 */
export async function writeValue(key: string, value: string | null): Promise<void> {
  await healTornKeys();
  if (isIdbAvailable()) {
    try {
      if (value === null) await removeRaw(key);
      else await putRaw(key, value);
      // IDB holds the newest copy again — nothing left to reconcile.
      clearTornKey(key);
      return;
    } catch (err) {
      markIdbBroken(err);
    }
  }
  // Fallback path: the localStorage copy is now the newest, so record that IDB
  // may still hold an older value for this key (see healTornKeys).
  if (value === null) {
    localStorage.removeItem(key);
    clearTornKey(key);
  } else {
    localStorage.setItem(key, value);
    markTornKey(key);
  }
}

/**
 * Writes straight to IndexedDB and reports whether it landed there (no
 * localStorage fallback). Callers that intend to delete a legacy plaintext
 * copy need to know the new copy is safely stored somewhere first.
 */
export async function writeValueToIdb(key: string, value: string | null): Promise<boolean> {
  await healTornKeys();
  if (!isIdbAvailable()) return false;
  try {
    if (value === null) await removeRaw(key);
    else await putRaw(key, value);
    clearTornKey(key);
    return true;
  } catch (err) {
    markIdbBroken(err);
    return false;
  }
}
