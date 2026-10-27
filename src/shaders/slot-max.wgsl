// Per-slot channel maxima for empty-space skipping. One workgroup reduces one
// job (slot * SLOT_STRIDE + channel) over the whole physical brick — border
// included, since trilinear samples near a brick face blend in border voxels.

const PHYSICAL_BRICK_SIZE: u32 = 66u;
const ATLAS_GRID: u32 = 10u;
const SLOT_STRIDE: u32 = 8u;
const THREADS: u32 = 128u;

@group(0) @binding(0) var<storage, read> jobs: array<u32>;
@group(0) @binding(1) var<storage, read_write> slotMax: array<f32>;
@group(0) @binding(2) var atlas0: texture_3d<f32>;
@group(0) @binding(3) var atlas1: texture_3d<f32>;
@group(0) @binding(4) var atlas2: texture_3d<f32>;
@group(0) @binding(5) var atlas3: texture_3d<f32>;
@group(0) @binding(6) var atlas4: texture_3d<f32>;
@group(0) @binding(7) var atlas5: texture_3d<f32>;

var<workgroup> partial: array<f32, THREADS>;

// Max over this thread's share of the brick's rows (one row = 66 voxels in x).
fn rowsMax(atlas: texture_3d<f32>, origin: vec3u, thread: u32) -> f32 {
    let b = PHYSICAL_BRICK_SIZE;
    var m = -1e30;
    for (var row = thread; row < b * b; row += THREADS) {
        let start = origin + vec3u(0u, row % b, row / b);
        for (var x = 0u; x < b; x++) {
            m = max(m, textureLoad(atlas, start + vec3u(x, 0u, 0u), 0).r);
        }
    }
    return m;
}

@compute @workgroup_size(THREADS)
fn main(
    @builtin(workgroup_id) wg: vec3u,
    @builtin(local_invocation_index) thread: u32,
) {
    let job = jobs[wg.x];
    let slot = job / SLOT_STRIDE;
    let g = ATLAS_GRID;
    let origin = vec3u(slot % g, (slot / g) % g, slot / (g * g)) * PHYSICAL_BRICK_SIZE;

    var m: f32;
    switch (job % SLOT_STRIDE) {
        case 0u: { m = rowsMax(atlas0, origin, thread); }
        case 1u: { m = rowsMax(atlas1, origin, thread); }
        case 2u: { m = rowsMax(atlas2, origin, thread); }
        case 3u: { m = rowsMax(atlas3, origin, thread); }
        case 4u: { m = rowsMax(atlas4, origin, thread); }
        default: { m = rowsMax(atlas5, origin, thread); }
    }
    partial[thread] = m;
    workgroupBarrier();

    for (var stride = THREADS / 2u; stride > 0u; stride /= 2u) {
        if (thread < stride) {
            partial[thread] = max(partial[thread], partial[thread + stride]);
        }
        workgroupBarrier();
    }
    if (thread == 0u) {
        slotMax[job] = partial[0];
    }
}
