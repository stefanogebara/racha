import SwiftUI

/// Swift-side bindings for `Racha.metal`.
///
/// Argument order here must match the Metal signatures exactly — the SwiftUI
/// shader ABI binds positionally with no name checking, so a swapped pair fails
/// silently as a wrong-looking effect rather than a compile error. Every wrapper
/// below is the single call site for its shader, which keeps that risk in one
/// reviewable place.
enum RachaShader {

    static func paperGround(size: CGSize, time: Double, warmth: Double = 1) -> Shader {
        ShaderLibrary.paperGround(
            .float2(size), .float(time), .float(warmth)
        )
    }

    static func liquidGlass(size: CGSize, cornerRadius: CGFloat,
                            tilt: CGPoint, time: Double, strength: Double) -> Shader {
        ShaderLibrary.liquidGlass(
            .float2(size), .float(cornerRadius),
            .float(tilt.x), .float(tilt.y), .float(time), .float(strength)
        )
    }

    static func imageResolve(size: CGSize, progress: Double, time: Double, seed: Double) -> Shader {
        ShaderLibrary.imageResolve(
            .float2(size), .float(progress), .float(time), .float(seed)
        )
    }

    static func tokenStream(size: CGSize, head: CGPoint, lineHeight: CGFloat,
                            time: Double, intensity: Double) -> Shader {
        ShaderLibrary.tokenStream(
            .float2(size), .float(head.x), .float(head.y),
            .float(lineHeight), .float(time), .float(intensity)
        )
    }

    static func settledBurst(size: CGSize, origin: CGPoint, progress: Double) -> Shader {
        ShaderLibrary.settledBurst(
            .float2(size), .float(origin.x), .float(origin.y), .float(progress)
        )
    }

    static func zoomMorph(size: CGSize, progress: Double, bulge: Double) -> Shader {
        ShaderLibrary.zoomMorph(.float2(size), .float(progress), .float(bulge))
    }

    static func progressLiquid(size: CGSize, fill: Double, time: Double, energy: Double) -> Shader {
        ShaderLibrary.progressLiquid(
            .float2(size), .float(fill), .float(time), .float(energy)
        )
    }

    static func paperGrain(size: CGSize, amount: Double) -> Shader {
        ShaderLibrary.paperGrain(.float2(size), .float(amount))
    }

    static func pressable(size: CGSize, touch: CGPoint, press: Double) -> Shader {
        ShaderLibrary.pressable(.float2(size), .float(touch.x), .float(touch.y), .float(press))
    }
}

// MARK: - View modifiers

/// A single shared clock.
///
/// Several shaders animate, and giving each its own `TimelineView` would mean
/// several independent redraw loops at 120Hz. One clock, published once, means
/// one pass — which on a phone at 15% battery is the difference between the
/// effects being a feature and being a liability.
@MainActor
@Observable
final class ShaderClock {
    private(set) var time: Double = 0
    private var displayLink: CADisplayLink?
    private var start: CFTimeInterval = CACurrentMediaTime()
    /// Views that want animation register here; at zero the link is torn down.
    private var subscribers = 0

    static let shared = ShaderClock()

