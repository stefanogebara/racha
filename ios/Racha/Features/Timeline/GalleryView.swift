import SwiftUI

/// The first screen is the table you are sitting at.
///
/// Racha is pay-at-table: the QR on the table opens the bill, the conversation
/// splits it, and each person pays the house their own part. So the home screen
/// leads with the one open table — your part as the figure, what the table still
/// lacks and who has not paid, and the one action, Pagar — and puts the tables
/// before it underneath as history. With no table open, it asks you to scan.
struct GalleryView: View {
    var namespace: Namespace.ID

    @Environment(RachaRepository.self) private var repository
    @Environment(Navigator.self) private var navigator
    @State private var showingNew = false
    @State private var showingSettings = false
    @State private var paying = false
    @State private var payingID: UUID?

    private var states: [RachaState] { repository.allStates }
    /// The table you are at: the most recent one that is not closed.
    private var current: RachaState? { states.first { !$0.isSettled } }
    private var past: [RachaState] { states.filter { $0.id != current?.id } }

    private let columns = [GridItem(.flexible(), spacing: 12),
                           GridItem(.flexible(), spacing: 12)]

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 32) {
                header.padding(.horizontal, 24)

                if let table = current {
                    now(table).padding(.horizontal, 24)
                } else {
                    scanPrompt.padding(.horizontal, 24)
                }

                if !past.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Mesas anteriores").metaLabel()
                        LazyVGrid(columns: columns, alignment: .leading, spacing: 12) {
                            ForEach(past) { state in
                                Button {
                                    Haptics.shared.press()
                                    navigator.open(state.id)
                                } label: {
                                    RachaTile(state: state, meID: repository.meID, namespace: namespace)
                                }
                                .buttonStyle(TileButtonStyle())
                            }
                        }
                    }
                    .padding(.horizontal, 24)
                }

                Color.clear.frame(height: 58)
            }
            .padding(.top, 58)
        }
        .scrollIndicators(.hidden)
        .sheet(isPresented: $showingNew) { NewRachaSheet() }
        .sheet(isPresented: $showingSettings) { SettingsSheet() }
        .sheet(isPresented: $paying) { if let id = payingID { SettleSheet(rachaID: id) } }
    }

    private var header: some View {
        HStack(alignment: .center) {
            Text("Rachas")
                .font(Typo.tileTitle)
                .foregroundStyle(Palette.ink)
            Spacer()
            Button("Ajustes") { showingSettings = true }
                .font(Typo.bodyMedium)
                .foregroundStyle(Palette.ink2)
                .buttonStyle(.plain)
        }
    }

    /// The table you are at.
    private func now(_ table: RachaState) -> some View {
        let me = repository.meID
        let due = table.due(of: me)
        let others = table.unpaidParticipants.filter { $0.id != me }
        return VStack(alignment: .leading, spacing: 6) {
            Text([table.venue?.name ?? table.title, table.venue?.tableLabel, "agora"]
                    .compactMap { $0 }.joined(separator: " · "))
                .metaLabel()
            Text(due.isZero ? "Sua parte, paga" : "Sua parte")
                .metaLabel()
                .padding(.top, 6)
            AnimatedMoney(cents: due.isZero ? table.share(of: me) : due,
                          font: Typo.hero,
                          color: Palette.ink)
            Text(tableLine(table, others: others))
                .font(Typo.small)
                .foregroundStyle(Palette.ink3)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 10)
            if !due.isZero {
                RachaButton(title: "Pagar \(BRL.format(due, currency: table.currency))", icon: nil) {
                    Haptics.shared.press(); payingID = table.id; paying = true
                }
                .padding(.top, 22)
            }
            RachaButton(title: "Abrir a conversa", icon: nil, style: .ghost) {
                Haptics.shared.press(); navigator.open(table.id)
            }
            .padding(.top, due.isZero ? 22 : 10)
        }
    }

    private func tableLine(_ table: RachaState, others: [Participant]) -> String {
        var parts: [String] = []
        if table.remainingOnTable.isZero {
            parts.append("Mesa paga")
        } else {
            var line = "Falta \(BRL.format(table.remainingOnTable, currency: table.currency)) na mesa"
            if !others.isEmpty {
                line += " · \(others.map(\.shortName).joinedPtBR()) ainda não \(others.count == 1 ? "pagou" : "pagaram")"
            }
            parts.append(line)
        }
        let unowned = table.split.unassigned.count
        if unowned > 0 { parts.append("\(unowned) \(unowned == 1 ? "item" : "itens") sem dono") }
        return parts.joined(separator: " · ")
    }

    /// No table open: the QR is the way in. The scanner lands with the POS
    /// adapter; until then this opens the manual sheet, which is the same racha
    /// without the house's Pix.
    private var scanPrompt: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Nenhuma mesa aberta").metaLabel()
            Text("Sentou? Escaneia.")
                .font(Typo.display)
                .foregroundStyle(Palette.ink)
            Text("O QR da mesa abre a conta item por item. Você fala o que foi de quem, e cada um paga a casa direto no Pix.")
                .font(Typo.body)
                .foregroundStyle(Palette.ink3)
                .fixedSize(horizontal: false, vertical: true)
            RachaButton(title: "Escanear o QR da mesa", icon: "qrcode.viewfinder") {
                Haptics.shared.press(); showingNew = true
            }
            .padding(.top, 8)
        }
    }
}

/// A tile presses by dimming and settling, not by scaling — twelve tiles that
/// scale on touch make the grid feel rubbery.
private struct TileButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.72 : 1)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(Motion.snappy, value: configuration.isPressed)
    }
}

/// Kept for the onboarding flow, which shows it before the first table exists.
struct EmptyGallery: View {
    var onCreate: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Sentou? Escaneia.")
                .font(Typo.display)
                .foregroundStyle(Palette.ink)
            Text("O QR da mesa abre a conta item por item. Você fala o que foi de quem — “a picanha foi eu, o Gui e a Ju” — e cada um paga a casa direto.")
                .font(Typo.body)
                .foregroundStyle(Palette.ink3)
                .fixedSize(horizontal: false, vertical: true)
            RachaButton(title: "Escanear o QR da mesa", icon: "qrcode.viewfinder", action: onCreate)
                .padding(.top, 4)
        }
        .padding(.vertical, 20)
    }
}

extension String {
    var firstWord: String { split(separator: " ").first.map(String.init) ?? self }
}
