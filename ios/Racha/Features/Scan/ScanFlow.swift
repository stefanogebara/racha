import SwiftUI

/// Scan → check → racha, as one state machine.
///
/// The screen it drives is small; the reason it exists is that the four things
/// that can happen after a scan are genuinely different and a person at a table
/// needs to be told which one it was:
///
/// - a new table, which becomes a racha and opens;
/// - a table this phone already has open, which is **merged**, not duplicated;
/// - a table with no check yet, which is the waiter's move, not the diner's;
/// - a dead token or a dead network, which is worth saying plainly.
@MainActor
@Observable
final class ScanFlow {
    enum Phase: Equatable {
        case idle
        case reading
        case failed(String)
    }

    private(set) var phase: Phase = .idle
    /// Set when a scan lands on a racha the app already had; the hub uses it to
    /// say what changed instead of silently growing the bill.
    private(set) var mergedItems: [LineItem] = []

    var isPresentingScanner = false
    var source: any TableSource = RachaEnvironment.tableSource

    /// Read a scanned table and hand back the racha to open.
    func open(_ qr: TableQR, in repository: RachaRepository, meName: String) async -> UUID? {
        phase = .reading
        mergedItems = []
        do {
            let check = try await source.openCheck(for: qr)
            // Same check id already on this phone → the waiter added a round and
            // somebody re-scanned. Merge; never import twice.
            if let existing = repository.allStates.first(where: { $0.venue?.checkID == check.checkID }) {
                mergedItems = try await CheckImport.merge(check, into: existing.id, in: repository)
                phase = .idle
                return existing.id
            }
            let id = try await CheckImport.createRacha(from: check, in: repository, meName: meName)
            phase = .idle
            return id
        } catch let error as TableSourceError {
            phase = .failed(error.errorDescription ?? "Não consegui abrir essa mesa.")
            return nil
        } catch {
            phase = .failed("Não consegui abrir essa mesa.")
            return nil
        }
    }

    func dismissError() { phase = .idle }
}
