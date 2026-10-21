/**
 * Channel picker for files with more channels than Kiln renders at once
 * (Imaris files often have 10–20). Applying reloads the viewer with the
 * selection in `?ch=` so the choice is shareable.
 */

import type { ImsChannelInfo } from "kiln-render";

const MAX_ACTIVE = 6;

function hex([r, g, b]: [number, number, number]): string {
  const c = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function createChannelPicker(
  all: ImsChannelInfo[],
  active: number[],
): HTMLElement {
  const row = document.createElement("div");
  row.className = "channel-picker-row";
  const label = document.createElement("span");
  label.textContent = `${active.length} of ${all.length} channels`;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ctl-btn";
  btn.textContent = "Choose…";
  btn.addEventListener("click", () => openDialog(all, active));
  row.append(label, btn);
  return row;
}

function openDialog(all: ImsChannelInfo[], active: number[]): void {
  const overlay = document.createElement("div");
  overlay.className = "channel-picker-overlay";
  const dialog = document.createElement("div");
  dialog.className = "channel-picker-dialog";
  const title = document.createElement("h3");
  title.textContent = "Channels";
  const hint = document.createElement("p");
  hint.textContent = `Pick up to ${MAX_ACTIVE} channels to stream and render.`;
  dialog.append(title, hint);

  const selected = new Set(active);
  const boxes: HTMLInputElement[] = [];
  const sync = () => {
    for (const [i, box] of boxes.entries()) {
      box.disabled = !box.checked && selected.size >= MAX_ACTIVE;
      box.checked = selected.has(all[i]!.index);
    }
    apply.disabled = selected.size === 0;
  };
  for (const ch of all) {
    const item = document.createElement("label");
    item.className = "channel-picker-item";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = selected.has(ch.index);
    box.addEventListener("change", () => {
      if (box.checked) selected.add(ch.index);
      else selected.delete(ch.index);
      sync();
    });
    boxes.push(box);
    const sw = document.createElement("span");
    sw.className = "channel-picker-swatch";
    sw.style.background = hex(ch.color);
    const name = document.createElement("span");
    name.textContent = `${ch.index}: ${ch.name}`;
    item.append(box, sw, name);
    dialog.appendChild(item);
  }

  const actions = document.createElement("div");
  actions.className = "channel-picker-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ctl-btn";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => overlay.remove());
  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "ctl-btn";
  apply.textContent = "Apply";
  apply.addEventListener("click", () => {
    const url = new URL(window.location.href);
    url.searchParams.set("ch", [...selected].sort((a, b) => a - b).join(","));
    url.searchParams.delete("channels");
    window.location.href = url.toString();
  });
  actions.append(cancel, apply);
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
  sync();
}
