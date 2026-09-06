import SwiftUI

/// Text that arrives.
///
/// Two things make this different from a `Text` that grows:
///
/// 1. **The write head is measured, not guessed.** `TextRenderer` walks the laid
///    out glyph runs and reports where the last one actually sits, so the shader's
///    warm leading edge tracks wrapped text across lines instead of assuming a
///    single line. This is why the effect still looks right on a four-line answer.
/// 2. **The tail settles.** Freshly-arrived glyphs enter with a small vertical
///    offset and a blur that resolves over ~180ms, so the text lands rather than
///    appears. That, plus the shader's warmth decay, is the whole "token stream"
///    feel — no typewriter cursor, no fake per-character timer.
struct StreamingText: View {
    var text: String
    var isStreaming: Bool

    @State private var clock = ShaderClock.shared
    @State private var head: CGPoint = .zero
    @State private var lineHeight: CGFloat = 20
    @State private var intensity: Double = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Text(text)
            .font(Typo.body)
            .foregroundStyle(Palette.charcoal)
            .lineSpacing(3)
            .textRenderer(WriteHeadRenderer(isStreaming: isStreaming && !reduceMotion) { point, height in
                // Written from the renderer during layout; a plain assignment here
                // would fight SwiftUI's update cycle.
                Task { @MainActor in
                    head = point
                    lineHeight = height
                }
            })
            .modifier(TokenStreamModifier(head: head, lineHeight: lineHeight,
                                          time: clock.time, intensity: intensity))
            .onAppear { if isStreaming && !reduceMotion { clock.subscribe() } }
            .onDisappear { if intensity > 0 { clock.unsubscribe() } }
            .onChange(of: isStreaming) { _, streaming in
                guard !reduceMotion else { return }
                if streaming {
                    clock.subscribe()
                    withAnimation(.easeOut(duration: 0.2)) { intensity = 1 }
                } else {
                    // Decay rather than cut: the last words should cool down, not
                    // snap from warm to black.
                    withAnimation(.easeInOut(duration: 0.5)) { intensity = 0 }
                    Task {
                        try? await Task.sleep(for: .seconds(0.55))
                        clock.unsubscribe()
                    }
                }
            }
            .accessibilityLabel(text)
    }
}

private struct TokenStreamModifier: ViewModifier {
    let head: CGPoint
    let lineHeight: CGFloat
    let time: Double
    let intensity: Double

    func body(content: Content) -> some View {
        if intensity <= 0.001 {
            content
        } else {
            content.visualEffect { view, proxy in
                view.layerEffect(
                    RachaShader.tokenStream(size: proxy.size, head: head,
                                            lineHeight: lineHeight,
                                            time: time, intensity: intensity),
                    maxSampleOffset: .zero)
            }
        }
    }
}

/// Draws the text and reports where the last glyph landed.
///
/// `TextRenderer` gives access to the laid-out lines and runs, which is the only
/// way to know the write head's position without re-implementing line breaking.
/// It also gives the per-run hook used to settle the tail.
struct WriteHeadRenderer: TextRenderer {
    var isStreaming: Bool
    var report: (CGPoint, CGFloat) -> Void

    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        var lastOrigin = CGPoint.zero
        var measuredLineHeight: CGFloat = 20
        var totalRuns = 0
        for line in layout {
            for _ in line { totalRuns += 1 }
        }

        var runIndex = 0
        for line in layout {
            measuredLineHeight = max(measuredLineHeight, line.typographicBounds.rect.height)
            for run in line {
                runIndex += 1
                let bounds = run.typographicBounds.rect
                lastOrigin = CGPoint(x: bounds.maxX, y: bounds.midY)

                guard isStreaming else {
                    context.draw(run)
                    continue
                }

                // The last two runs are "in flight": they enter lifted and soft.
                let distanceFromEnd = totalRuns - runIndex
                guard distanceFromEnd < 2 else {
                    context.draw(run)
                    continue
                }
                let freshness = 1.0 - Double(distanceFromEnd) / 2.0
                var copy = context
                copy.translateBy(x: 0, y: freshness * 2.2)
                copy.addFilter(.blur(radius: freshness * 0.9))
                copy.opacity = 1.0 - freshness * 0.25
                copy.draw(run)
            }
        }
        report(lastOrigin, measuredLineHeight)
    }
}
