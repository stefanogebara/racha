import UIKit
import CoreHaptics

/// Haptics as a language, not decoration.
///
/// Each pattern means one thing, and the meanings do not overlap:
/// a light tick is "I registered your touch"; a double tap is "money moved";
/// the settle pattern is "this racha is done". Someone who uses the app for a
/// month should be able to tell what happened with the phone in their pocket.
///
/// The custom engine is used where `UIFeedbackGenerator` cannot express the
/// shape — the settle event is a rising continuous rumble with two transients on
/// top, which is not in the standard set.
@MainActor
final class Haptics {
    static let shared = Haptics()

    private var engine: CHHapticEngine?
    private let selection = UISelectionFeedbackGenerator()
    private let impactLight = UIImpactFeedbackGenerator(style: .light)
    private let impactSoft = UIImpactFeedbackGenerator(style: .soft)
    private let notification = UINotificationFeedbackGenerator()

    private init() {
        prepare()
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else { return }
        engine = try? CHHapticEngine()
        // The engine is stopped by the system on interruption (a call, backgrounding).
        // Without this it silently never fires again.
        engine?.resetHandler = { [weak self] in try? self?.engine?.start() }
        engine?.stoppedHandler = { _ in }
        try? engine?.start()
    }

    /// Call before a gesture that will fire haptics — warms the generator so the
    /// first tap isn't late.
    func prepare() {
        selection.prepare()
        impactLight.prepare()
        impactSoft.prepare()
    }

    /// A control changed. The most common feedback in the app.
    func tick() { selection.selectionChanged() }

    /// A surface was pressed.
    func press() { impactSoft.impactOccurred(intensity: 0.6) }

    /// An item was claimed / unclaimed.
    func claim() { impactLight.impactOccurred(intensity: 0.75) }

    /// Money changed hands.
    func money() {
        guard let engine else { notification.notificationOccurred(.success); return }
        let events = [
            transient(at: 0, intensity: 0.7, sharpness: 0.4),
            transient(at: 0.09, intensity: 0.95, sharpness: 0.65)
        ]
        play(events, on: engine)
    }

    /// The agent finished a turn — a single soft tap so the person can look away.
    func agentDone() { impactSoft.impactOccurred(intensity: 0.45) }

    /// An edit was undone: a reversed pair, so it feels like the money one played
    /// backwards.
    func undone() {
        guard let engine else { selection.selectionChanged(); return }
        let events = [
            transient(at: 0, intensity: 0.95, sharpness: 0.65),
            transient(at: 0.09, intensity: 0.55, sharpness: 0.3)
        ]
        play(events, on: engine)
    }

    /// The racha closed. The one pattern in the app anybody will remember: a
    /// rising rumble under two bright transients, ~0.75s.
    func settled() {
        guard let engine else { notification.notificationOccurred(.success); return }
        var events: [CHHapticEvent] = [
            CHHapticEvent(eventType: .hapticContinuous, parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: 0.55),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.25)
            ], relativeTime: 0, duration: 0.55),
            transient(at: 0.42, intensity: 0.9, sharpness: 0.7),
            transient(at: 0.56, intensity: 1.0, sharpness: 0.85)
        ]
        let rise = CHHapticParameterCurve(
            parameterID: .hapticIntensityControl,
            controlPoints: [
                .init(relativeTime: 0, value: 0.2),
                .init(relativeTime: 0.42, value: 1.0),
                .init(relativeTime: 0.55, value: 0.4)
            ],
            relativeTime: 0)
        events.append(transient(at: 0.7, intensity: 0.4, sharpness: 0.2))
        guard let pattern = try? CHHapticPattern(events: events, parameterCurves: [rise]),
              let player = try? engine.makePlayer(with: pattern) else { return }
        try? engine.start()
        try? player.start(atTime: CHHapticTimeImmediate)
    }

    func error() { notification.notificationOccurred(.warning) }

    private func transient(at time: TimeInterval, intensity: Float, sharpness: Float) -> CHHapticEvent {
        CHHapticEvent(eventType: .hapticTransient, parameters: [
            CHHapticEventParameter(parameterID: .hapticIntensity, value: intensity),
            CHHapticEventParameter(parameterID: .hapticSharpness, value: sharpness)
        ], relativeTime: time)
    }

    private func play(_ events: [CHHapticEvent], on engine: CHHapticEngine) {
        guard let pattern = try? CHHapticPattern(events: events, parameters: []),
              let player = try? engine.makePlayer(with: pattern) else { return }
        try? engine.start()
        try? player.start(atTime: CHHapticTimeImmediate)
    }
}
