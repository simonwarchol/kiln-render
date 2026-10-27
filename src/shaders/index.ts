/**
 * Shader module assembly — combines modular WGSL components into
 * complete shader programs (compute, blit, overlays).
 */

import {
  ATLAS_SIZE,
  LOGICAL_BRICK_SIZE,
  MAX_BRICK_TRAVERSALS,
  PHYSICAL_BRICK_SIZE,
} from "../core/config.js";
import accumulateWGSL from "./accumulate.wgsl?raw";
import axisWGSL from "./axis.wgsl?raw";
import blitWGSL from "./blit.wgsl?raw";
// Import WGSL shader sources
import commonWGSL from "./common.wgsl?raw";
import compositingWGSL from "./compositing.wgsl?raw";
import dvrWGSL from "./dvr.wgsl?raw";
import isoWGSL from "./iso.wgsl?raw";
import mipWGSL from "./mip.wgsl?raw";
import raymarchingWGSL from "./raymarching.wgsl?raw";
import samplingWGSL from "./sampling.wgsl?raw";
import slicePlanesWGSL from "./slice-planes.wgsl?raw";
import slotMaxWGSL from "./slot-max.wgsl?raw";
import { COMPUTE_UNIFORMS, SLICE_UNIFORMS } from "./uniform-layout.js";
import wireframeWGSL from "./wireframe.wgsl?raw";

// Inject rendering constants into shader source. Atlas size is per-viewer (the
// atlas may be budget-shrunk), so it's passed in rather than read from config.ts.
function injectConfig(shader: string, atlasSize: number = ATLAS_SIZE): string {
  return shader
    .replace(
      /LOGICAL_BRICK_SIZE: f32 = \d+\.0/,
      `LOGICAL_BRICK_SIZE: f32 = ${LOGICAL_BRICK_SIZE}.0`,
    )
    .replace(
      /PHYSICAL_BRICK_SIZE: f32 = \d+\.0/,
      `PHYSICAL_BRICK_SIZE: f32 = ${PHYSICAL_BRICK_SIZE}.0`,
    )
    .replace(/ATLAS_SIZE: f32 = \d+\.0/, `ATLAS_SIZE: f32 = ${atlasSize}.0`)
    .replace(
      /ATLAS_GRID: u32 = \d+u/,
      `ATLAS_GRID: u32 = ${atlasSize / PHYSICAL_BRICK_SIZE}u`,
    )
    .replace(
      /MAX_BRICK_TRAVERSALS: u32 = \d+u/,
      `MAX_BRICK_TRAVERSALS: u32 = ${MAX_BRICK_TRAVERSALS}u`,
    );
}

// Shared bindings used by volume shaders
const sharedBindings = /* wgsl */ `
@group(0) @binding(1) var volumeSampler: sampler;
@group(0) @binding(2) var volumeTexture: texture_3d<f32>;
@group(0) @binding(3) var tfSampler: sampler;
@group(0) @binding(4) var tfTexture: texture_2d<f32>;
@group(0) @binding(6) var indirectionTexture: texture_3d<u32>;
@group(0) @binding(8) var volumeTexture1: texture_3d<f32>;
@group(0) @binding(9) var volumeTexture2: texture_3d<f32>;
@group(0) @binding(10) var volumeTexture3: texture_3d<f32>;
@group(0) @binding(11) var volumeTexture4: texture_3d<f32>;
@group(0) @binding(12) var volumeTexture5: texture_3d<f32>;
`;

// Assemble the common shader code for a given atlas size
function buildSharedCode(atlasSize: number): string {
  return [
    injectConfig(commonWGSL, atlasSize),
    samplingWGSL,
    compositingWGSL,
  ].join("\n");
}

/** Compute-shader render modes (pipeline-overridable constant RENDER_MODE). */
export const RENDER_MODE = { dvr: 0, mip: 1, iso: 2 } as const;

