//
//  Racha.metal — the app's custom visual language.
//
//  Every function here is a SwiftUI shader entry point, reached through
//  `ShaderLibrary.<name>` and applied with `.colorEffect`, `.distortionEffect`,
//  `.layerEffect` or `.visualEffect`. The SwiftUI shader ABI matters:
//
//    colorEffect      → [[stitchable]] half4 f(float2 position, half4 color, ...)
//    distortionEffect → [[stitchable]] float2 f(float2 position, ...)
//    layerEffect      → [[stitchable]] half4 f(float2 position, SwiftUI::Layer layer, ...)
//
//  `position` is in *user space* (points), not UV, so almost every function takes
//  the view size and normalises itself. Extra arguments are bound positionally
//  from the Swift call site — keep the orders in sync with ShaderLibrary+Racha.swift.
//

#include <metal_stdlib>
#include <SwiftUI/SwiftUI_Metal.h>
using namespace metal;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Hash without sin(): sin-based hashes band badly on Apple GPUs at high
// coordinates, and the banding shows up as visible stripes in the grain pass.
static inline float hash21(float2 p) {
    float3 p3 = fract(float3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

static inline float2 hash22(float2 p) {
    float3 p3 = fract(float3(p.xyx) * float3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}

// Value noise, quintic-smoothed. Cheap and smooth enough for background motion;
// gradient noise would cost more than it shows at these amplitudes.
static inline float valueNoise(float2 p) {
    float2 i = floor(p);
    float2 f = fract(p);
    float2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float a = hash21(i);
    float b = hash21(i + float2(1.0, 0.0));
    float c = hash21(i + float2(0.0, 1.0));
    float d = hash21(i + float2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

static inline float fbm(float2 p) {
    float sum = 0.0, amp = 0.5;
    for (int i = 0; i < 4; ++i) {
        sum += amp * valueNoise(p);
        p *= 2.03;          // non-integer lacunarity avoids self-similar tiling
        amp *= 0.5;
    }
    return sum;
}

static inline float sdRoundedBox(float2 p, float2 halfSize, float radius) {
    float2 q = abs(p) - halfSize + radius;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

// ---------------------------------------------------------------------------
// 1. Warm ground — the four-orb gradient from the web app, alive.
// ---------------------------------------------------------------------------
//
// The web version is four static CSS radial-gradients. Here they breathe: each
// orb drifts on its own low-frequency noise path, and the whole field is
// dithered so the wide, low-contrast falloffs don't band on an OLED panel.
// The motion is deliberately below the threshold of "animation" — you notice it
// only if you stare, which is the point of a background.
//
// args: size, time, intensity
[[stitchable]] half4 warmGround(float2 position, half4 color,
                                float2 size, float time, float intensity) {
    float2 uv = position / size;
    float aspect = size.x / max(size.y, 1.0);

    const float3 base = float3(0.980, 0.980, 0.976);   // #FAFAF9

    const float2 centers[4] = { float2(0.12, 0.18), float2(0.88, 0.22),
                                float2(0.50, 0.95), float2(0.90, 0.80) };
    const float2 radii[4]   = { float2(0.65, 0.45), float2(0.55, 0.40),
                                float2(0.75, 0.50), float2(0.45, 0.35) };
    const float4 tints[4]   = { float4(0.851, 0.467, 0.024, 0.18),
                                float4(0.961, 0.620, 0.043, 0.15),
                                float4(0.624, 0.071, 0.224, 0.12),
                                float4(0.471, 0.208, 0.059, 0.10) };

    float3 accum = base;
    for (int i = 0; i < 4; ++i) {
        float phase = float(i) * 1.7;
        float2 drift = float2(fbm(float2(time * 0.045 + phase, phase)),
                              fbm(float2(phase, time * 0.038 + phase))) - 0.5;
        float2 c = centers[i] + drift * 0.055;
        float2 d = (uv - c) / radii[i];
        d.x *= mix(1.0, aspect, 0.35);                 // keep orbs from ovalising on wide layouts
        float falloff = 1.0 - smoothstep(0.0, 1.0, length(d));
        falloff *= falloff;                            // matches CSS's perceptual falloff better than linear
        accum = mix(accum, tints[i].rgb, falloff * tints[i].a * intensity);
    }

    // Ordered dither at ±1/255. Without it the orbs band in visible rings.
    float dither = (hash21(position) - 0.5) / 255.0;
    accum += dither;

    return half4(half3(accum), 1.0h) * color.a;
}

// ---------------------------------------------------------------------------
// 2. Liquid glass — refraction, edge light, and specular sweep on a card.
// ---------------------------------------------------------------------------
//
// Apple's own glass sells the illusion with three cues, and all three are here:
// content behind the surface is *displaced* near the edges (refraction), the rim
// picks up a bright line where it catches light, and a slow specular band travels
// across as the device tilts.
//
// This is a layerEffect because it needs to sample the layer at a displaced
// coordinate — a colorEffect only ever sees its own pixel and physically cannot
// refract.
//
// args: size, cornerRadius, tiltX, tiltY, time, strength
[[stitchable]] half4 liquidGlass(float2 position, SwiftUI::Layer layer,
                                 float2 size, float cornerRadius,
                                 float tiltX, float tiltY, float time, float strength) {
    float2 center = size * 0.5;
    float2 p = position - center;
    float d = sdRoundedBox(p, center, cornerRadius);

    // Outside the rounded rect: nothing. The clip shape is the shader's, so the
    // card's corners are mathematically exact rather than an antialiased mask.
    if (d > 0.0) return half4(0.0h);

    // Refraction: displace toward the nearest edge, strongest in the last ~14pt.
    // The gradient of the SDF is the edge normal, obtained by central differences.
    const float eps = 1.0;
    float2 normal = normalize(float2(
        sdRoundedBox(p + float2(eps, 0.0), center, cornerRadius) - sdRoundedBox(p - float2(eps, 0.0), center, cornerRadius),
        sdRoundedBox(p + float2(0.0, eps), center, cornerRadius) - sdRoundedBox(p - float2(0.0, eps), center, cornerRadius)
    ) + 1e-6);

    float edge = 1.0 - saturate(-d / 14.0);
    float bend = edge * edge * edge;                  // cubic: flat in the middle, sharp at the rim
    float2 refracted = position - normal * bend * 9.0 * strength;

    half4 sampled = layer.sample(refracted);

    // Chromatic split at the very edge only — a hair of dispersion reads as real
    // glass; applied across the whole card it just reads as a broken screen.
    if (bend > 0.35) {
        half r = layer.sample(position - normal * bend * 10.6 * strength).r;
        half b = layer.sample(position - normal * bend * 7.4 * strength).b;
        sampled.r = mix(sampled.r, r, half(bend) * 0.7h);
        sampled.b = mix(sampled.b, b, half(bend) * 0.7h);
    }

    // Rim light: a thin bright line whose brightness depends on how the tilt
    // vector meets the edge normal, so the highlight travels around the card as
    // the phone moves.
    float2 light = normalize(float2(tiltX, tiltY - 0.6) + 1e-6);
    float facing = saturate(dot(normal, light) * 0.5 + 0.5);
    float rim = smoothstep(2.2, 0.0, -d) * facing;
    sampled.rgb += half3(rim * 0.55 * strength);

    // Specular sweep: one soft band crossing on the diagonal, slow.
    float sweep = sin((position.x + position.y) * 0.006 - time * 0.55 + tiltX * 2.0);
    float band = smoothstep(0.86, 1.0, sweep) * (1.0 - bend) * 0.16 * strength;
    sampled.rgb += half3(band);

    // Interior lift so the surface reads as translucent white, not clear.
    sampled.rgb = mix(sampled.rgb, half3(1.0h), half(0.10 * strength));
    return sampled;
}

// ---------------------------------------------------------------------------
// 3. Image resolve — how a generated dish photo arrives.
// ---------------------------------------------------------------------------
//
// A generated image that just fades in tells you nothing. This *develops*: it
// starts as a warm cloud of noise in the plate's own colours, then resolution
// sweeps across on a diagonal wavefront, with a bright caustic line riding the
// boundary. It reads as the picture condensing out of the paper.
//
// `progress` 0→1. At 1 the shader is a pass-through, so it can stay attached
// with no cost in the finished state.
//
// args: size, progress, time, seed
[[stitchable]] half4 imageResolve(float2 position, SwiftUI::Layer layer,
                                  float2 size, float progress, float time, float seed) {
    if (progress >= 0.999) return layer.sample(position);

    float2 uv = position / size;
    // Diagonal wavefront, softened by noise so the boundary is organic rather
    // than a ruler line.
    float front = (uv.x * 0.55 + uv.y * 0.45);
    float wobble = fbm(uv * 3.2 + seed) * 0.22;
    float local = saturate((progress * 1.45 - (front + wobble)) * 3.2);

    // Not-yet-resolved region: heavy displacement + desaturated haze.
    float2 scatter = (hash22(position * 0.35 + seed + time * 0.06) - 0.5);
    float turbulence = (1.0 - local) * 26.0;
    half4 blurred = layer.sample(position + scatter * turbulence);

    // Sample a few neighbours to fake a cheap bokeh in the unresolved area.
    if (local < 0.85) {
        for (int i = 1; i < 4; ++i) {
            float a = float(i) * 2.399963;            // golden angle: even coverage in few taps
            float2 offset = float2(cos(a), sin(a)) * turbulence * 0.7;
            blurred += layer.sample(position + offset);
        }
        blurred *= 0.25h;
    }

    half4 sharp = layer.sample(position);
    half4 mixed = mix(blurred, sharp, half(local));

    // Warm the unresolved half toward the app's amber, so the loading state is
    // still on-brand rather than grey mush.
    half3 warm = half3(0.96h, 0.78h, 0.42h);
    mixed.rgb = mix(mixed.rgb * 0.92h + warm * 0.18h, mixed.rgb, half(local));

    // Caustic line riding the wavefront.
    float band = exp(-pow((local - 0.5) * 5.0, 2.0)) * (1.0 - progress * 0.5);
    mixed.rgb += half3(band * 0.42);

    // Grain that fades out as it resolves — film developing, not a JPEG loading.
    float grain = (hash21(position + floor(time * 24.0)) - 0.5) * (1.0 - local) * 0.16;
    mixed.rgb += half3(grain);

    mixed.a *= half(saturate(progress * 3.0));
    return mixed;
}

// ---------------------------------------------------------------------------
// 4. Token stream — the agent's text arriving.
// ---------------------------------------------------------------------------
//
// Applied to the streaming text layer. Freshly-arrived glyphs sit inside a warm
// leading edge that decays behind the cursor: characters materialise with a
// slight vertical settle and a burgundy-to-charcoal colour resolve. The effect
// is anchored to `head` (the x/y of the last glyph in points), so it tracks
// wrapped text correctly instead of assuming one line.
//
// args: size, headX, headY, lineHeight, time, intensity
[[stitchable]] half4 tokenStream(float2 position, SwiftUI::Layer layer,
                                 float2 size, float headX, float headY,
                                 float lineHeight, float time, float intensity) {
    half4 src = layer.sample(position);
    if (src.a < 0.01h || intensity < 0.001) return src;

    // Distance behind the write head, measured along reading order: a glyph two
    // lines up is "older" than one just before the head on the same line.
    float lineDelta = (headY - position.y) / max(lineHeight, 1.0);
    float sameLineDelta = (headX - position.x) / max(size.x, 1.0);
    float age = lineDelta + saturate(sameLineDelta) * 0.35;

    // Only the last ~1.6 lines are "fresh".
    float fresh = saturate(1.0 - age / 1.6);
    if (fresh <= 0.001) return src;

    float f = fresh * fresh * intensity;

    // Warm the fresh glyphs toward burgundy, cooling to charcoal as they age.
    const half3 hot = half3(0.624h, 0.071h, 0.224h);
    src.rgb = mix(src.rgb, hot, half(f * 0.55));

    // A soft glow that follows the head itself.
    float2 toHead = (position - float2(headX, headY)) / max(lineHeight, 1.0);
    float halo = exp(-dot(toHead, toHead) * 0.55);
    src.rgb += half3(halo * 0.25 * intensity);
    src.a = min(1.0h, src.a + half(halo * 0.10 * intensity));

    // Micro-shimmer on the leading edge, at a frequency that survives the glyph
    // grid without moiréing against it.
    float shimmer = sin(position.x * 0.35 - time * 7.0) * 0.5 + 0.5;
    src.rgb += half3(shimmer * f * 0.06);

    return src;
}

// ---------------------------------------------------------------------------
// 5. Settled burst — the moment a racha closes.
// ---------------------------------------------------------------------------
//
// The brief asked for this to feel like a small event, so it is a real one: an
// emerald shockwave expands from the tap point, distorting what it crosses, with
// a ring of sparks and a lingering bloom. It runs once, ~1.1s, then the modifier
// is removed.
//
// args: size, originX, originY, progress
[[stitchable]] half4 settledBurst(float2 position, SwiftUI::Layer layer,
                                  float2 size, float originX, float originY, float progress) {
    if (progress <= 0.0 || progress >= 1.0) return layer.sample(position);

    float2 origin = float2(originX, originY);
    float2 delta = position - origin;
    float dist = length(delta);
    float2 dir = delta / max(dist, 1e-4);

    float maxRadius = length(size) * 0.85;
    float radius = progress * maxRadius;

    // Shockwave: a narrow annulus that pushes pixels outward as it passes.
    float thickness = 46.0 * (1.0 - progress * 0.55);
    float ring = exp(-pow((dist - radius) / thickness, 2.0));
    float push = ring * 16.0 * (1.0 - progress);
    half4 c = layer.sample(position - dir * push);

    // Emerald tint on the wave itself, brightest at the crest.
    const half3 emerald = half3(0.063h, 0.725h, 0.506h);
    c.rgb = mix(c.rgb, emerald, half(ring * 0.55 * (1.0 - progress * 0.4)));
    c.rgb += half3(ring * 0.35 * (1.0 - progress));

    // Sparks: 24 points on the ring, each with its own jitter, fading out.
    float angle = atan2(delta.y, delta.x);
    float sparkIndex = floor((angle + M_PI_F) / (2.0 * M_PI_F) * 24.0);
    float2 jitter = hash22(float2(sparkIndex, 7.0));
    float sparkRadius = radius * (0.86 + jitter.x * 0.30);
    float sparkArc = fract((angle + M_PI_F) / (2.0 * M_PI_F) * 24.0);
    float sparkNear = exp(-pow((dist - sparkRadius) / 7.0, 2.0))
                    * exp(-pow((sparkArc - 0.5) / 0.16, 2.0));
    c.rgb += emerald * half(sparkNear * (1.0 - progress) * 1.4);

    // Interior bloom that lifts everything inside the wave, then releases.
    float inside = smoothstep(radius, radius - 120.0, dist);
    c.rgb += emerald * half(inside * 0.10 * (1.0 - progress));

    return c;
}

// ---------------------------------------------------------------------------
// 6. Zoom morph — timeline card ⇄ thread, as one continuous surface.
// ---------------------------------------------------------------------------
//
// The brief: "zooming in and out should be one continuous fluid gesture, not a
// screen push." The geometry is a matched-geometry transition; this shader adds
// the *material* half — while the card is in flight it bulges very slightly
// (like a drop of liquid under tension) and its edges soften, so the two states
// feel like one thing changing shape rather than two things cross-fading.
//
// args: size, progress (0 = card, 1 = full thread), bulge
[[stitchable]] float2 zoomMorph(float2 position, float2 size, float progress, float bulge) {
    float2 uv = position / size - 0.5;
    float r = length(uv);

    // Tension peaks mid-flight and vanishes at both ends, so neither resting
    // state is ever distorted.
    float tension = sin(progress * M_PI_F);
    float k = bulge * tension;

    // Barrel distortion, radius-dependent, with a falloff that keeps the centre
    // (where text lives) nearly untouched.
    float scale = 1.0 + k * (r * r) * 0.55;
    float2 warped = uv * scale;

    // A whisper of rotation adds the sense of a physical object turning into
    // place; far too small to read as a spin.
    float a = k * 0.045;
    float s = sin(a), c = cos(a);
    warped = float2(warped.x * c - warped.y * s, warped.x * s + warped.y * c);

    return (warped + 0.5) * size;
}

// ---------------------------------------------------------------------------
// 7. Progress liquid — the "quanto falta" bar, as a filling vessel.
// ---------------------------------------------------------------------------
//
// A flat bar states a number. This one has a surface: the fill has a meniscus
// that slops when the value changes, and the body has slow internal motion. In a
// loud bar it is readable at a glance from the shape alone.
//
// args: size, fill (0..1), time, energy
[[stitchable]] half4 progressLiquid(float2 position, half4 color,
                                    float2 size, float fill, float time, float energy) {
    float2 uv = position / size;

    // Meniscus: two out-of-phase waves so it never looks like a single sine.
    float wave = sin(uv.x * 9.0 - time * 2.1) * 0.5
               + sin(uv.x * 15.0 + time * 1.3) * 0.28;
    float surface = fill + wave * 0.10 * energy * smoothstep(0.0, 0.06, fill) * smoothstep(1.0, 0.94, fill);

    float inside = smoothstep(surface + 0.02, surface - 0.02, uv.x);
    if (inside <= 0.001) {
        return half4(half3(0.11h, 0.10h, 0.09h), 0.08h) * color.a;
    }

    const half3 emerald = half3(0.063h, 0.725h, 0.506h);
    const half3 deep    = half3(0.020h, 0.588h, 0.412h);

    // Internal currents, so the filled body is alive rather than a flat swatch.
    float current = fbm(float2(uv.x * 4.0 - time * 0.35, uv.y * 3.0));
    half3 body = mix(deep, emerald, half(current * 0.6 + 0.4));

    // Bright meniscus line right at the surface.
    float lip = exp(-pow((uv.x - surface) * 60.0, 2.0));
    body += half3(lip * 0.5);

    return half4(body, half(inside)) * color.a;
}

// ---------------------------------------------------------------------------
// 8. Paper grain — the shared texture that ties every surface together.
// ---------------------------------------------------------------------------
//
// One very low-amplitude grain over the whole app. Individually invisible;
// collectively it is most of the reason the flat colours read as material rather
// than as sRGB values. Static (no `time`) — animated grain reads as video noise
// and costs battery for nothing.
//
// args: size, amount
[[stitchable]] half4 paperGrain(float2 position, half4 color, float2 size, float amount) {
    float g = hash21(position * 1.7) - 0.5;
    float fibre = (valueNoise(position * 0.09) - 0.5) * 0.6;   // long-wavelength paper fibre
    half3 tinted = color.rgb + half3((g * 0.6 + fibre) * amount);
    return half4(tinted, color.a);
}

// ---------------------------------------------------------------------------
// 9. Pressable — the material response to a finger.
// ---------------------------------------------------------------------------
//
// Every tappable surface compresses slightly *toward the touch point* rather
// than uniformly, which is what a soft physical object does. Uniform scaling is
// the tell of a digital button.
//
// args: size, touchX, touchY, press (0..1)
[[stitchable]] float2 pressable(float2 position, float2 size,
                                float touchX, float touchY, float press) {
    if (press <= 0.001) return position;
    float2 touch = float2(touchX, touchY);
    float2 delta = position - touch;
    float d = length(delta) / max(length(size) * 0.5, 1.0);
    float pull = press * 0.055 * (1.0 - smoothstep(0.0, 1.3, d));
    return position - delta * pull;
}
