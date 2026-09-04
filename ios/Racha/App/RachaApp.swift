import SwiftUI

@main
struct RachaApp: App {
    @State private var settings = AppSettings()
    @State private var repository = RachaRepository()
    @State private var navigator = Navigator()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(settings)
                .environment(repository)
                .environment(navigator)
                .environment(\.imageEngine,
                              settings.imageryEnabled ? .fromSettings(settings) : .procedural)
                .preferredColorScheme(.light)   // the palette is a light palette; see docs/decisions
                .task {
                    await repository.loadAll()
                    if repository.allStates.isEmpty {
                        await SeedData.install(into: repository)
                    }
                }
        }
    }
}

/// Where the app is, as one continuous value rather than a stack.
///
/// This is the spine of the signature interaction. `zoom` is 0 when the timeline
/// fills the screen and 1 when a single thread does, and it is *driven directly
/// by the finger* during a pinch or drag. There is no navigation stack, no push,
/// no dismiss — the two views are two ends of one number.
@MainActor
@Observable
final class Navigator {
    var focused: UUID?
    /// 0 = timeline, 1 = thread. Fractional values are mid-gesture.
    var zoom: Double = 0
    /// True while a finger is driving `zoom`, so animations stand aside.
    var isDragging = false
    /// Set when a racha just settled, to run the burst at the tap point.
    var burst: (rachaID: UUID, origin: CGPoint, startedAt: Date)?

    var isThread: Bool { zoom > 0.5 }

    func open(_ id: UUID) {
        focused = id
        withAnimation(Motion.zoom) { zoom = 1 }
    }

    func close() {
        withAnimation(Motion.zoom) { zoom = 0 }
        // The id is kept until the animation lands so the thread does not blank
        // out mid-flight; clearing it early is the classic matched-geometry glitch.
        Task {
            try? await Task.sleep(for: .seconds(0.55))
            if zoom < 0.01 { focused = nil }
        }
    }

    func celebrate(_ id: UUID, at origin: CGPoint) {
        burst = (id, origin, Date())
        Haptics.shared.settled()
        Task {
            try? await Task.sleep(for: .seconds(1.4))
            burst = nil
        }
    }
}