// Compute shader (full-screen ray marching). Built per-viewer so the injected
// ATLAS_SIZE matches the (possibly budget-shrunk) atlas texture. The render
// mode and channel count are pipeline overrides, so each pipeline compiles
// only the marcher (and channel loop) it runs.
export function buildComputeShader(atlasSize: number = ATLAS_SIZE): string {
  return /* wgsl */ `
override RENDER_MODE: u32 = 0u;
override NUM_CHANNELS: u32 = 1u;

struct Uniforms {
${COMPUTE_UNIFORMS.fields}
}

${buildSharedCode(atlasSize)}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
${sharedBindings}
@group(0) @binding(7) var outputTexture: texture_storage_2d<rgba16float, write>;
@group(0) @binding(13) var<storage, read> slotMax: array<vec4f>;

${raymarchingWGSL}
${dvrWGSL}
${mipWGSL}
${isoWGSL}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
    let pixelCoord = vec2i(globalId.xy);
    let screenSize = vec2i(uniforms.screenSize);

    if (pixelCoord.x >= screenSize.x || pixelCoord.y >= screenSize.y) { return; }

    let ndc = vec2f(
        (f32(pixelCoord.x) + 0.5) / f32(screenSize.x) * 2.0 - 1.0,
        1.0 - (f32(pixelCoord.y) + 0.5) / f32(screenSize.y) * 2.0
    );

    let nearPoint = uniforms.inverseViewProj * vec4f(ndc, -1.0, 1.0);
    let farPoint = uniforms.inverseViewProj * vec4f(ndc, 1.0, 1.0);
    let near = nearPoint.xyz / nearPoint.w;
    let far = farPoint.xyz / farPoint.w;

    let rayOrigin = uniforms.cameraPos;
    let rayDir = normalize(far - near);

    // The clip box (0–1 per axis) lies inside the volume, so one
    // intersection covers both.
    let ns = uniforms.normalizedSize;
    let hit = intersectBox(
        rayOrigin, 1.0 / rayDir,
        (clamp(uniforms.clipMin, vec3f(0.0), vec3f(1.0)) - 0.5) * ns,
        (clamp(uniforms.clipMax, vec3f(0.0), vec3f(1.0)) - 0.5) * ns
    );
    let tStart = max(hit.x, 0.0);

    let bg = uniforms.background;
    if (tStart >= hit.y) {
        textureStore(outputTexture, pixelCoord, bg);
        return;
    }

    var result: vec4f;
    if (RENDER_MODE == ${RENDER_MODE.mip}u) {
        result = rayMarchMIP(rayOrigin, rayDir, tStart, hit.y, ns, uniforms.datasetSize);
    } else if (RENDER_MODE == ${RENDER_MODE.iso}u) {
        result = rayMarchISO(rayOrigin, rayDir, tStart, hit.y, ns, uniforms.datasetSize, uniforms.isoValue);
    } else {
        result = rayMarchDVR(rayOrigin, rayDir, tStart, hit.y, ns, uniforms.datasetSize);
    }

    // Premultiplied "over" onto the background (bg.a = 0 keeps the volume's alpha).
    let finalColor = result.rgb + bg.rgb * (1.0 - result.a);
    let finalAlpha = result.a + bg.a * (1.0 - result.a);
    textureStore(outputTexture, pixelCoord, vec4f(finalColor, finalAlpha));
}
`;
}

/** Per-slot channel maxima reduction (see VolumeResources.slotMax). */
export function buildSlotMaxShader(atlasSize: number): string {
  return slotMaxWGSL
    .replace(
      /PHYSICAL_BRICK_SIZE: u32 = \d+u/,
      `PHYSICAL_BRICK_SIZE: u32 = ${PHYSICAL_BRICK_SIZE}u`,
    )
    .replace(
      /ATLAS_GRID: u32 = \d+u/,
      `ATLAS_GRID: u32 = ${atlasSize / PHYSICAL_BRICK_SIZE}u`,
    );
}

// Re-export simple shaders directly
export const wireframeShader = wireframeWGSL;
export const axisShader = axisWGSL;
export const blitShader = blitWGSL;
export const accumulateShader = accumulateWGSL;

// Slice planes shader: axis-aligned cross-sections through the volume. Built
// per-viewer so the injected ATLAS_SIZE matches the atlas texture.
export function buildSlicePlanesShader(atlasSize: number = ATLAS_SIZE): string {
  return [
    `struct Uniforms {\n${SLICE_UNIFORMS.fields}\n}`,
    `@group(0) @binding(0) var<uniform> uniforms: Uniforms;`,
    sharedBindings,
    injectConfig(commonWGSL, atlasSize),
    samplingWGSL,
    slicePlanesWGSL,
  ].join("\n");
}
