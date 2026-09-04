import SwiftUI

/// One generated image, arriving through the resolve shader.
///
/// The loading state is the interesting part. Instead of a spinner it shows the
/// procedural plate immediately, then *develops* the real image over it when it
/// lands. There is never an empty box and never a jump — the picture appears to
/// come into focus, which is both prettier and honest about what is happening.
struct DishImageView: View {
    var cacheKey: String
    var prompt: String
    var cornerRadius: CGFloat = 14
    var size: Int = 512

    @Environment(\.imageEngine) private var engine
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var image: UIImage?
    @State private var resolve: Double = 0
    @State private var clock = ShaderClock.shared
    /// Per-image seed so twelve cards resolving at once do not do it in lockstep.
    private var seed: Double { Double(cacheKey.stableHash % 997) }

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .modifier(ResolveModifier(progress: resolve,
                                              time: clock.time,
                                              seed: seed,
                                              enabled: !reduceMotion))
            } else {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(Palette.glassSubtle)
                    .overlay {
                        Image(systemName: "photo")
                            .foregroundStyle(Palette.stone.opacity(0.35))
                    }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .strokeBorder(.white.opacity(0.45), lineWidth: 0.5)
        }
        .task(id: cacheKey) { await load() }
        .onAppear { if !reduceMotion { clock.subscribe() } }
        .onDisappear { if !reduceMotion { clock.unsubscribe() } }
        .accessibilityHidden(true)   // decorative; the item's name is the label
    }

    private func load() async {
        resolve = 0
        // A cache hit skips the animation entirely: a picture the person has
        // already seen developing again on every scroll would be irritating, not
        // delightful. The effect earns its place by being rare.
        if let hit = await ImageCache.shared.cached(cacheKey) {
            image = hit
            resolve = 1
            return
        }
        let loaded = await engine.image(key: cacheKey, prompt: prompt, size: size)
        guard let loaded else { return }
        image = loaded
        if reduceMotion {
            resolve = 1
        } else {
            withAnimation(.easeOut(duration: 1.15)) { resolve = 1 }
        }
    }
}

private struct ResolveModifier: ViewModifier {
    let progress: Double
    let time: Double
    let seed: Double
    let enabled: Bool

    func body(content: Content) -> some View {
        if enabled && progress < 0.999 {
            content.visualEffect { view, proxy in
                view.layerEffect(
                    RachaShader.imageResolve(size: proxy.size, progress: progress,
                                             time: time, seed: seed),
                    maxSampleOffset: CGSize(width: 40, height: 40))
            }
        } else {
            content
        }
    }
}

/// The app's image façade: picks a provider from stored settings and hands work
/// to the cache. Injected through the environment so previews and tests can swap
/// in the procedural provider with no network at all.
struct ImageEngine: Sendable {
    var provider: ImageProvider
    var coverProvider: ImageProvider

    static func fromSettings(_ settings: AppSettings) -> ImageEngine {
        if !settings.openAIKey.isEmpty {
            return ImageEngine(
                provider: OpenAIImageProvider(apiKey: settings.openAIKey, quality: "low"),
                coverProvider: OpenAIImageProvider(apiKey: settings.openAIKey, quality: "medium"))
        }
        if !settings.googleKey.isEmpty {
            return ImageEngine(
                provider: GoogleImageProvider(apiKey: settings.googleKey),
                coverProvider: GoogleImageProvider(apiKey: settings.googleKey))
        }
        return .procedural
    }

    static let procedural = ImageEngine(provider: ProceduralImageProvider(),
                                        coverProvider: ProceduralImageProvider())

    func image(key: String, prompt: String, size: Int) async -> UIImage? {
        await ImageCache.shared.image(key: key, prompt: prompt, provider: provider, size: size)
    }

    func cover(key: String, prompt: String) async -> UIImage? {
        await ImageCache.shared.image(key: key, prompt: prompt, provider: coverProvider, size: 1024)
    }
}

private struct ImageEngineKey: EnvironmentKey {
    static let defaultValue = ImageEngine.procedural
}

extension EnvironmentValues {
    var imageEngine: ImageEngine {
        get { self[ImageEngineKey.self] }
        set { self[ImageEngineKey.self] = newValue }
    }
}
