// Ray marching core - brick traversal and integration

// Brick setup information
struct BrickInfo {
    indirection: vec4u,
    lodScale: f32,
    tEnd: f32,
    numSteps: u32,
    stepSize: f32,
    valid: bool,
    // Linear atlas slot index (for slotMax)
    slot: u32,
    // affine atlas transform: atlasPos = atlasOffset + voxelPos * atlasScale
    // precomputed per brick to replace fmod + divides in the hot loop
    atlasOffset: vec3f,
    atlasScale: f32,
}

// Set up brick traversal parameters
fn setupBrick(
    rayOrigin: vec3f, rayDir: vec3f, invDir: vec3f, t: f32, tEnd: f32,
    normalizedSize: vec3f, datasetSize: vec3f
) -> BrickInfo {
    var info: BrickInfo;

    let samplePos = rayOrigin + rayDir * t;
    let voxelPos = clamp(
        normalizedToVoxel(samplePos, normalizedSize, datasetSize),
        vec3f(0.0),
        datasetSize - vec3f(0.001)
    );
    let brickIndex = floor(voxelPos / LOGICAL_BRICK_SIZE);

    let brickMinVoxel = brickIndex * LOGICAL_BRICK_SIZE;
    let brickMaxVoxel = brickMinVoxel + LOGICAL_BRICK_SIZE;
    let brickMinWorld = voxelToNormalized(brickMinVoxel, normalizedSize, datasetSize);
    let brickMaxWorld = voxelToNormalized(brickMaxVoxel, normalizedSize, datasetSize);

    let tBrick = intersectBox(rayOrigin, invDir, brickMinWorld, brickMaxWorld);
    info.tEnd = min(tBrick.y, tEnd);

    info.indirection = lookupIndirection(brickIndex);
    // w=0 means not loaded, w=255 means known empty - both are invalid
    info.valid = info.indirection.w > 0u && info.indirection.w < 255u;

    if (info.valid) {
        info.lodScale = getLodScale(info.indirection);
        info.slot = (info.indirection.z * ATLAS_GRID + info.indirection.y) * ATLAS_GRID + info.indirection.x;

        // LOD-adaptive step size — coarse bricks use larger steps
        // compositing uses exact Beer-Lambert (1 - exp2)
        let brickWorldSize = length(brickMaxWorld - brickMinWorld);
        let brickLength = info.tEnd - t;
        let lodStepMul = min(info.lodScale, 4.0);
        info.stepSize = (brickWorldSize / STEPS_PER_BRICK) * lodStepMul * uniforms.stepScale;
        info.numSteps = max(1u, u32(ceil(brickLength / info.stepSize)) + 1u);

        // precompute affine atlas transform for the hot loop
        let coarseBrickOrigin = floor(brickIndex / info.lodScale) * info.lodScale * LOGICAL_BRICK_SIZE;
        info.atlasScale = 1.0 / (info.lodScale * ATLAS_SIZE);
        // BORDER only — must match the corrected sampleAtlas / sampleAtlasCh
        // (no extra half-texel; see sampling.wgsl for the derivation).
        info.atlasOffset = vec3f(info.indirection.xyz) * PHYSICAL_BRICK_SIZE / ATLAS_SIZE
                         + BORDER / ATLAS_SIZE
                         - coarseBrickOrigin * info.atlasScale;
    }

    return info;
}

// Sample-comb offset in [0, 1) for this ray: a per-pixel random start
// advanced by the golden ratio each frame, so the accumulated TAA frames
// cover the step evenly rather than at random.
fn rayJitter(rayDir: vec3f) -> f32 {
    if (uniforms.jitter == 0u) { return 0.0; }
    return fract(rand(rayToSeed(rayDir)) + f32(uniforms.frameIndex % 4096u) * 0.618034);
}

// Depth cue (core/depth-cue.ts): emission fades with distance `t` from the
// camera; 1 = no fade.
fn depthFade(t: f32) -> f32 {
    return exp(-uniforms.depthCueScale * max(0.0, t - uniforms.depthCueNear));
}

// Ray parameter just past a brick's exit (scale-sensitive epsilon)
fn nextBrickT(brick: BrickInfo) -> f32 {
    return brick.tEnd + max(0.0001, brick.tEnd * 1e-6);
}

// Largest normalised value channel `ch` holds in an atlas slot, from the
// per-slot maxima (slot-max.wgsl). Every sample in the brick is at most this.
fn brickMax(slot: u32, ch: u32, floatInvRange: f32) -> f32 {
    let raw = slotMax[slot * 2u + ch / 4u][ch % 4u];
    return clamp((raw - uniforms.floatMin) * floatInvRange, 0.0, 1.0);
}

// Refine isosurface position using bisection with windowing.
// Uses sampleWithIndirection so bisection across brick boundaries is correct.
fn refineIsoSurfaceWindowed(
    rayOrigin: vec3f, rayDir: vec3f, tLow: f32, tHigh: f32, isoValue: f32,
    normalizedSize: vec3f, datasetSize: vec3f,
    windowCenter: f32, windowWidth: f32
) -> f32 {
    var lo = tLow;
    var hi = tHigh;
    for (var i = 0u; i < 4u; i++) {
        let mid = (lo + hi) * 0.5;
        let pos = rayOrigin + rayDir * mid;
        let voxel = normalizedToVoxel(pos, normalizedSize, datasetSize);
        let rawDensity = sampleWithIndirection(voxel);
        let normalizedDensity = clamp((rawDensity - uniforms.floatMin) / max(uniforms.floatMax - uniforms.floatMin, 0.0001), 0.0, 1.0);
        let density = applyWindow(normalizedDensity, windowCenter, windowWidth);
        if (density >= isoValue) { hi = mid; } else { lo = mid; }
    }
    return (lo + hi) * 0.5;
}
