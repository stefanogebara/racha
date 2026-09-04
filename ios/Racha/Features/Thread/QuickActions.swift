import SwiftUI

/// The two or three things worth one tap.
///
/// Generated from state, so they are always the *next* thing rather than a fixed
/// toolbar. The person is in a loud bar at 15% battery: a row that reads "3 sem
/// dono · Acertar" is worth more than any menu.
struct QuickActions: View {
    var state: RachaState
    var onSettle: () -> Void
    var onAsk: (String) -> Void

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                if state.split.hasUnassigned {
                    chip("\(state.split.unassigned.count) sem dono", icon: "questionmark.circle",
                         tint: Palette.amber) {
                        onAsk("divide o que sobrou por igual entre todo mundo")
                    }
                }
                if !state.balances.allSatisfy(\.isSettled) {
                    chip("Acertar", icon: "arrow.left.arrow.right", tint: Palette.burgundy, action: onSettle)
                }
                chip("Quanto eu pago?", icon: "person.fill", tint: Palette.stone) {
                    onAsk("quanto eu pago?")
                }
                if state.extras.contains(where: { $0.isGratuity && $0.isEnabled }) {
                    chip("Tirar serviço", icon: "minus.circle", tint: Palette.stone) {
                        onAsk("tira o serviço")
                    }
                }
            }
            .padding(.horizontal, 2)
        }
        .scrollIndicators(.hidden)
    }

    private func chip(_ title: String, icon: String, tint: Color,
                      action: @escaping () -> Void) -> some View {
        Button {
            Haptics.shared.tick()
            action()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: icon).font(.system(size: 11, weight: .semibold))
                Text(title).font(Typo.small)
            }
            .foregroundStyle(tint)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Capsule().fill(Color.white.opacity(0.6)))
            .overlay { Capsule().strokeBorder(tint.opacity(0.22), lineWidth: 1) }
        }
        .buttonStyle(.plain)
    }
}

/// The ribbon that replaces the progress bar once everything is settled.
struct SettledRibbon: View {
    var kind: RachaKind
    @State private var shimmer: Double = -1

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.seal.fill")
                .foregroundStyle(Palette.emeraldBright)
            Text(kind.isRecurring ? "Ciclo fechado" : "Fechado, tudo quite")
                .font(Typo.bodyMedium)
                .foregroundStyle(Palette.emerald)
            Spacer()
        }
        .padding(.vertical, 9)
        .padding(.horizontal, 14)
        .background {
            Capsule()
                .fill(Palette.emeraldBright.opacity(0.12))
                .overlay {
                    // A single sheen crossing once on appear — the visual echo of the
                    // burst, for people who arrive at a racha that closed earlier.
                    Capsule()
                        .fill(LinearGradient(colors: [.clear, .white.opacity(0.55), .clear],
                                             startPoint: .leading, endPoint: .trailing))
                        .scaleEffect(x: 0.35, anchor: .center)
                        .offset(x: shimmer * 260)
                        .blendMode(.plusLighter)
                }
                .clipShape(Capsule())
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 1.1).delay(0.2)) { shimmer = 1 }
        }
    }
}
