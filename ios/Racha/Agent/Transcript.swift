import Foundation

/// What the thread shows. Distinct from `WireMessage` on purpose — see the note
/// there.
struct ChatMessage: Identifiable, Sendable, Equatable {
    var id = UUID()
    var role: Role
    var text: String
    var at: Date = Date()
    /// Attached photo (a receipt), as a local asset key.
    var imageKey: String?
    /// Edits this message caused, rendered as an undoable ribbon under the bubble.
    var edits: [LedgerEdit] = []
    /// While true the bubble streams and the shader runs.
    var isStreaming: Bool = false
    /// Set when the turn failed; the bubble renders as a soft error, not a crash.
    var failure: String?

    enum Role: String, Sendable { case user, agent, system }
}

/// One visible, labelled, undoable change the agent made.
///
/// This struct is the product promise made concrete. It exists so that the
/// answer to "what did it just do to my bill?" is a row on screen with a button,
/// never a diff a person has to reconstruct.
struct LedgerEdit: Identifiable, Sendable, Equatable {
    var id = UUID()
    var toolName: String
    /// pt-BR, one line per change.
    var summary: String
    /// The events to revert. Reverting them all is one gesture.
    var eventIDs: [UUID]
    var isUndone: Bool = false
    /// Total delta this edit made to the bill, when it moved money. Shown as
    /// "+R$ 62,00" next to the summary — the number a person scans for.
    var deltaCents: Cents?
}

/// The per-racha conversation, persisted alongside the ledger.
struct Transcript: Codable, Sendable {
    var rachaID: UUID
    var messages: [StoredMessage] = []

    struct StoredMessage: Codable, Sendable {
        var id: UUID
        var role: String
        var text: String
        var at: Date
        var imageKey: String?
        var edits: [StoredEdit]
        var failure: String?
    }

    struct StoredEdit: Codable, Sendable {
        var id: UUID
        var toolName: String
        var summary: String
        var eventIDs: [UUID]
        var isUndone: Bool
        var deltaCents: Int?
    }
}

/// Transcript persistence. Separate file from the event log because a chat
/// message is not a ledger fact — losing the chat must never risk the money, and
/// the two have completely different durability needs.
actor TranscriptStore {
    private let directory: URL

    init(directory: URL? = nil) {
        let base = directory ?? FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Racha/Threads", isDirectory: true)
        self.directory = base
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    }

    private func url(_ id: UUID) -> URL {
        directory.appendingPathComponent("\(id.uuidString).json")
    }

    func load(_ rachaID: UUID) -> [ChatMessage] {
        guard let data = try? Data(contentsOf: url(rachaID)) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let stored = try? decoder.decode(Transcript.self, from: data) else { return [] }
        return stored.messages.map { m in
            ChatMessage(id: m.id,
                        role: ChatMessage.Role(rawValue: m.role) ?? .agent,
                        text: m.text, at: m.at, imageKey: m.imageKey,
                        edits: m.edits.map {
                            LedgerEdit(id: $0.id, toolName: $0.toolName, summary: $0.summary,
                                       eventIDs: $0.eventIDs, isUndone: $0.isUndone,
                                       deltaCents: $0.deltaCents.map(Cents.init))
                        },
                        isStreaming: false, failure: m.failure)
        }
    }

    func save(_ rachaID: UUID, messages: [ChatMessage]) {
        let stored = Transcript(rachaID: rachaID, messages: messages.map { m in
            Transcript.StoredMessage(
                id: m.id, role: m.role.rawValue, text: m.text, at: m.at, imageKey: m.imageKey,
                edits: m.edits.map {
                    Transcript.StoredEdit(id: $0.id, toolName: $0.toolName, summary: $0.summary,
                                          eventIDs: $0.eventIDs, isUndone: $0.isUndone,
                                          deltaCents: $0.deltaCents?.raw)
                },
                failure: m.failure)
        })
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(stored) else { return }
        try? data.write(to: url(rachaID), options: .atomic)
    }

    func delete(_ rachaID: UUID) {
        try? FileManager.default.removeItem(at: url(rachaID))
    }
}
