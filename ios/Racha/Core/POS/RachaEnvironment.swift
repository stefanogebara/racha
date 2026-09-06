import Foundation

/// Where this build talks to.
///
/// The QR carries its own origin, so a venue on a white-label domain works
/// without a client release; this is only the fallback for the "type the code"
/// path and for deciding whether a build has a backend at all.
enum RachaEnvironment {
    /// Overridable at launch (`-RachaOrigin https://staging…`) so QA can point a
    /// TestFlight build at staging without a rebuild.
    static var origin: URL {
        if let raw = UserDefaults.standard.string(forKey: "RachaOrigin"),
           let url = URL(string: raw), url.scheme?.hasPrefix("http") == true {
            return url
        }
        return URL(string: "https://racha.app")!
    }

    /// Demo mode: no backend, everything through `DemoTableSource`. On by
    /// default in the simulator and in a debug build, so the app keeps its
    /// promise of running with no key and no network.
    static var isDemo: Bool {
        if UserDefaults.standard.object(forKey: "RachaDemo") != nil {
            return UserDefaults.standard.bool(forKey: "RachaDemo")
        }
        #if targetEnvironment(simulator)
        return true
        #elseif DEBUG
        return true
        #else
        return false
        #endif
    }

    /// The source this build reads tables from.
    static var tableSource: any TableSource {
        isDemo ? DemoTableSource() : BackendTableSource()
    }
}
