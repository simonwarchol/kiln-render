/**
 * IndexedDB storage for FileSystemDirectoryHandle
 */

const DB_NAME = "kiln-zarr-handles";
const STORE_NAME = "handles";
const KEY = "local-zarr-dir";
const IMS_KEY = "local-ims-file";

async function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

export async function storeHandle(
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.delete(IMS_KEY);
    const request = store.put(handle, KEY);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

export async function storeFileHandle(
  handle: FileSystemFileHandle,
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.delete(KEY);
    const request = store.put(handle, IMS_KEY);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

export async function getHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(KEY);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const handle = request.result as FileSystemDirectoryHandle | undefined;
        resolve(handle ?? null);
      };
    });
  } catch {
    return null;
  }
}

export async function getFileHandle(): Promise<FileSystemFileHandle | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(IMS_KEY);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const handle = request.result as FileSystemFileHandle | undefined;
        resolve(handle ?? null);
      };
    });
  } catch {
    return null;
  }
}

export async function clearHandle(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.delete(KEY);
    const request = store.delete(IMS_KEY);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}
