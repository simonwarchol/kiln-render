/**
 * In-app Gaussian splat preview using the PlayCanvas engine (same renderer
 * SuperSplat is built on). Mounts a canvas in an overlay — no iframe, no
 * HTML-string templating.
 *
 * This repo’s UI is vanilla DOM. For React hosts, use `@playcanvas/react`
 * (`<GSplat>` / `@playcanvas/blocks` `<Viewer.Splat>`) with the same PLY blob URL.
 */

import type { Application, Entity, Vec3 } from "playcanvas";
import { downloadBytes } from "./gaussian-ply.js";

export interface OpenSplatViewerOptions {
  /** Overlay title */
  title?: string;
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

function countVerticesInPly(ply: Uint8Array): number {
  const head = new TextDecoder().decode(
    ply.subarray(0, Math.min(ply.byteLength, 2048)),
  );
  const match = /element vertex (\d+)/.exec(head);
  return match ? Number(match[1]) : 0;
}

function attachOrbit(
  canvas: HTMLCanvasElement,
  camera: Entity,
  pivot: Vec3,
): () => void {
  let yaw = 0;
  let pitch = 0.35;
  let distance = Math.max(0.5, camera.getPosition().distance(pivot));
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  const apply = () => {
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    camera.setPosition(
      pivot.x + distance * cp * sy,
      pivot.y + distance * sp,
      pivot.z + distance * cp * cy,
    );
    camera.lookAt(pivot);
  };
  apply();

  const onDown = (e: PointerEvent) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    yaw -= (e.clientX - lastX) * 0.005;
    pitch = Math.max(-1.4, Math.min(1.4, pitch - (e.clientY - lastY) * 0.005));
    lastX = e.clientX;
    lastY = e.clientY;
    apply();
  };
  const onUp = (e: PointerEvent) => {
    dragging = false;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    distance = Math.max(0.2, Math.min(40, distance * (1 + e.deltaY * 0.001)));
    apply();
  };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  return () => {
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("pointercancel", onUp);
    canvas.removeEventListener("wheel", onWheel);
  };
}

/**
 * Open an overlay that renders a 3DGS PLY with PlayCanvas.
 * Returns false if the PLY is empty or PlayCanvas fails to initialize.
 */
export async function openEmbeddedSplatViewer(
  ply: Uint8Array,
  opts: OpenSplatViewerOptions = {},
): Promise<boolean> {
  if (countVerticesInPly(ply) === 0) {
    console.warn("[Kiln] PLY has 0 gaussians — skipping embedded splat viewer");
    return false;
  }

  let pc: typeof import("playcanvas");
  try {
    pc = await import("playcanvas");
  } catch (err) {
    console.warn("[Kiln] playcanvas is not installed:", err);
    return false;
  }

  const plyUrl = URL.createObjectURL(
    new Blob([toArrayBuffer(ply)], { type: "application/octet-stream" }),
  );

  const backdrop = document.createElement("div");
  backdrop.className = "splat-viewer-backdrop";
  backdrop.innerHTML = `
    <div class="splat-viewer-panel" role="dialog" aria-modal="true" aria-label="Splat preview">
      <header class="splat-viewer-header">
        <span>${opts.title ?? "Splat preview"}</span>
        <button type="button" class="splat-viewer-close" aria-label="Close">Close</button>
      </header>
      <div class="splat-viewer-canvas-wrap">
        <canvas class="splat-viewer-canvas"></canvas>
        <div class="splat-viewer-status">Loading splat…</div>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const canvas = backdrop.querySelector(
    ".splat-viewer-canvas",
  ) as HTMLCanvasElement;
  const status = backdrop.querySelector(
    ".splat-viewer-status",
  ) as HTMLDivElement;
  const wrap = backdrop.querySelector(
    ".splat-viewer-canvas-wrap",
  ) as HTMLDivElement;

  let app: Application | null = null;
  let detachOrbit: (() => void) | null = null;
  let closed = false;
  let ro: ResizeObserver | null = null;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener("keydown", onKey);
    ro?.disconnect();
    ro = null;
    detachOrbit?.();
    detachOrbit = null;
    try {
      app?.destroy();
    } catch {
      /* already destroyed */
    }
    app = null;
    backdrop.remove();
    URL.revokeObjectURL(plyUrl);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") cleanup();
  };

  backdrop
    .querySelector(".splat-viewer-close")
    ?.addEventListener("click", cleanup);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) cleanup();
  });
  window.addEventListener("keydown", onKey);

  try {
    app = new pc.Application(canvas, {
      graphicsDeviceOptions: { antialias: false },
    });
    app.setCanvasFillMode(pc.FILLMODE_NONE);
    app.setCanvasResolution(pc.RESOLUTION_AUTO);
    app.start();

    const syncSize = () => {
      if (!app || closed) return;
      const w = Math.max(1, wrap.clientWidth);
      const h = Math.max(1, wrap.clientHeight);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      app.resizeCanvas(w, h);
    };
    syncSize();
    ro = new ResizeObserver(syncSize);
    ro.observe(wrap);

    const asset = new pc.Asset("kiln-splat", "gsplat", {
      url: plyUrl,
      filename: "kiln-init.ply",
    });

    await new Promise<void>((resolve, reject) => {
      asset.ready(() => resolve());
      asset.on("error", (err: string | Error) => {
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      app!.assets.add(asset);
      app!.assets.load(asset);
    });

    if (closed) return false;

    const camera = new pc.Entity("camera");
    camera.addComponent("camera", {
      clearColor: new pc.Color(0.08, 0.09, 0.11),
      fov: 60,
    });
    camera.setPosition(0, 0.5, 2.2);
    app.root.addChild(camera);

    const splat = new pc.Entity("splat");
    // Many 3DGS PLYs are Y-down (COLMAP); flip to Y-up for PlayCanvas.
    splat.setLocalEulerAngles(0, 0, 180);
    splat.addComponent("gsplat", { asset });
    app.root.addChild(splat);

    const pivot = new pc.Vec3(0, 0, 0);
    const gsplat = splat.gsplat as
      | {
          customAabb?: { center: Vec3; halfExtents: Vec3 };
          instance?: {
            meshInstance?: { aabb?: { center: Vec3; halfExtents: Vec3 } };
          };
        }
      | null
      | undefined;
    const aabb =
      gsplat?.customAabb ?? gsplat?.instance?.meshInstance?.aabb ?? null;
    if (aabb) {
      pivot.copy(aabb.center);
      const radius = Math.max(
        aabb.halfExtents.x,
        aabb.halfExtents.y,
        aabb.halfExtents.z,
        0.25,
      );
      camera.setPosition(
        pivot.x,
        pivot.y + radius * 0.35,
        pivot.z + radius * 2.5,
      );
    }

    detachOrbit = attachOrbit(canvas, camera, pivot);
    status.remove();
    return true;
  } catch (err) {
    console.warn("[Kiln] PlayCanvas splat viewer failed:", err);
    status.textContent =
      err instanceof Error ? err.message : "Failed to load splat";
    return false;
  }
}

/**
 * Download a Gaussian PLY and open the in-app viewer on that same file.
 * The overlay is the exported splat — not a separate preview representation.
 */
export async function presentSplatPly(
  ply: Uint8Array,
  opts: OpenSplatViewerOptions = {},
): Promise<boolean> {
  downloadBytes("kiln-gaussians.ply", ply, "application/octet-stream");
  return openEmbeddedSplatViewer(ply, {
    title: opts.title ?? "Gaussian splat",
  });
}
