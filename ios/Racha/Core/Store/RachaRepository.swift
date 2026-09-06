import Foundation
import Observation

/// The one writable door into the ledger.
///
/// Everything — a tap, an agent tool call, a receipt scan — goes through
/// `append`, which is where validation lives and where the undo affordance is
/// minted. Views observe `states`; nothing else mutates it.
@MainActor
@Observable
final class RachaRepository {
    private let store: EventStore

    /// Projected state per racha, kept warm. A racha is small; this is cheaper
    /// and far more predictable than partial invalidation.
    private(set) var states: [UUID: RachaState] = [:]
    private(set) var logs: [UUID: [RachaEvent]] = [:]

    /// Who "eu" is. Every racha the user is in contains them as a participant, and
    /// this is the id used across all of them.
    private(set) var meID: UUID

    init(store: EventStore = EventStore(), meID: UUID? = nil) {
        self.store = store
        if let meID {
            self.meID = meID
        } else if let stored = UserDefaults.standard.string(forKey: "racha.meID"), let id = UUID(uuidString: stored) {
            self.meID = id
        } else {
            let id = UUID()
            UserDefaults.standard.set(id.uuidString, forKey: "racha.meID")
            self.meID = id
        }
    }

    var allStates: [RachaState] {
        states.values.sorted { $0.updatedAt > $1.updatedAt }
    }

    func state(_ id: UUID) -> RachaState? { states[id] }
    func log(_ id: UUID) -> [RachaEvent] { logs[id] ?? [] }

    // MARK: Loading

    func loadAll() async {
        for id in await store.allRachaIDs() { await reload(id) }
    }

    @discardableResult
    func reload(_ id: UUID) async -> RachaState? {
        let (events, skipped) = await store.load(id)
        logs[id] = events
        guard var state = RachaProjection.reduce(events) else {
            states[id] = nil
            return nil
        }
        state.anomalies.append(contentsOf: skipped)
        states[id] = state
        return state
    }

    // MARK: Writing

    /// Append one event and reproject. `summary` is what the person will read in
    /// the edit ribbon, so it is required and written in pt-BR at the call site
    /// where the intent is known — not reconstructed later from the body.
    @discardableResult
    func append(_ rachaID: UUID, _ body: RachaEvent.Body,
                origin: RachaEvent.Origin = .user, summary: String) async throws -> RachaEvent {
        let event = try await store.append(rachaID: rachaID, origin: origin, summary: summary, body: body)
        await reload(rachaID)
        return event
    }

    /// Append several events as one logical edit. They still land as separate
    /// facts (so each is individually inspectable), but `undo(group:)` reverts
    /// them together — which is what "one gesture" means when the agent did four
    /// things in one sentence.
    @discardableResult
    func appendBatch(_ rachaID: UUID, _ bodies: [(RachaEvent.Body, String)],
                     origin: RachaEvent.Origin = .agent) async throws -> [RachaEvent] {
        var out: [RachaEvent] = []
        for (body, summary) in bodies {
            out.append(try await store.append(rachaID: rachaID, origin: origin, summary: summary, body: body))
        }
        await reload(rachaID)
        return out
    }

    /// Undo. Appends a revert marker rather than deleting anything — the log keeps
    /// the mistake and the projection skips it.
    func undo(_ event: RachaEvent, reason: String? = nil) async throws {
        _ = try await store.append(rachaID: event.rachaID, origin: .user,
                                   summary: "Desfeito: \(event.summary)",
                                   body: .reverted(target: event.id, reason: reason))
        await reload(event.rachaID)
    }

    func undo(group events: [RachaEvent], reason: String? = nil) async throws {
        guard let rachaID = events.first?.rachaID else { return }
        for event in events {
            _ = try await store.append(rachaID: rachaID, origin: .user,
                                       summary: "Desfeito: \(event.summary)",
                                       body: .reverted(target: event.id, reason: reason))
        }
        await reload(rachaID)
    }

    // MARK: Creating

    func createRacha(title: String, kind: RachaKind, currency: Currency = .brl,
                     meName: String = "Eu") async throws -> UUID {
        let id = UUID()
        _ = try await store.append(rachaID: id, origin: .user, summary: "Racha criado",
                                   body: .created(title: title, kind: kind, currency: currency))
        let me = Participant(id: meID, name: meName)
        _ = try await store.append(rachaID: id, origin: .system, summary: "Você entrou no racha",
                                   body: .participantAdded(me))
        await reload(id)
        return id
    }

    func delete(_ id: UUID) async {
        await store.delete(id)
        states[id] = nil
        logs[id] = nil
    }

    // MARK: Convenience used by the agent toolbox and the UI

    /// Find or create a participant by loose name. Returns the id plus the event
    /// if one was created, so the caller can label and offer to undo it.
    func participant(named name: String, in rachaID: UUID) async throws -> (id: Participant.ID, created: RachaEvent?) {
        guard let state = states[rachaID] else { throw RachaError.unknownRacha }
        switch ParticipantResolver.resolve(name, in: state.participants) {
        case .matched(let id):
            return (id, nil)
        case .ambiguous(let ids):
            throw RachaError.ambiguousParticipant(name, ids.compactMap { state.participant($0)?.name })
        case .notFound:
            let p = Participant(name: name.trimmingCharacters(in: .whitespaces).capitalizedFirst)
            let event = try await append(rachaID, .participantAdded(p), origin: .agent,
                                         summary: "\(p.name) entrou no racha")
            return (p.id, event)
        }
    }
}

enum RachaError: LocalizedError, Equatable {
    case unknownRacha
    case unknownItem(String)
    case ambiguousParticipant(String, [String])
    case invalidAmount(String)

    var errorDescription: String? {
        switch self {
        case .unknownRacha: return "Esse racha não existe mais."
        case .unknownItem(let name): return "Não achei o item “\(name)” na conta."
        case .ambiguousParticipant(let q, let options):
            return "“\(q)” pode ser \(options.joined(separator: " ou ")). Qual deles?"
        case .invalidAmount(let raw): return "Não consegui ler o valor “\(raw)”."
        }
    }
}

extension String {
    var capitalizedFirst: String {
        guard let first else { return self }
        return String(first).uppercased() + dropFirst()
    }
}