    func subscribe() {
        subscribers += 1
        guard displayLink == nil else { return }
        let link = CADisplayLink(target: DisplayLinkProxy { [weak self] in self?.tick() },
                                 selector: #selector(DisplayLinkProxy.fire))
        // Ambient motion does not need 120Hz. Half rate is invisible here and
        // halves the GPU cost of the background.
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 20, maximum: 60, preferred: 30)
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    func unsubscribe() {
        // `max(0, …)` keeps an over-release from going negative, but it cannot
        // undo the damage: one extra unsubscribe tears the link down for every
        // other view still animating. The callers own a single `subscribed`
        // flag each (see `ClockSubscription`) so subscribe and unsubscribe are
        // always paired.
        subscribers = max(0, subscribers - 1)
        guard subscribers == 0 else { return }
        displayLink?.invalidate()
        displayLink = nil
        time = 0
    }

    /// How many views are asking for frames. Debug/diagnostic only.
    var subscriberCount: Int { subscribers }

    private func tick() { time = CACurrentMediaTime() - start }
}

/// One view's hold on the clock, which can only be taken once and given back
/// once no matter how the view's lifecycle actually plays out.
///
/// The bug this exists to prevent was live: `StreamingText` subscribed in
/// `onAppear` when `isStreaming` and unsubscribed in `onDisappear` when
/// `intensity > 0` — two different conditions. A bubble that appeared while
/// streaming and scrolled away cold leaked a subscriber, so the display link
/// ran at 30fps for the rest of the session; the mirror case released a hold it
/// never took and froze the animation for every other view on screen.
@MainActor
final class ClockSubscription {
    private var held = false

    func want(_ wanted: Bool) {
        guard wanted != held else { return }
        held = wanted
        if wanted { ShaderClock.shared.subscribe() } else { ShaderClock.shared.unsubscribe() }
    }

    deinit {
        // A view can vanish without `onDisappear` (a sheet dismissed while
        // scrolling, an app backgrounded mid-transition). The hold still ends.
        if held { Task { @MainActor in ShaderClock.shared.unsubscribe() } }
    }
}

/// CADisplayLink needs an ObjC target; this keeps the retain cycle out of the clock.
private final class DisplayLinkProxy: NSObject {
    private let handler: () -> Void
    init(_ handler: @escaping () -> Void) { self.handler = handler }
    @objc func fire() { handler() }
}

/// The app's ground.
///
/// Static, and deliberately so. The old version animated four colour orbs on a
/// shared clock; drawing paper does not need a clock at all, which means the
/// background now costs one GPU pass at layout and nothing per frame. On a
/// phone at 15% battery that is the correct trade, and the page looks more
/// expensive for it, not less.
struct PaperBackground: View {
    var body: some View {
        GeometryReader { geo in
            Rectangle()
                .fill(Palette.paper)
                .colorEffect(RachaShader.paperGround(size: geo.size, time: 0, warmth: 1.0))
                .colorEffect(RachaShader.paperGrain(size: geo.size, amount: 0.012))
                .drawingGroup()          // rasterise once; it never changes
                .ignoresSafeArea()
        }
        .ignoresSafeArea()
    }
}

extension View {
    /// Glass surface with real refraction. `tilt` comes from the motion manager, so
    /// the highlight tracks the phone.
    func liquidGlass(cornerRadius: CGFloat = 20, tilt: CGPoint = .zero,
                     strength: Double = 1.0, time: Double = 0) -> some View {
        modifier(LiquidGlassModifier(cornerRadius: cornerRadius, tilt: tilt,
                                     strength: strength, time: time))
    }

    /// Compresses toward the touch. See `pressable` in the Metal source.
    func pressResponse(_ press: Double, at touch: CGPoint) -> some View {
        modifier(PressResponseModifier(press: press, touch: touch))
    }
}

private struct LiquidGlassModifier: ViewModifier {
    let cornerRadius: CGFloat
    let tilt: CGPoint
    let strength: Double
    let time: Double

    func body(content: Content) -> some View {
        content.visualEffect { view, proxy in
            view.layerEffect(
                RachaShader.liquidGlass(size: proxy.size, cornerRadius: cornerRadius,
                                        tilt: tilt, time: time, strength: strength),
                maxSampleOffset: CGSize(width: 16, height: 16)
            )
        }
    }
}

private struct PressResponseModifier: ViewModifier {
    let press: Double
    let touch: CGPoint

    func body(content: Content) -> some View {
        content.visualEffect { view, proxy in
            view.distortionEffect(
                RachaShader.pressable(size: proxy.size, touch: touch, press: press),
                maxSampleOffset: CGSize(width: 24, height: 24)
            )
        }
    }
}
