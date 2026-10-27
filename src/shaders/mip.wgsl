// Maximum Intensity Projection (MIP) rendering with windowing

fn rayMarchMIP(
    rayOrigin: vec3f, rayDir: vec3f, tStart: f32, tEnd: f32,
    normalizedSize: vec3f, datasetSize: vec3f
) -> vec4f {
    let invDir = 1.0 / rayDir;

    // Get windowing parameters from uniforms
    let windowCenter = uniforms.windowCenter;
    let windowWidth = uniforms.windowWidth;

    // precompute per-channel windowing constants and premultiplied colours,
    // plus a bitmask of the visible channels (alpha > 0)
    var chLower: array<f32, 6>;
    var chInvWidth: array<f32, 6>;
    var chColor: array<vec3f, 6>;
    var visible = 0u;
    if (NUM_CHANNELS > 1u) {
        for (var ch = 0u; ch < NUM_CHANNELS; ch++) {
            let ww = max(chWindowWidth(ch), 0.0001);
            chLower[ch] = chWindowCenter(ch) - ww * 0.5;
            chInvWidth[ch] = 1.0 / ww;
            let c = uniforms.channelColors[ch];
            chColor[ch] = c.rgb * c.a;
            if (c.a > 0.0) { visible |= 1u << ch; }
        }
    }

    // precompute float normalisation
    let floatInvRange = 1.0 / max(uniforms.floatMax - uniforms.floatMin, 0.0001);

    let jitterFrac = rayJitter(rayDir);

    // Windowed, depth-faded maxima: single-channel scalar, multi per channel.
    // Fading before the maximum (depth-weighted MIP) lets nearer structures
    // win over brighter ones deep behind them.
    var maxDensity = 0.0;
    var chMax: array<f32, 6>;
    var t = tStart;
    var tSample = -1.0;

    for (var brickIter = 0u; brickIter < MAX_BRICK_TRAVERSALS; brickIter++) {
        if (t >= tEnd) { break; }

        let brick = setupBrick(rayOrigin, rayDir, invDir, t, tEnd, normalizedSize, datasetSize);

        // Channels whose stored maximum could still raise their running
        // maximum; once none can (even at full intensity, faded to here) the
        // ray is done. The fade only falls along the ray, so the brick's entry
        // bounds it.
        let fadeHere = depthFade(t);
        var mask = 0u;
        var open = false;
        if (NUM_CHANNELS > 1u) {
            for (var ch = 0u; ch < NUM_CHANNELS; ch++) {
                if ((visible & (1u << ch)) == 0u || chMax[ch] >= fadeHere) { continue; }
                open = true;
                if (brick.valid) {
                    let d = clamp((brickMax(brick.slot, ch, floatInvRange) - chLower[ch]) * chInvWidth[ch], 0.0, 1.0);
                    if (d * fadeHere > chMax[ch]) { mask |= 1u << ch; }
                }
            }
        } else {
            open = maxDensity < fadeHere;
            if (brick.valid && applyWindow(brickMax(brick.slot, 0u, floatInvRange), windowCenter, windowWidth) * fadeHere > maxDensity) {
                mask = 1u;
            }
        }
        if (!open) { break; }
        if (mask == 0u) {
            t = nextBrickT(brick);
            continue;
        }

        if (tSample < 0.0) {
            tSample = t + jitterFrac * brick.stepSize;
        } else if (tSample < t) {
            let steps = ceil((t - tSample) / brick.stepSize);
            tSample += steps * brick.stepSize;
        }

        for (var i = 0u; i < brick.numSteps; i++) {
            if (tSample > brick.tEnd) { break; }

            let pos = rayOrigin + rayDir * tSample;
            let voxel = normalizedToVoxel(pos, normalizedSize, datasetSize);
            let fade = depthFade(tSample);

            if (NUM_CHANNELS > 1u) {
                for (var ch = 0u; ch < NUM_CHANNELS; ch++) {
                    if ((mask & (1u << ch)) == 0u) { continue; }
                    let raw = sampleAtlasChAffine(ch, voxel, brick.atlasOffset, brick.atlasScale);
                    let norm = clamp((raw - uniforms.floatMin) * floatInvRange, 0.0, 1.0);
                    let density = clamp((norm - chLower[ch]) * chInvWidth[ch], 0.0, 1.0);
                    chMax[ch] = max(chMax[ch], density * fade);
                }
            } else {
                let rawDensity = sampleAtlasAffine(voxel, brick.atlasOffset, brick.atlasScale);
                let density = clamp((rawDensity - uniforms.floatMin) * floatInvRange, 0.0, 1.0);
                maxDensity = max(maxDensity, applyWindow(density, windowCenter, windowWidth) * fade);
            }

            tSample += brick.stepSize;
        }

        t = nextBrickT(brick);
    }

    if (NUM_CHANNELS > 1u) {
        // Composite per-channel max densities with channel colors
        var rgb = vec3f(0.0);
        var peak = 0.0;
        for (var ch = 0u; ch < NUM_CHANNELS; ch++) {
            if ((visible & (1u << ch)) == 0u) { continue; }
            rgb += chMax[ch] * chColor[ch];
            peak = max(peak, chMax[ch]);
        }
        return vec4f(rgb, peak);
    }

    // Single-channel: TF lookup at the (already windowed) maximum
    let windowedDensity = maxDensity;
    let tfColor = textureSampleLevel(tfTexture, tfSampler, vec2f(windowedDensity, 0.5), 0.0);
    // Premultiplied output: alpha = windowed max density so the compute
    // entry point composites the background correctly.
    return vec4f(tfColor.rgb * windowedDensity, windowedDensity);
}
