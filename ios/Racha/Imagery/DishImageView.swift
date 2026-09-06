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
    /// Which block to print while (or instead of) a photograph. Passed rather
    /// than parsed back out of the cache key, so a renamed key cannot silently
    /// turn every row into an empty square.
    var category: ItemCategory = .other
    var cornerRadius: CGFloat = 14
    var size: Int = 512
    /// Padding around the cut-out, as a fraction of the frame. A subject that
    /// touches its own edges reads as cropped rather than placed.
    var inset: CGFloat = 0

    @Environment(\.imageEngine) private var engine
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var image: UIImage?
    @State private var resolve: Double = 0
    @State private var clock = ShaderClock.shared
    @State private var hold = ClockSubscription()
    /// Per-image seed so twelve cards resolving at once do not do it in lockstep.
    private var seed: Double { Double(cacheKey.stableHash % 997) }

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    // .fit, not .fill: a cut-out must never be cropped, and its
                    // alpha means there is no background to fill with anyway.
                    .aspectRatio(contentMode: .fit)
                    .padding(.init(top: 0, leading: 0, bottom: 0, trailing: 0))
                    .scaleEffect(1 - inset * 2)
                    .modifier(ResolveModifier(progress: resolve,
                                              time: clock.time,
                                              seed: seed,
                                              enabled: !reduceMotion))
            } else if let block = CarvedSet.mask(for: category) {
                // The carved block, not a grey box with a camera glyph in it.
                // It is bundled, so it is on screen in the first frame — with no
                // key, no signal, and nothing to wait for. A generated photo, if
                // one is ever configured, develops over this; the block is the
                // design, not the apology for its absence.
                Image(uiImage: block)
                    .renderingMode(.template)      // the file is alpha only
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .foregroundStyle(Palette.ink)  // ink is chosen here, not baked
                    .scaleEffect(1 - inset * 2)
            } else {
                // Genuinely pictureless: serviço, taxa. Nothing is more honest
                // than the paper.
                Color.clear
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .strokeBorder(Palette.rule2, lineWidth: 0.5)
        }
        .task(id: cacheKey) { await load() }
        // Frames only while the picture is developing. Before this, every row
        // held the clock for its whole life, so a fully-resolved gallery kept a
        // 30fps display link alive and re-rendered every view reading
        // `clock.time` — forever, behind a screen where nothing moved.
        .onChange(of: resolve) { _, now in hold.want(!reduceMotion && now > 0 && now < 0.999) }
        .onDisappear { hold.want(false) }
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
        // With no key the engine only knows the procedural plate, and a plate
        // painted into `image` would sit on top of the carved block for every
        // row — which is exactly what the simulator showed: fourteen subjects,
        // one hat. The block IS the design (decision #33); the plate is for
        // categories that have no block, and for a generator that failed.
        if !engine.generates, CarvedSet.mask(for: category) != nil { return }
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
    var provider: any ImageProvider
    var coverProvider: any ImageProvider

    @MainActor
    static func fromSettings(_ settings: AppSettings) -> ImageEngine {
        if !settings.openAIKey.isEmpty {
            return ImageEngine(
                // Line items are cut out; the cover is a full frame and keeps its
                // background. See the note on transparency in ImageProvider.
                provider: OpenAIImageProvider(apiKey: settings.openAIKey,
                                              quality: "low", transparent: true),
                coverProvider: OpenAIImageProvider(apiKey: settings.openAIKey,
                                                   quality: "medium", transparent: false))
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

    /// False when the only thing this engine can draw is the local plate.
    var generates: Bool { !(provider is ProceduralImageProvider) }

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
