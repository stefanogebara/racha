import SwiftUI

/// The text field.
///
/// Grows to five lines then scrolls. `.submitLabel(.send)` and a hardware-return
/// handler both send, because someone typing fast with a keyboard attached should
/// not have to reach for a button.
struct ComposerField: View {
    @Binding var text: String
    @FocusState.Binding var isFocused: Bool
    var onSend: () -> Void

    var body: some View {
        TextField("fala aí…", text: $text, axis: .vertical)
            .font(Typo.body)
            .foregroundStyle(Palette.charcoal)
            .lineLimit(1...5)
            .focused($isFocused)
            .submitLabel(.send)
            .onSubmit(onSend)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(Palette.field)
            }
            .overlay {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(isFocused ? Palette.charcoal.opacity(0.22) : Palette.inputBorder,
                                  lineWidth: 1)
            }
            .animation(Motion.snappy, value: isFocused)
    }
}

/// Send, which becomes stop while the agent is talking.
///
/// The same button for both is intentional: interrupting is a first-class action
/// here, not a hidden one. If the agent starts doing the wrong thing to your bill,
/// stopping it must be exactly where your thumb already is.
struct SendButton: View {
    var isActive: Bool
    var isBusy: Bool
    var action: () -> Void

    @State private var rotation: Double = 0

    var body: some View {
        Button {
            Haptics.shared.press()
            action()
        } label: {
            ZStack {
                Circle()
                    .fill(isBusy || isActive
                          ? AnyShapeStyle(LinearGradient(colors: [Palette.burgundy, Palette.burgundyDark],
                                                         startPoint: .top, endPoint: .bottom))
                          : AnyShapeStyle(Palette.charcoal.opacity(0.10)))
                    .frame(width: 44, height: 44)

                if isBusy {
                    // A ring, not a spinner: the system spinner would be the one
                    // completely generic pixel in the app.
                    Circle()
                        .trim(from: 0.08, to: 0.92)
                        .stroke(.white, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                        .frame(width: 18, height: 18)
                        .rotationEffect(.degrees(rotation))
                        .onAppear {
                            withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) {
                                rotation = 360
                            }
                        }
                        .onDisappear { rotation = 0 }
                    RoundedRectangle(cornerRadius: 2, style: .continuous)
                        .fill(.white)
                        .frame(width: 7, height: 7)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(isActive ? .white : Palette.stone)
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(!isActive && !isBusy)
        .animation(Motion.snappy, value: isActive)
        .animation(Motion.snappy, value: isBusy)
        .accessibilityLabel(isBusy ? "Parar" : "Enviar")
    }
}

/// What to say when the thread is empty.
///
/// The suggestions are generated from the racha's actual state — an empty racha
/// offers "manda a foto da nota"; one with unclaimed items offers to divide them.
/// A static list of prompts would be a tutorial; this is a next step.
struct ThreadOpener: View {
    var state: RachaState
    var onPick: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(headline)
                .font(Typo.serifBody)
                .foregroundStyle(Palette.charcoal)
                .fixedSize(horizontal: false, vertical: true)

            FlowLayout(spacing: 8) {
                ForEach(suggestions, id: \.self) { suggestion in
                    Button {
                        Haptics.shared.tick()
                        onPick(suggestion)
                    } label: {
                        Text(suggestion)
                            .font(Typo.small)
                            .foregroundStyle(Palette.charcoal)
                            .padding(.horizontal, 13)
                            .padding(.vertical, 9)
                            .background(Capsule().fill(Palette.field))
                            .overlay { Capsule().strokeBorder(Palette.hairline, lineWidth: 1) }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(.vertical, 8)
    }

    /// Concordância mora em `ThreadCopy`, que é testável. Aqui era texto
    /// montado à mão dentro do corpo de uma View, e a tela dizia "Faltam 1
    /// itens sem dono".
    private var headline: String {
        ThreadCopy.headline(itemCount: state.items.count,
                            unassignedCount: state.split.unassigned.count)
    }

    private var suggestions: [String] {
        var out: [String] = []
        if state.items.isEmpty {
            out = ["dividir tudo por igual", "adiciona a Uber de 38 reais"]
        } else if state.split.hasUnassigned {
            let names = state.items.filter { state.claims(for: $0.id).isEmpty }
                .prefix(2).map { $0.name.lowercased() }
            // "a pudim foi minha" — artigo e adjetivo femininos num nome
            // masculino. Não há conserto por concordância (o gênero de um nome
            // de prato arbitrário é desconhecido), então a frase deixa de pedir
            // gênero. Ver `ThreadCopy`.
            out = names.map { ThreadCopy.claimSuggestion(itemName: $0) }
            out.append("divide o resto por igual")
        } else {
            out = ["quanto cada um deve?", "manda o Pix pra galera"]
        }
        out.append("quanto o pessoal ainda me deve?")
        return out
    }
}

/// Wrapping chips. `Layout` rather than a `LazyVGrid` because the chips have
/// wildly different widths and a grid would leave ragged holes.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x + size.width > width, x > 0 {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: proposal.width ?? x, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize,
                       subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
