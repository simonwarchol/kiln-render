/**
 * Local Zarr file picker and loader
 */

import {
  clearHandle,
  getFileHandle,
  getHandle,
  storeFileHandle,
  storeHandle,
} from "./handle-storage.js";

export function isFileSystemAccessSupported(): boolean {
  return "showDirectoryPicker" in window;
}

export async function promptForZarrDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!isFileSystemAccessSupported()) {
    throw new Error("File System Access API not supported");
  }

  const dirHandle = await (window as any).showDirectoryPicker({
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

export async function getStoredHandle(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await getHandle();
  if (!handle) return null;

  try {
    await (handle as any).queryPermission({ mode: "read" });
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
    await (handle as any).queryPermission({ mode: "read" });
    return handle;
  } catch {
    await clearHandle();
    return null;
  }
}

export async function requestPermission(
  handle: FileSystemDirectoryHandle | FileSystemFileHandle,
): Promise<boolean> {
  const permission = await (handle as any).requestPermission({ mode: "read" });
  return permission === "granted";
}
