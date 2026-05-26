// Direct Volume Rendering (DVR) - Front-to-back compositing with windowing

fn rayMarchDVR(
    rayOrigin: vec3f, rayDir: vec3f, tStart: f32, tEnd: f32,
    normalizedSize: vec3f, datasetSize: vec3f
) -> vec4f {
    let maxDim = max(datasetSize.x, max(datasetSize.y, datasetSize.z));
    let invDir = 1.0 / rayDir;

    // Get windowing parameters from uniforms
    let windowCenter = uniforms.windowCenter;
    let windowWidth = uniforms.windowWidth;

    var color = vec3f(0.0);
    var alpha = 0.0;
    var t = tStart;
    var tSample = -1.0;  // sentinel: not yet initialized
    var rayStepSize = 0.0;

    for (var brickIter = 0u; brickIter < MAX_BRICK_TRAVERSALS; brickIter++) {
        if (t >= tEnd) { break; }
        if (alpha > EARLY_EXIT_ALPHA) { break; }

        let brick = setupBrick(rayOrigin, rayDir, invDir, t, tEnd, normalizedSize, datasetSize);

        if (!brick.valid) {
            t = brick.tEnd + 0.0001;
            // Advance tSample past the invalid brick if needed
            if (tSample >= 0.0 && tSample < t) { tSample = t; }
            continue;
        }

        // Apply jitter once for the whole ray on the first valid brick
        if (tSample < 0.0) {
            rayStepSize = brick.stepSize;
            tSample = t + rand(rayToSeed(rayDir) + uniforms.frameIndex) * rayStepSize;
        }

        for (var i = 0u; i < brick.numSteps; i++) {
            if (tSample > brick.tEnd) { break; }

            let pos = rayOrigin + rayDir * tSample;
            let voxel = normalizedToVoxel(pos, normalizedSize, datasetSize);
            let rawDensity = sampleAtlas(voxel, brick.indirection, brick.lodScale);
            let density = clamp((rawDensity - uniforms.floatMin) / max(uniforms.floatMax - uniforms.floatMin, 0.0001), 0.0, 1.0);

            composeSampleWindowed(density, rayStepSize * uniforms.densityScale, maxDim, windowCenter, windowWidth, &color, &alpha);
            if (alpha > EARLY_EXIT_ALPHA) { break; }

            tSample += rayStepSize;
        }

        t = brick.tEnd + 0.0001;
    }

    return vec4f(color, alpha);
}
