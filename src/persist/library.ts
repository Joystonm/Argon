/**
 * Browser-side persistence.
 *
 * IndexedDB, not localStorage: a project with a traced underlay carries a
 * base64 image that can run to megabytes, and localStorage caps out around
 * 5 MB for the whole origin. Underlays get their own object store so a large
 * image never forces the project record to be rewritten.
 *
 * Nothing leaves the device. There is no cloud sync and no account in v1, so
 * a project exists on exactly one browser profile — which is why the export
 * and the backup note in the README matter.
 */
import { SCHEMA_VERSION, type Id, type Project } from '../model/types.ts';

const DB_NAME = 'argon';
const DB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_UNDERLAYS = 'underlays';

interface ProjectRecord {
  id: Id;
  name: string;
  updatedAt: number;
  createdAt: number;
  schemaVersion: number;
  roomCount: number;
  floorCount: number;
  json: string;
}

export interface LibraryEntry {
  id: Id;
  name: string;
  updatedAt: number;
  createdAt: number;
  roomCount: number;
  floorCount: number;
  schemaVersion: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE_PROJECTS)) {
          const s = d.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
          s.createIndex('updatedAt', 'updatedAt');
        }
        if (!d.objectStoreNames.contains(STORE_UNDERLAYS)) {
          d.createObjectStore(STORE_UNDERLAYS);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB is blocked by another open tab'));
    });
  }
  return dbPromise;
}

/** Wrap an IDBRequest as a promise; rejects with the request's own error. */
function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function finish(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/**
 * IndexedDB is unavailable in private windows on some browsers and in any
 * non-browser test environment. Every entry point degrades to "in-memory
 * only" rather than throwing, so the studio still runs.
 */
let degraded = typeof indexedDB === 'undefined';
export const isPersistenceAvailable = (): boolean => !degraded;

export async function saveProject(project: Project): Promise<void> {
  if (degraded) return;
  // Underlay images live in their own store; the project record keeps a
  // placeholder so the JSON stays small enough to write cheaply.
  const stripped: Project = {
    ...project,
    underlays: project.underlays.map((u) => ({ ...u, dataUrl: '' })),
  };
  try {
    const d = await open();
    const tx = d.transaction([STORE_PROJECTS, STORE_UNDERLAYS], 'readwrite');
    const underlays = tx.objectStore(STORE_UNDERLAYS);
    for (const u of project.underlays) {
      if (!u.dataUrl) continue;
      underlays.put(u.dataUrl, u.id);
    }
    const record: ProjectRecord = {
      id: project.id,
      name: project.name,
      updatedAt: project.updatedAt,
      createdAt: project.createdAt,
      schemaVersion: project.schemaVersion,
      roomCount: project.rooms.length,
      floorCount: project.floors.length,
      json: JSON.stringify(stripped),
    };
    tx.objectStore(STORE_PROJECTS).put(record);
    await finish(tx);
  } catch (e) {
    degraded = true;
    throw new Error(
      `Local storage write failed (${e instanceof Error ? e.message : String(e)}). Export the project to a file to keep it safe.`,
    );
  }
}

export async function loadProject(id: Id): Promise<Project | null> {
  if (degraded) return null;
  const d = await open();
  const record = await wrap<ProjectRecord | undefined>(d.transaction(STORE_PROJECTS).objectStore(STORE_PROJECTS).get(id));
  if (!record) return null;
  const project = JSON.parse(record.json) as Project;
  if (project.underlays?.length) {
    const tx = d.transaction(STORE_UNDERLAYS, 'readonly');
    const store = tx.objectStore(STORE_UNDERLAYS);
    project.underlays = await Promise.all(
      project.underlays.map(async (u) => ({ ...u, dataUrl: ((await wrap<string | undefined>(store.get(u.id))) ?? '') })),
    );
    await finish(tx);
  }
  return project;
}

/** The project list, newest first. Does not load the project bodies. */
export async function listProjects(): Promise<LibraryEntry[]> {
  if (degraded) return [];
  const d = await open();
  const all = await wrap<ProjectRecord[]>(d.transaction(STORE_PROJECTS).objectStore(STORE_PROJECTS).getAll());
  return all
    .map(({ json: _json, ...rest }) => rest)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProject(id: Id): Promise<void> {
  if (degraded) return;
  const d = await open();
  const tx = d.transaction(STORE_PROJECTS, 'readwrite');
  tx.objectStore(STORE_PROJECTS).delete(id);
  await finish(tx);
}

/** Byte size of one stored project, for the backup hint in Settings. */
export async function projectSize(id: Id): Promise<number> {
  if (degraded) return 0;
  const d = await open();
  const record = await wrap<ProjectRecord | undefined>(d.transaction(STORE_PROJECTS).objectStore(STORE_PROJECTS).get(id));
  return record ? new TextEncoder().encode(record.json).length : 0;
}

export async function estimateUsage(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  const est = await navigator.storage.estimate();
  return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
}

/**
 * Ask the browser not to evict us. A no-op where unsupported — this is a
 * courtesy, not a guarantee, which is why the README still tells people to
 * export.
 */
export async function requestPersistence(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export const currentSchema = SCHEMA_VERSION;