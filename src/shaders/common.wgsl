// Common constants and shared functions for volume rendering

const LOGICAL_BRICK_SIZE: f32 = 64.0;
const PHYSICAL_BRICK_SIZE: f32 = 66.0;
const ATLAS_SIZE: f32 = 660.0;
const ATLAS_GRID: u32 = 10u; // atlas slots per axis
const BORDER: f32 = 1.0;
const STEPS_PER_BRICK: f32 = 64.0;
const MAX_BRICK_TRAVERSALS: u32 = 512u;
const LOG2E: f32 = 1.4426950408889634; // pre computed LOG2E

// Lighting constants
const AMBIENT: f32 = 0.3;
const DIFFUSE: f32 = 0.9;
const SPECULAR: f32 = 0.3;
const SHININESS: f32 = 32.0;

// Random number generation
fn hash(n: u32) -> u32 {
    var x = n;
    x = ((x >> 16u) ^ x) * 0x45d9f3bu;
    x = ((x >> 16u) ^ x) * 0x45d9f3bu;
    x = (x >> 16u) ^ x;
    return x;
}

fn rand(seed: u32) -> f32 {
    return f32(hash(seed)) / f32(0xffffffffu);
}

fn rayToSeed(rayDir: vec3f) -> u32 {
    let x = u32((rayDir.x + 1.0) * 32768.0);
    let y = u32((rayDir.y + 1.0) * 32768.0);
    let z = u32((rayDir.z + 1.0) * 32768.0);
    return x + y * 65536u + z * 17u;
}

// Coordinate transformations
fn normalizedToVoxel(normalizedPos: vec3f, normalizedSize: vec3f, datasetSize: vec3f) -> vec3f {
    let unitPos = (normalizedPos / normalizedSize) + 0.5;
    return unitPos * datasetSize;
}

fn voxelToNormalized(voxelPos: vec3f, normalizedSize: vec3f, datasetSize: vec3f) -> vec3f {
    let unitPos = voxelPos / datasetSize;
    return (unitPos - 0.5) * normalizedSize;
}

// Ray-box intersection (invDir = 1 / rayDir); returns (tNear, tFar).
fn intersectBox(rayOrigin: vec3f, invDir: vec3f, boxMin: vec3f, boxMax: vec3f) -> vec2f {
    let t0 = (boxMin - rayOrigin) * invDir;
    let t1 = (boxMax - rayOrigin) * invDir;
    let tmin = min(t0, t1);
    let tmax = max(t0, t1);
    let tNear = max(max(tmin.x, tmin.y), tmin.z);
    let tFar = min(min(tmax.x, tmax.y), tmax.z);
    return vec2f(tNear, tFar);
}

// Phong lighting — lightDir points away from the surface (headlight: pass -rayDir)
fn phongLighting(normal: vec3f, lightDir: vec3f, baseColor: vec3f) -> vec3f {
    let N = normalize(normal);
    let L = normalize(lightDir);
    let V = L;
    let R = reflect(-L, N);
    let ambient = AMBIENT * baseColor;
    let diffuse = DIFFUSE * max(dot(N, L), 0.0) * baseColor;
    let specular = SPECULAR * pow(max(dot(R, V), 0.0), SHININESS) * vec3f(1.0);
    return ambient + diffuse + specular;
}

// Window/Level: remap a density sub-range to [0,1] for contrast adjustment.
fn applyWindow(density: f32, windowCenter: f32, windowWidth: f32) -> f32 {
    let minVal = windowCenter - windowWidth * 0.5;
    return clamp((density - minVal) / max(windowWidth, 0.001), 0.0, 1.0);
}
