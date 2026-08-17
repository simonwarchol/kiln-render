/**
 * Local Zarr / Imaris file picker and loader (File System Access API).
 */

import {
  clearHandle,
  getFileHandle,
  getHandle,
  storeFileHandle,
  storeHandle,
} from "./handle-storage.js";

export type FsReadPermission = "granted" | "denied" | "prompt";

type FsHandle = FileSystemDirectoryHandle | FileSystemFileHandle;

export function isFileSystemAccessSupported(): boolean {
  return "showDirectoryPicker" in window;
}

export async function promptForZarrDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!isFileSystemAccessSupported()) {
    throw new Error("File System Access API not supported");
  }

  const dirHandle = await (
    window as unknown as {
      showDirectoryPicker: (opts: {
        mode?: string;
      }) => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker({
    mode: "read",
  });

  await storeHandle(dirHandle);
  return dirHandle;
}

export async function promptForImsFile(): Promise<FileSystemFileHandle> {
  if (!("showOpenFilePicker" in window)) {
    throw new Error("File System Access API not supported");
  }

  const [handle] = await (
    window as unknown as {
      showOpenFilePicker: (opts: {
        multiple?: boolean;
        types?: Array<{
          description: string;
          accept: Record<string, string[]>;
        }>;
      }) => Promise<FileSystemFileHandle[]>;
    }
  ).showOpenFilePicker({
    multiple: false,
    types: [
      {
        description: "Imaris files",
        accept: { "application/octet-stream": [".ims"] },
      },
    ],
  });
  if (!handle) throw new Error("No file selected");
  await storeFileHandle(handle);
  return handle;
}

/** Query current read permission — does not require a user gesture. */
export async function queryReadPermission(
  handle: FsHandle,
): Promise<FsReadPermission> {
  try {
    const status = await (
      handle as unknown as {
        queryPermission: (opts: { mode: string }) => Promise<string>;
      }
    ).queryPermission({ mode: "read" });
    if (status === "granted" || status === "denied" || status === "prompt") {
      return status;
    }
    return "prompt";
  } catch {
    return "denied";
  }
}

/**
 * Request read permission. Safe to call when already granted (no gesture needed).
 * When the state is `prompt`, this MUST run inside a user gesture (click/tap).
 */
export async function requestPermission(handle: FsHandle): Promise<boolean> {
  const current = await queryReadPermission(handle);
  if (current === "granted") return true;
  if (current === "denied") return false;
  try {
    const permission = await (
      handle as unknown as {
        requestPermission: (opts: { mode: string }) => Promise<string>;
      }
    ).requestPermission({ mode: "read" });
    return permission === "granted";
  } catch (err) {
    // Common without a user activation: "User activation is required…"
    console.warn("[Kiln] requestPermission failed:", err);
    return false;
  }
}

export async function getStoredHandle(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await getHandle();
  if (!handle) return null;

  try {
    // Touch the handle so invalid/stale IndexedDB entries are dropped.
    await queryReadPermission(handle);
    return handle;
  } catch {
    await clearHandle();
    return null;
  }
}

export async function getStoredImsHandle(): Promise<FileSystemFileHandle | null> {
  const handle = await getFileHandle();
  if (!handle) return null;

  try {
    await queryReadPermission(handle);
    return handle;
  } catch {
    await clearHandle();
    return null;
  }
}
