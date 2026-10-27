/**
 * IndexedDB storage for the last local dataset's FileSystem handle (one
 * slot: a zarr directory or an Imaris file).
 */

const DB_NAME = "kiln-zarr-handles";
const STORE_NAME = "handles";
const KEY = "local-zarr-dir";
const IMS_KEY = "local-ims-file";

/** Run one request in a transaction on a fresh connection, then close it. */
async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const request = run(tx.objectStore(STORE_NAME));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error ?? request.error);
      tx.onabort = () => reject(tx.error ?? request.error);
    });
  } finally {
    db.close();
  }
}

/** Store `handle` under `key`, replacing the other slot. */
async function put(
  key: string,
  other: string,
  handle: FileSystemHandle,
): Promise<void> {
  await withStore("readwrite", (store) => {
    store.delete(other);
    return store.put(handle, key);
  });
}

async function get<T>(key: string): Promise<T | null> {
  try {
    return ((await withStore("readonly", (store) => store.get(key))) ??
      null) as T | null;
  } catch {
    return null;
  }
}

export function storeHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  return put(KEY, IMS_KEY, handle);
}

export function storeFileHandle(handle: FileSystemFileHandle): Promise<void> {
  return put(IMS_KEY, KEY, handle);
}

export function getHandle(): Promise<FileSystemDirectoryHandle | null> {
  return get(KEY);
}

export function getFileHandle(): Promise<FileSystemFileHandle | null> {
  return get(IMS_KEY);
}

export async function clearHandle(): Promise<void> {
  await withStore("readwrite", (store) => {
    store.delete(KEY);
    return store.delete(IMS_KEY);
  });
}
