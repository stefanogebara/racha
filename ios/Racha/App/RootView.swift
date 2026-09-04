import SwiftUI

/// Timeline and thread, as one surface.
///
/// The brief asked for zooming in and out to be "one continuous fluid gesture,
/// not a screen push". So it is literally one view hierarchy driven by
/// `Navigator.zoom`:
///
/// - the timeline scales up and fades out as `zoom` rises;
/// - the thread scales in from the card's frame, via `matchedGeometryEffect`;
/// - the `zoomMorph` distortion peaks at 0.5 and vanishes at both ends, so
///   neither resting state is ever warped;
/// - a downward drag from the top of a thread *drives* `zoom` directly, and
///   releasing it either completes or springs back based on velocity.
///
/// The result: you can catch the transition halfway and change your mind, which
/// is what makes a gesture feel like a material and not like a button.
struct RootView: View {
    @Environment(Navigator.self) private var navigator
    @Environment(RachaRepository.self) private var repository
    @Namespace private var namespace

    @State private var burstProgress: Double = 0

    var body: some View {
        @Bindable var nav = navigator

        ZStack {
            WarmGroundBackground()

            TimelineView(namespace: namespace)
                .scaleEffect(1 + navigator.zoom * 0.34, anchor: .center)
                .opacity(1 - navigator.zoom * 1.45)
                .blur(radius: navigator.zoom * 9)
                .allowsHitTesting(navigator.zoom < 0.15)

            if let id = navigator.focused, let state = repository.state(id) {
                ThreadView(rachaID: id, namespace: namespace)
                    .scaleEffect(0.86 + navigator.zoom * 0.14, anchor: .center)
                    .opacity(max(0, navigator.zoom * 1.6 - 0.35))
                    .allowsHitTesting(navigator.zoom > 0.85)
                    .modifier(ZoomMorphModifier(progress: navigator.zoom))
                    .gesture(dismissDrag)
                    .id(state.id)
            }
        }
        .modifier(BurstModifier(progress: burstProgress,
                                origin: navigator.burst?.origin ?? .zero))
        .onChange(of: navigator.burst?.startedAt) { _, new in
            guard new != nil else { burstProgress = 0; return }
            burstProgress = 0.001
            withAnimation(.easeOut(duration: 1.1)) { burstProgress = 1 }
        }
        .statusBarHidden(navigator.zoom > 0.9 && false)
    }

    /// Drag down from the thread to zoom back out.
    ///
    /// Resistance rises as the drag continues (`pow(0.82)`), which is what makes
    /// the sheet feel attached to something rather than free. Release completes on
    /// distance *or* velocity — a quick flick works even from 20pt, which is what
    /// a thumb actually does.
    private var dismissDrag: some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .global)
            .onChanged { value in
                guard value.translation.height > 0 else { return }
                navigator.isDragging = true
                let progress = min(1, value.translation.height / 420)
                navigator.zoom = 1 - pow(progress, 0.82)
            }
            .onEnded { value in
                navigator.isDragging = false
                let flicked = value.predictedEndTranslation.height > 260
                let dragged = value.translation.height > 150
                if flicked || dragged {
                    Haptics.shared.press()
                    navigator.close()
                } else {
                    withAnimation(Motion.zoom) { navigator.zoom = 1 }
                }
            }
    }
}

private struct ZoomMorphModifier: ViewModifier {
    let progress: Double
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        // Only warp while in flight. At rest this modifier costs nothing.
        if reduceMotion || progress <= 0.02 || progress >= 0.98 {
            content
        } else {
            content.visualEffect { view, proxy in
                view.distortionEffect(
                    RachaShader.zoomMorph(size: proxy.size, progress: progress, bulge: 0.30),
                    maxSampleOffset: CGSize(width: 60, height: 60))
            }
        }
    }
}

private struct BurstModifier: ViewModifier {
    let progress: Double
    let origin: CGPoint
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        if progress <= 0 || progress >= 1 || reduceMotion {
            content
        } else {
            content.visualEffect { view, proxy in
                view.layerEffect(
                    RachaShader.settledBurst(size: proxy.size, origin: origin, progress: progress),
                    maxSampleOffset: CGSize(width: 40, height: 40))
            }
        }
    }
}
