/**
 * Modal that re-requests File System Access permission after a page reload.
 * `requestPermission` requires a user gesture when the state is `prompt`.
 */

import { requestPermission } from "kiln-render";

type FsHandle = FileSystemDirectoryHandle | FileSystemFileHandle;

/**
 * Show a blocking reconnect card. Returns true if the user granted permission.
 * The grant click is the user activation Chrome requires.
 */
export function promptLocalFileReconnect(
  handle: FsHandle,
  kind: "zarr" | "ims",
): Promise<boolean> {
  const label = kind === "ims" ? "local Imaris file" : "local Zarr directory";

  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "local-reconnect-backdrop";
    backdrop.innerHTML = `
      <div class="local-reconnect-card" role="dialog" aria-modal="true" aria-labelledby="local-reconnect-title">
        <h3 id="local-reconnect-title">Reconnect to ${label}</h3>
        <p>The browser needs permission again after a reload. Click below to continue with the same file.</p>
        <div class="local-reconnect-actions">
          <button type="button" class="local-reconnect-grant">Allow access</button>
          <button type="button" class="local-reconnect-skip">Skip</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);

    const cleanup = (ok: boolean) => {
      backdrop.remove();
      resolve(ok);
    };

    backdrop
      .querySelector(".local-reconnect-grant")
      ?.addEventListener("click", async () => {
        const granted = await requestPermission(handle);
        cleanup(granted);
      });

    backdrop
      .querySelector(".local-reconnect-skip")
      ?.addEventListener("click", () => cleanup(false));
  });
}
