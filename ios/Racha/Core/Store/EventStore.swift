import Foundation

/// Append-only, per-racha, on disk.
///
/// One JSON-lines file per racha (`<uuid>.jsonl`). The format is deliberate:
/// appending is a single `write` at the end of the file, so a crash mid-write can
/// corrupt at most the last line — and `load` skips unparseable lines into
/// `anomalies` rather than refusing to open the racha. A ledger that won't open
/// because of one bad byte is worse than a ledger with a hole you can see.
///
/// This is not a database. It doesn't need to be: a racha is a few hundred events
/// at the very most, and the whole point of the event log is that folding it is
/// cheap and total.
actor EventStore {
    private let directory: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    /// Highest sequence number seen per racha, so appends stay monotonic without
    /// re-reading the file.
    private var heads: [UUID: Int] = [:]

    init(directory: URL? = nil) {
        let base = directory ?? FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Racha/Events", isDirectory: true)
        self.directory = base
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)

        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        enc.outputFormatting = [.withoutEscapingSlashes]   // NOT .prettyPrinted: one event, one line
        self.encoder = enc

        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        self.decoder = dec
    }

    private func url(for rachaID: UUID) -> URL {
        directory.appendingPathComponent("\(rachaID.uuidString).jsonl")
    }

    // MARK: Reading

    func allRachaIDs() -> [UUID] {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        return files.compactMap { file in
            guard file.pathExtension == "jsonl" else { return nil }
            return UUID(uuidString: file.deletingPathExtension().lastPathComponent)
        }
    }

    /// Returns the events plus a note for every line that could not be decoded.
    func load(_ rachaID: UUID) -> (events: [RachaEvent], skipped: [String]) {
        guard let data = try? Data(contentsOf: url(for: rachaID)),
              let text = String(data: data, encoding: .utf8) else { return ([], []) }

        var events: [RachaEvent] = []
        var skipped: [String] = []
        for (lineNumber, line) in text.split(separator: "\n", omittingEmptySubsequences: true).enumerated() {
            guard let lineData = line.data(using: .utf8) else { continue }
            if let event = try? decoder.decode(RachaEvent.self, from: lineData) {
                events.append(event)
            } else {
                skipped.append("linha \(lineNumber + 1) ilegível (\(line.prefix(40))…)")
            }
        }
        heads[rachaID] = events.map(\.seq).max() ?? 0
        return (events, skipped)
    }

    // MARK: Appending

    /// Assigns the next sequence number and appends. Returns the stored event so
    /// the caller holds the id it needs to offer an undo.
    @discardableResult
    func append(rachaID: UUID, origin: RachaEvent.Origin, summary: String,
                body: RachaEvent.Body, at: Date = Date()) throws -> RachaEvent {
        if heads[rachaID] == nil { _ = load(rachaID) }
        let seq = (heads[rachaID] ?? 0) + 1
        let event = RachaEvent(id: UUID(), rachaID: rachaID, seq: seq, at: at,
                               origin: origin, summary: summary, body: body, revertedBy: nil)
        try appendRaw(event)
        heads[rachaID] = seq
        return event
    }

    private func appendRaw(_ event: RachaEvent) throws {
        var line = try encoder.encode(event)
        line.append(0x0A)   // \n
        let target = url(for: event.rachaID)
        if FileManager.default.fileExists(atPath: target.path) {
            let handle = try FileHandle(forWritingTo: target)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: line)
        } else {
            try line.write(to: target, options: .atomic)
        }
    }

    func delete(_ rachaID: UUID) {
        try? FileManager.default.removeItem(at: url(for: rachaID))
        heads[rachaID] = nil
    }

    /// Raw export — the whole log, for "mandar o histórico" or a support dump.
    func exportJSONL(_ rachaID: UUID) -> String {
        (try? String(contentsOf: url(for: rachaID), encoding: .utf8)) ?? ""
    }
}
