import SwiftUI
import CoreMotion

/// Device tilt, smoothed, for the glass highlight.
///
/// Sampled at 30Hz and low-pass filtered: raw attitude is noisy enough that an
/// unfiltered highlight jitters on a table, which reads as a bug. The filter
/// constant is tuned so the light lags the phone by about 80ms — enough to feel
/// like inertia, not enough to feel broken.
///
/// Stops itself when nothing is observing, because the accelerometer is not free
/// and the person is at 15% battery.
@MainActor
@Observable
final class TiltSource {
    private(set) var tilt: CGPoint = .zero
    private let manager = CMMotionManager()
    private var subscribers = 0

    static let shared = TiltSource()

    func subscribe() {
        subscribers += 1
        guard subscribers == 1, manager.isDeviceMotionAvailable else { return }
        manager.deviceMotionUpdateInterval = 1.0 / 30.0
        manager.startDeviceMotionUpdates(to: .main) { [weak self] motion, _ in
            guard let self, let motion else { return }
            let targetX = CGFloat(motion.attitude.roll).clamped(to: -1...1)
            let targetY = CGFloat(motion.attitude.pitch - 0.5).clamped(to: -1...1)
            let alpha: CGFloat = 0.12
            self.tilt = CGPoint(x: self.tilt.x + (targetX - self.tilt.x) * alpha,
                                y: self.tilt.y + (targetY - self.tilt.y) * alpha)
        }
    }

    func unsubscribe() {
        subscribers = max(0, subscribers - 1)
        if subscribers == 0 { manager.stopDeviceMotionUpdates() }
    }
}

extension Comparable {
    func clamped(to range: ClosedRange<Self>) -> Self {
        min(max(self, range.lowerBound), range.upperBound)
    }
}

/// The app's motion vocabulary.
///
/// Four springs, used consistently. Consistency is what makes an interface feel
/// designed rather than assembled: a person learns the app's physics in the first
/// ten seconds and then everything after that is predictable.
enum Motion {
    /// Default for anything that moves position or size.
    static let fluid = Animation.spring(response: 0.42, dampingFraction: 0.78)
    /// Buttons, chips, toggles — snappier, less overshoot.
    static let snappy = Animation.spring(response: 0.28, dampingFraction: 0.86)
    /// The zoom between timeline and thread. Longer, with real overshoot, because
    /// it is the app's signature move.
    static let zoom = Animation.spring(response: 0.55, dampingFraction: 0.74)
    /// Money changing. Deliberately slower than everything else: a number that
    /// snaps is a number you missed.
    static let ledger = Animation.spring(response: 0.62, dampingFraction: 0.92)
    /// The settled celebration.
    static let event = Animation.spring(response: 0.7, dampingFraction: 0.6)
}
