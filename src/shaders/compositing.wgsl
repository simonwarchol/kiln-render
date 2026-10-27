// Volume compositing functions (front-to-back blending)

// Compose a sample using transfer function lookup with windowing; `fade`
// scales its emission (depth cue), not its opacity.
fn composeSampleWindowed(density: f32, extinctionScale: f32, windowCenter: f32, windowWidth: f32, fade: f32, color: ptr<function, vec3f>, alpha: ptr<function, f32>) {
    // Apply windowing to remap density to visible range
    let windowedDensity = applyWindow(density, windowCenter, windowWidth);

    if (windowedDensity > 0.01) {
        // Sample 2D transfer function (256x1 texture) - use vec2f(coord, 0.5) for Safari compatibility
        let tfColor = textureSampleLevel(tfTexture, tfSampler, vec2f(windowedDensity, 0.5), 0.0);
        let sampleAlpha = 1.0 - exp2(-tfColor.a * extinctionScale);
        *color += tfColor.rgb * fade * sampleAlpha * (1.0 - *alpha);
        *alpha += sampleAlpha * (1.0 - *alpha);
    }
}

// Compose a multi-channel additive sample (no TF — each channel has its own color/weight)
// channelColor: pre-weighted sum of per-channel colors * densities
// maxDensity: max across all channels (drives absorption)
fn composeSampleAdditive(channelColor: vec3f, maxDensity: f32, extinctionScale: f32, color: ptr<function, vec3f>, alpha: ptr<function, f32>) {
    if (maxDensity > 0.01) {
        let sampleAlpha = 1.0 - exp2(-maxDensity * extinctionScale);
        let normColor = channelColor / maxDensity; // normalise to avoid over-brightening
        *color += normColor * sampleAlpha * (1.0 - *alpha);
        *alpha += sampleAlpha * (1.0 - *alpha);
    }
}
