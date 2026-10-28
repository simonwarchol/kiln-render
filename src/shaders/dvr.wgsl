// Direct Volume Rendering (DVR) - Front-to-back compositing with windowing

fn rayMarchDVR(
    rayOrigin: vec3f, rayDir: vec3f, tStart: f32, tEnd: f32,
    normalizedSize: vec3f, datasetSize: vec3f
) -> vec4f {
    let maxDim = max(datasetSize.x, max(datasetSize.y, datasetSize.z));
    let invDir = 1.0 / rayDir;

    let windowCenter = uniforms.windowCenter;
    let windowWidth = uniforms.windowWidth;

    // precompute per-channel windowing constants, colours and opacities
    // (colour alpha), plus a bitmask of the visible channels (alpha > 0)
    var chLower: array<f32, 6>;
    var chInvWidth: array<f32, 6>;
    var chColor: array<vec3f, 6>;
    var chOpacity: array<f32, 6>;
    var visible = 0u;
    if (NUM_CHANNELS > 1u) {
        for (var ch = 0u; ch < NUM_CHANNELS; ch++) {
            let ww = max(chWindowWidth(ch), 0.0001);
            chLower[ch] = chWindowCenter(ch) - ww * 0.5;
            chInvWidth[ch] = 1.0 / ww;
            let c = uniforms.channelColors[ch];
            chColor[ch] = c.rgb;
            chOpacity[ch] = c.a;
            if (c.a > 0.0) { visible |= 1u << ch; }
        }
    }

    // precompute float normalisation — shared by single- and multi-channel
    // paths (identity for uint data where floatMin=0, floatMax=1)
    let floatInvRange = 1.0 / max(uniforms.floatMax - uniforms.floatMin, 0.0001);

    let jitterFrac = rayJitter(rayDir);

    var color = vec3f(0.0);
    var alpha = 0.0;
    var t = tStart;
    var tSample = -1.0;  // sentinel: not yet initialized

    for (var brickIter = 0u; brickIter < MAX_BRICK_TRAVERSALS; brickIter++) {
        if (t >= tEnd) { break; }
        if (alpha > uniforms.earlyExitAlpha) { break; }

        let brick = setupBrick(rayOrigin, rayDir, invDir, t, tEnd, normalizedSize, datasetSize);

        // Skip bricks (and, multi-channel, single channels of a brick) whose
        // stored maximum can't clear the window: a channel below its window
        // adds nothing, and samples at or below 0.01 composite nothing.
        var mask = 0u;
        var peak = 0.0;
        if (brick.valid) {
            if (NUM_CHANNELS > 1u) {
                for (var ch = 0u; ch < NUM_CHANNELS; ch++) {
                    if ((visible & (1u << ch)) == 0u) { continue; }
                    let d = clamp((brickMax(brick.slot, ch, floatInvRange) - chLower[ch]) * chInvWidth[ch], 0.0, 1.0);
                    if (d > 0.0) {
                        mask |= 1u << ch;
                        peak = max(peak, d * chOpacity[ch]);
                    }
                }
            } else {
                peak = applyWindow(brickMax(brick.slot, 0u, floatInvRange), windowCenter, windowWidth);
            }
        }
        if (peak <= 0.01) {
            t = nextBrickT(brick);
            continue;
        }

        let extinctionScale = brick.stepSize * uniforms.densityScale * maxDim * 0.5 * LOG2E;

        if (tSample < 0.0) {
            // First valid brick: start the sampling comb with jitter
            tSample = t + jitterFrac * brick.stepSize;
        } else if (tSample < t) {
            // after skipping bricks, advance by whole steps
            // to preserve the jitter phase instead of snapping to t
            let steps = ceil((t - tSample) / brick.stepSize);
            tSample += steps * brick.stepSize;
        }

        for (var i = 0u; i < brick.numSteps; i++) {
            if (tSample > brick.tEnd) { break; }

            let pos = rayOrigin + rayDir * tSample;
            let voxel = normalizedToVoxel(pos, normalizedSize, datasetSize);
            let fade = depthFade(tSample);

            if (NUM_CHANNELS > 1u) {
                // Multi-channel: per-channel windowing + additive composite.
                // A channel's opacity scales its density: what it absorbs and
                // its share of the emitted colour.
                var weightedColor = vec3f(0.0);
                var maxDensity = 0.0;
                for (var ch = 0u; ch < NUM_CHANNELS; ch++) {
                    if ((mask & (1u << ch)) == 0u) { continue; }
                    let raw = sampleAtlasChAffine(ch, voxel, brick.atlasOffset, brick.atlasScale);
                    // Normalise raw float range to [0,1] BEFORE per-channel
                    // windowing (identity for uint data).
                    let norm = clamp((raw - uniforms.floatMin) * floatInvRange, 0.0, 1.0);
                    let density = clamp((norm - chLower[ch]) * chInvWidth[ch], 0.0, 1.0) * chOpacity[ch];
                    weightedColor += density * chColor[ch];
                    maxDensity = max(maxDensity, density);
                }
                composeSampleAdditive(weightedColor * fade, maxDensity, extinctionScale, &color, &alpha);
            } else {
                // Single channel: TF-based DVR with windowing and float normalisation
                let rawDensity = sampleAtlasAffine(voxel, brick.atlasOffset, brick.atlasScale);
                let density = clamp((rawDensity - uniforms.floatMin) * floatInvRange, 0.0, 1.0);
                composeSampleWindowed(density, extinctionScale, windowCenter, windowWidth, fade, &color, &alpha);
            }

            if (alpha > uniforms.earlyExitAlpha) { break; }
            tSample += brick.stepSize;
        }

        t = nextBrickT(brick);
    }

    return vec4f(color, alpha);
}
