import SwiftUI

/// Every racha, as a contact sheet.
///
/// This replaces the old stack of full-width cards. Three things changed and
/// each was a real complaint about the previous design:
///
/// - **Uniform tiles, two columns.** The old layout leaned on varying card
///   heights for rhythm, which reads as decoration rather than structure — the
///   size of a card said nothing true about the racha. A uniform grid says the
///   items are peers, which they are, and lets the pictures carry the page.
/// - **Image first, chrome last.** Each tile is a cut-out dish on a sheet of
///   paper with the caption beneath, so the gallery reads as a set of objects
///   rather than a list of containers.
/// - **One number at the top.** What the user is owed across everything open,
///   in the serif, large. It is the number people open the app for; everything
///   else on this screen is navigation.
struct GalleryView: View {
    var namespace: Namespace.ID

    @Environment(RachaRepository.self) private var repository
    @Environment(Navigator.self) private var navigator
    @State private var showingNew = false
    @State private var showingSettings = false

    private var states: [RachaState] { repository.allStates }
    private var history: HistoryIndex {
        HistoryIndex.build(from: states, meID: repository.meID)
    }

    private let columns = [GridItem(.flexible(), spacing: 18),
                           GridItem(.flexible(), spacing: 18)]

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                header.padding(.horizontal, 22)

                if states.isEmpty {
                    EmptyGallery { showingNew = true }.padding(.horizontal, 22)
                } else {
                    LazyVGrid(columns: columns, alignment: .leading, spacing: 26) {
                        ForEach(states) { state in
                            Button {
                                Haptics.shared.press()
                                navigator.open(state.id)
                            } label: {
                                RachaTile(state: state, meID: repository.meID, namespace: namespace)
                            }
                            .buttonStyle(TileButtonStyle())
                        }
                    }
                    .padding(.horizontal, 22)
                }

                Color.clear.frame(height: 80)
            }
            .padding(.top, 56)
        }
        .scrollIndicators(.hidden)
        .safeAreaInset(edge: .bottom) {
            RachaButton(title: "Novo racha", icon: "plus") {
                Haptics.shared.press(); showingNew = true
            }
            .padding(.horizontal, 22)
            .padding(.bottom, 8)
        }
        .sheet(isPresented: $showingNew) { NewRachaSheet() }
        .sheet(isPresented: $showingSettings) { SettingsSheet() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(Self.month.string(from: Date())).receiptLabel()
                    Text("Rachas")
                        .font(Typo.galleryTitle)
                        .foregroundStyle(Palette.ink)
                }
                Spacer()
                Button { showingSettings = true } label: {
                    Image(systemName: "gearshape")
                        .font(.system(size: 16, weight: .regular))
                        .foregroundStyle(Palette.ink3)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Ajustes")
            }

            let net = history.netPosition
            if net.isZero {
                Text("Tudo quite")
                    .font(Typo.display)
                    .foregroundStyle(Palette.positive)
            } else {
                VStack(alignment: .leading, spacing: 3) {
                    Text(net.isNegative ? "Você deve" : "Te devem").receiptLabel()
                    AnimatedMoney(cents: net.magnitude,
                                  font: Typo.galleryNet,
                                  color: net.isNegative ? Palette.action : Palette.ink)
                    if !history.outstanding.isEmpty {
                        Text(history.outstanding.prefix(3).map(\.name.firstWord)
                                .joined(separator: " · "))
                            .font(Typo.caption)
                            .foregroundStyle(Palette.ink3)
                    }
                }
            }
        }
    }

    private static let month: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "pt_BR")
        f.dateFormat = "MMMM yyyy"
        return f
    }()
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

struct EmptyGallery: View {
    var onCreate: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Nada por aqui ainda")
                .font(Typo.display)
                .foregroundStyle(Palette.ink)
            Text("Um racha é uma conversa. Manda a foto da nota, ou só fala o que rolou — “a picanha foi eu, o Gui e a Ju”.")
                .font(Typo.body)
                .foregroundStyle(Palette.ink3)
                .fixedSize(horizontal: false, vertical: true)
            RachaButton(title: "Começar", icon: "sparkles", action: onCreate)
                .padding(.top, 4)
        }
        .padding(.vertical, 20)
    }
}

extension String {
    var firstWord: String { split(separator: " ").first.map(String.init) ?? self }
}
