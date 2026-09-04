import SwiftUI

/// Every racha, as a scrollable magazine.
///
/// Layout notes that matter:
/// - Cards are full-bleed and tall (cover image on top, ledger line beneath), so
///   the images carry the page rather than decorating a list.
/// - Cards scale and fade with their scroll position via `scrollTransition`, so
///   the stack has depth without a carousel's disorientation.
/// - The header is the one place the user's *whole* position appears: what they
///   are owed across everything, in the serif, large. It is the number people
///   open the app for.
struct TimelineView: View {
    var namespace: Namespace.ID

    @Environment(RachaRepository.self) private var repository
    @Environment(Navigator.self) private var navigator
    @State private var showingNew = false
    @State private var showingSettings = false

    private var states: [RachaState] { repository.allStates }
    private var history: HistoryIndex {
        HistoryIndex.build(from: states, meID: repository.meID)
    }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 18) {
                header
                    .padding(.horizontal, 20)
                    .padding(.bottom, 4)

                if states.isEmpty {
                    EmptyTimeline { showingNew = true }
                        .padding(.horizontal, 20)
                }

                ForEach(states) { state in
                    RachaCard(state: state,
                              meID: repository.meID,
                              namespace: namespace)
                        .padding(.horizontal, 20)
                        .scrollTransition(axis: .vertical) { view, phase in
                            view
                                .scaleEffect(phase.isIdentity ? 1 : 0.92)
                                .opacity(phase.isIdentity ? 1 : 0.35)
                                .blur(radius: phase.isIdentity ? 0 : 3)
                        }
                        .onTapGesture {
                            Haptics.shared.press()
                            navigator.open(state.id)
                        }
                }

                Color.clear.frame(height: 96)
            }
            .padding(.top, 8)
        }
        .scrollIndicators(.hidden)
        .safeAreaInset(edge: .bottom) { composerBar }
        .sheet(isPresented: $showingNew) { NewRachaSheet() }
        .sheet(isPresented: $showingSettings) { SettingsSheet() }
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Racha")
                    .font(Typo.venue)
                    .foregroundStyle(Palette.charcoal)
                Spacer()
                Button { showingSettings = true } label: {
                    Image(systemName: "gearshape")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(Palette.stone)
                }
                .buttonStyle(.plain)
            }

            let net = history.netPosition
            if !net.isZero {
                VStack(alignment: .leading, spacing: 2) {
                    Text(net.isNegative ? "Você deve" : "Te devem")
                        .rachaLabel()
                    AnimatedMoney(cents: net.magnitude,
                                  font: Typo.hero,
                                  color: net.isNegative ? Palette.burgundy : Palette.emerald)
                    if history.outstanding.count > 1 {
                        Text(outstandingSummary)
                            .font(Typo.small)
                            .foregroundStyle(Palette.stone)
                    }
                }
            } else if !states.isEmpty {
                Text("Tudo acertado.")
                    .font(Typo.serifBody)
                    .foregroundStyle(Palette.emerald)
            }
        }
    }

    private var outstandingSummary: String {
        let names = history.outstanding.prefix(3).map(\.name.firstWord)
        let rest = history.outstanding.count - names.count
        let list = names.joined(separator: ", ")
        return rest > 0 ? "\(list) e mais \(rest)" : list
    }

    // MARK: Bottom bar

    private var composerBar: some View {
        HStack(spacing: 10) {
            RachaButton(title: "Novo racha", icon: "plus") {
                Haptics.shared.press()
                showingNew = true
            }
            .frame(maxWidth: .infinity)
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 8)
    }
}

private extension String {
    var firstWord: String { split(separator: " ").first.map(String.init) ?? self }
}

/// What the timeline shows before there is anything in it.
struct EmptyTimeline: View {
    var onCreate: () -> Void

    var body: some View {
        GlassCard(cornerRadius: 24, padding: 28) {
            VStack(spacing: 14) {
                Text("Nada por aqui ainda")
                    .font(Typo.serifBody)
                    .foregroundStyle(Palette.charcoal)
                Text("Um racha é uma conversa. Manda a foto da nota, ou só fala o que rolou — “a picanha foi eu, o Gui e a Ju”.")
                    .font(Typo.body)
                    .foregroundStyle(Palette.stone)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                RachaButton(title: "Começar", icon: "sparkles", action: onCreate)
            }
        }
    }
}
