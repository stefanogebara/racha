import SwiftUI

@main
struct RachaApp: App {
    #if DEBUG
    /// Runs before the two properties below, because stored-property
    /// initialisers run in declaration order and all of them run before any
    /// `init()` body. Putting the wipe in `init()` (or in `.task`) deleted the
    /// event directory *after* `EventStore` had created it and after
    /// `AppSettings` had read UserDefaults — so a reset launch kept its old
    /// preferences and then failed to write the seed. Order is the fix.
    private let didReset = DebugRoute.resetIfRequested()
    #endif

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
                // Decision #27: the ground is the night of the bar, and the
                // project already declares UIUserInterfaceStyle = Dark. Forcing
                // .light here (a leftover from the paper palette) made every
                // system surface disagree with the app: a light keyboard over
                // the night, and .ultraThinMaterial rendering the thread as an
                // opaque mid-grey slab. Seen on the simulator.
                .preferredColorScheme(.dark)
                .task {
                    await repository.loadAll()
                    // No auto-seed: fabricating a history for someone who never
                    // had one is dishonest, and it makes the gallery's headline
                    // number a lie on first launch. The sample data is installed
                    // only if the person asks for it, from first run.
                    #if DEBUG
                    await DebugRoute.apply(settings: settings, repository: repository, navigator: navigator)
                    #endif
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

    /// A one-shot instruction for the next screen to honour — set by first run,
    /// consumed by the thread. Kept here rather than passed down so the thread
    /// does not need to know it was opened by onboarding at all.
    enum Intent { case camera, compose, ledger, pay }
    var pendingIntent: Intent?

    func takeIntent() -> Intent? {
        defer { pendingIntent = nil }
        return pendingIntent
    }

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

#if DEBUG
/// Drives the app to a screen from a launch argument, so a simulator with no
/// tap tool (and a CI box) can screenshot every surface. Debug builds only; a
/// release build has no such door. Explicit by construction — this is not the
/// auto-seed decision #20 rules out, it is a person typing a flag.
///
///     xcrun simctl launch <udid> com.racha.ios -racha.onboarded YES -racha.debugRoute pay
///
/// Routes: `gallery` (seeded), `thread` (the open table), `ledger`, `pay`.
enum DebugRoute {
    /// Wipes the event log and every stored preference, so a UI test starts on
    /// a device that has never run the app. Called before `loadAll`, and only
    /// when the flag is present — a debug build launched normally keeps its data.
    @discardableResult
    static func resetIfRequested() -> Bool {
        guard UserDefaults.standard.bool(forKey: "racha.resetState") else { return false }
        let events = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Racha/Events", isDirectory: true)
        try? FileManager.default.removeItem(at: events)
        for key in ["racha.onboarded", "racha.myName", "racha.myPix", "racha.myCity",
                    "racha.imagery", "racha.imageBudget", "racha.meID"] {
            UserDefaults.standard.removeObject(forKey: key)
        }
        return true
    }

    @MainActor
    static func apply(settings: AppSettings, repository: RachaRepository, navigator: Navigator) async {
        guard let route = UserDefaults.standard.string(forKey: "racha.debugRoute") else { return }
        if repository.allStates.isEmpty { await SeedData.install(into: repository) }
        settings.hasOnboarded = true
        guard route != "gallery", let table = repository.allStates.first(where: { !$0.isSettled }) else { return }
        switch route {
        case "ledger": navigator.pendingIntent = .ledger
        case "pay": navigator.pendingIntent = .pay
        default: break
        }
        navigator.open(table.id)
    }
}
#endif
