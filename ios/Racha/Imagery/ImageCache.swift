import UIKit

/// Content-addressed image cache, on disk and in memory.
///
/// The economics of generated imagery live entirely here. A dish is keyed by
/// *what it is*, not by which receipt it came from, so the second picanha the
/// user ever orders — at a different restaurant, months later — is free and
/// instant. Across a user's history the hit rate on food is very high, because
/// people order the same things.
///
/// Negative results are cached too, with a short TTL: an item the generator
/// refuses (a weird receipt string) must not be retried on every scroll.
actor ImageCache {
    static let shared = ImageCache()

    private let directory: URL
    private var memory = NSCache<NSString, UIImage>()
    private var inFlight: [String: Task<UIImage?, Never>] = [:]
    private var failures: [String: Date] = [:]
    private let failureTTL: TimeInterval = 60 * 30

    /// Cost tracking, so Settings can show what the imagery has actually cost.
    private(set) var generatedCount = 0
    private(set) var spentMicros = 0

    init(directory: URL? = nil) {
        let base = directory ?? FileManager.default
            .urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Racha/Images", isDirectory: true)
        self.directory = base
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        memory.countLimit = 220
        memory.totalCostLimit = 64 * 1024 * 1024
    }

    private func url(_ key: String) -> URL {
        // The key is already sanitised by `ImageStyle.cacheKey`, but a stray
        // separator would write outside the directory — so it is re-checked here.
        let safe = key.filter { $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" || $0 == "+" || $0 == "_" }
        return directory.appendingPathComponent("\(safe).webp")
    }

    func cached(_ key: String) -> UIImage? {
        if let hit = memory.object(forKey: key as NSString) { return hit }
        guard let data = try? Data(contentsOf: url(key)), let image = UIImage(data: data) else { return nil }
        memory.setObject(image, forKey: key as NSString, cost: data.count)
        return image
    }

    /// Fetch or generate. Concurrent callers for the same key share one request —
    /// a timeline scrolling past twelve identical chopps must produce one
    /// generation, not twelve.
    func image(key: String, prompt: String, provider: any ImageProvider,
               fallback: any ImageProvider = ProceduralImageProvider(),
               size: Int = 1024) async -> UIImage? {
        if let hit = cached(key) { return hit }
        // The plate is a fallback, not a generation: it must never reach the
        // disk cache or the spend counter. Before this guard, a keyless launch
        // wrote a plate per row to disk and every later launch read it back as
        // if a generator had produced it — which is how the carved blocks
        // stayed hidden across relaunches on the simulator.
        if provider is ProceduralImageProvider {
            return await procedural(key: key, prompt: prompt, fallback: provider, size: size)
        }
        if let failedAt = failures[key], Date().timeIntervalSince(failedAt) < failureTTL {
            return await procedural(key: key, prompt: prompt, fallback: fallback, size: size)
        }
        if let existing = inFlight[key] { return await existing.value }

        let task = Task<UIImage?, Never> { [provider, fallback] in
            do {
                let data = try await provider.generate(prompt: prompt, size: size)
                guard let image = UIImage(data: data) else { throw ImageProviderError.malformedResponse }
                await self.store(key: key, data: data, image: image, cost: provider.costPerImageMicros)
                return image
            } catch {
                await self.recordFailure(key)
                return await self.procedural(key: key, prompt: prompt, fallback: fallback, size: size)
            }
        }
        inFlight[key] = task
        let result = await task.value
        inFlight[key] = nil
        return result
    }

    private func procedural(key: String, prompt: String, fallback: any ImageProvider, size: Int) async -> UIImage? {
        // The procedural plate is deterministic from the key, so it is stable
        // across launches — the same dish always gets the same placeholder, which
        // keeps the timeline from reshuffling colours on every cold start.
        guard let data = try? await fallback.generate(prompt: prompt, size: size),
              let image = UIImage(data: data) else { return nil }
        memory.setObject(image, forKey: key as NSString, cost: data.count)
        return image
    }

    private func store(key: String, data: Data, image: UIImage, cost: Int) {
        memory.setObject(image, forKey: key as NSString, cost: data.count)
        try? data.write(to: url(key), options: .atomic)
        generatedCount += 1
        spentMicros += cost
        failures[key] = nil
    }

    private func recordFailure(_ key: String) { failures[key] = Date() }

    /// Total spent on generation, formatted for Settings.
    var spentDisplay: String {
        String(format: "US$ %.2f em %d imagens", Double(spentMicros) / 1_000_000, generatedCount)
    }

    func clear() {
        memory.removeAllObjects()
        failures.removeAll()
        try? FileManager.default.removeItem(at: directory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    func diskBytes() -> Int {
        let files = (try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.fileSizeKey])) ?? []
        return files.reduce(0) { total, file in
            total + ((try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        }
    }
}
