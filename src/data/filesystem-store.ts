/**
 * FileSystemStore - Zarrita store adapter for File System Access API
 */

export class FileSystemStore {
  /** Directory handles by path ("" = root): a chunk read walks its path once per directory, not once per chunk. */
  private readonly dirs = new Map<string, Promise<FileSystemDirectoryHandle>>();

  constructor(dirHandle: FileSystemDirectoryHandle) {
    this.dirs.set("", Promise.resolve(dirHandle));
  }

  private dir(path: string[]): Promise<FileSystemDirectoryHandle> {
    const key = path.join("/");
    let p = this.dirs.get(key);
    if (!p) {
      const name = path[path.length - 1]!;
      p = this.dir(path.slice(0, -1)).then((parent) =>
        parent.getDirectoryHandle(name),
      );
      p.catch(() => this.dirs.delete(key));
      this.dirs.set(key, p);
    }
    return p;
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      const parts = key.split("/").filter((p) => p);
      const dir = await this.dir(parts.slice(0, -1));
      const file = await (
        await dir.getFileHandle(parts[parts.length - 1]!)
      ).getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return undefined;
    }
  }
}
