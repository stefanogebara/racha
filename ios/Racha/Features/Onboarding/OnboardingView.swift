import SwiftUI

/// First run.
///
/// Three beats, and each one earns its place:
///
/// 1. **Abertura** — say what this is, and prove it. The proof is a real bill
///    divided by the real engine, with genuinely *unequal* parts (Ju didn't
///    drink, so her share is smaller). An equal split would demonstrate
///    nothing — anyone can divide by three.
/// 2. **Seu nome** — the one thing the app cannot work without, since every
///    split needs to know who "você" is. The Pix key is offered here because
///    this is the only moment where explaining *why* costs nothing, and it is
///    plainly optional.
/// 3. **Por onde começar** — three real doors, not three tour slides.
///
/// What this deliberately is not: a feature carousel. The product's whole claim
/// is that you just talk to it, so the fastest honest demonstration is to stop
/// talking and let the person start.
struct OnboardingView: View {
    @Environment(AppSettings.self) private var settings
    @Environment(RachaRepository.self) private var repository
    @Environment(Navigator.self) private var navigator

    /// Called with the door the person picked. The host decides what to open.
    var onFinish: (Door) -> Void

    enum Door { case camera, talk, example }

    @State private var step = 0
    @State private var name = ""
    @State private var pixKey = ""
    @FocusState private var nameFocused: Bool

    var body: some View {
        ZStack {
            PaperBackground()
            cover.opacity(step == 0 ? 1 : 0).offset(x: step == 0 ? 0 : -28)
            askName.opacity(step == 1 ? 1 : 0).offset(x: step == 1 ? 0 : (step < 1 ? 28 : -28))
            doors.opacity(step == 2 ? 1 : 0).offset(x: step == 2 ? 0 : 28)
        }
        .animation(Motion.fluid, value: step)
        .transaction { if step == 0 { $0.disablesAnimations = false } }
    }

    // MARK: 1 — Abertura

    private var cover: some View {
        VStack(alignment: .leading, spacing: 0) {
            StillLifeView(dishes: ["Chopp 500ml", "Farofa da casa", "Picanha na chapa"])
                .frame(height: 268)
                .padding(.horizontal, -10)

            VStack(alignment: .leading, spacing: 13) {
                Text("Racha").receiptLabel()
                Text("Fala que eu\nfaço a conta.")
                    .font(Typo.onboardTitle)
                    .foregroundStyle(Palette.ink)
                    .lineSpacing(-2)
                Text("Manda a foto da nota ou só conta o que rolou. Eu divido, mostro onde cai cada centavo, e você confere.")
                    .font(Typo.body)
                    .foregroundStyle(Palette.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, 4)

            SplitProof().padding(.top, 26)

            Spacer(minLength: 20)

            VStack(spacing: 12) {
                RachaButton(title: "Começar") {
                    Haptics.shared.press(); step = 1
                }
                Text("sem cadastro · sem login · fica no aparelho")
                    .receiptLabel()
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(.horizontal, 26)
        .padding(.top, 58)
        .padding(.bottom, 26)
    }

    // MARK: 2 — Seu nome

    private var askName: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer()
            VStack(alignment: .leading, spacing: 26) {
                Text("Passo 1 de 2").receiptLabel()
                Text("Como te chamam?")
                    .font(Typo.onboardTitle)
                    .foregroundStyle(Palette.ink)

                BillField(text: $name, placeholder: "seu nome", size: 27,
                          hint: "É assim que você aparece nas divisões. Dá pra mudar depois.")
                    .focused($nameFocused)
                    .submitLabel(.next)
                    .onSubmit { if !trimmedName.isEmpty { step = 2 } }

                BillField(text: $pixKey, placeholder: "chave pix (opcional)", size: 20,
                          hint: "Só pra gerar o código quando **te deverem**. Fica no Keychain do aparelho — não sobe pra lugar nenhum.")
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            Spacer()
            VStack(spacing: 12) {
                RachaButton(title: "Continuar") {
                    guard !trimmedName.isEmpty else { return }
                    Haptics.shared.press(); step = 2
                }
                .opacity(trimmedName.isEmpty ? 0.35 : 1)
                .disabled(trimmedName.isEmpty)
                Dots(count: 2, current: 0)
            }
        }
        .padding(.horizontal, 26)
        .padding(.top, 58)
        .padding(.bottom, 26)
        .onAppear { DispatchQueue.main.asyncAfter(deadline: .now() + 0.34) { nameFocused = true } }
    }

    // MARK: 3 — Por onde começar

    private var doors: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer()
            VStack(alignment: .leading, spacing: 22) {
                Text("Passo 2 de 2").receiptLabel()
                Text(greeting)
                    .font(Typo.onboardTitle)
                    .foregroundStyle(Palette.ink)

                VStack(spacing: 0) {
                    DoorRow(dish: "Picanha na chapa", title: "Fotografar a nota",
                            detail: "eu leio os itens e monto a conta") { finish(.camera) }
                    DoorRow(dish: "Chopp 500ml", title: "Só falar o que rolou",
                            detail: "“a picanha foi eu, o Gui e a Ju”") { finish(.talk) }
                    DoorRow(dish: "Vinagrete", title: "Ver um exemplo",
                            detail: "abre rachas prontos pra explorar", quiet: true,
                            isLast: true) { finish(.example) }
                }
            }
            Spacer()
            Dots(count: 2, current: 1)
        }
        .padding(.horizontal, 26)
        .padding(.top, 58)
        .padding(.bottom, 26)
    }

    // MARK: Plumbing

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var greeting: String {
        let first = trimmedName.split(separator: " ").first.map(String.init)
        return first.map { "Bora, \($0)." } ?? "Bora, então."
    }

    private func finish(_ door: Door) {
        Haptics.shared.press()
        if !trimmedName.isEmpty { settings.myName = trimmedName }
        let key = pixKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if !key.isEmpty { settings.myPixKey = key }
        settings.hasOnboarded = true
        onFinish(door)
    }
}

// MARK: - Pieces

/// The proof: a real bill from the sample data, divided by the real engine.
///
/// It uses the churrasco rather than the dinner because the dinner has an
/// unclaimed item, and a claim that needs a caveat ("plus R$ 18,00 nobody has
/// taken yet") is not a proof. Here the parts sum to the total exactly, and
/// they are unequal for a reason a person immediately understands.
private struct SplitProof: View {
    @Environment(RachaRepository.self) private var repository

    var body: some View {
        if let state = sample {
            let split = state.split
            VStack(alignment: .leading, spacing: 11) {
                HStack(alignment: .firstTextBaseline) {
                    Text("\(state.title) · \(state.participants.count) pessoas").receiptLabel()
                    Spacer()
                    Text(BRL.format(split.total, currency: state.currency))
                        .font(Typo.proofTotal).money().foregroundStyle(Palette.ink)
                }
                HStack(spacing: 1) {
                    ForEach(Array(split.shares.enumerated()), id: \.offset) { index, share in
                        VStack(spacing: 3) {
                            Text(state.participant(share.personID)?.shortName.lowercased() ?? "—")
                                .receiptLabel()
                            Text(BRL.format(share.total, currency: state.currency))
                                .font(Typo.proofPart).money().foregroundStyle(Palette.ink)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Palette.paper)
                        .transition(.opacity)
                        .animation(Motion.fluid.delay(0.2 + Double(index) * 0.1), value: split.total)
                    }
                }
                .background(Palette.hairline)
                .overlay(alignment: .top) { Rectangle().fill(Palette.hairline).frame(height: 1) }
                .overlay(alignment: .bottom) { Rectangle().fill(Palette.hairline).frame(height: 1) }

                Text(caption(for: split))
                    .font(Typo.caption)
                    .foregroundStyle(Palette.ink3)
                    .frame(maxWidth: .infinity)
                    .multilineTextAlignment(.center)
            }
        }
    }

    /// The sample with nothing unclaimed and unequal shares — the only kind of
    /// bill that can carry this claim without a footnote.
    private var sample: RachaState? {
        repository.allStates.first {
            let s = $0.split
            return !s.hasUnassigned && Set(s.shares.map(\.total)).count > 1 && s.shares.count >= 3
        }
    }

    private func caption(for split: SplitResult) -> String {
        let words = ["", "uma", "duas", "três", "quatro", "cinco", "seis"]
        let n = split.shares.count
        let word = n < words.count ? words[n] : "\(n)"
        return "As \(word) partes somam exatamente o total."
    }
}

/// A text field dressed as a line on the bill: serif above, rule under.
private struct BillField: View {
    @Binding var text: String
    var placeholder: String
    var size: CGFloat
    var hint: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField(placeholder, text: $text)
                .font(Typo.font(.serif, size))
                .foregroundStyle(Palette.ink)
                .padding(.vertical, 7)
                .overlay(alignment: .bottom) {
                    Rectangle()
                        .fill(text.isEmpty ? Palette.hairline : Palette.ink)
                        .frame(height: 1.5)
                        .animation(Motion.snappy, value: text.isEmpty)
                }
            Text(.init(hint))
                .font(Typo.caption)
                .foregroundStyle(Palette.ink3)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct DoorRow: View {
    var dish: String
    var title: String
    var detail: String
    var quiet: Bool = false
    var isLast: Bool = false
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 16) {
                DishImageView(cacheKey: ImageStyle.cacheKey(for: item),
                              prompt: ImageStyle.prompt(for: item),
                              category: item.category,
                              cornerRadius: 2, size: 256, inset: 0.05)
                    .frame(width: 54, height: 54)
                    .background {
                        LinearGradient(colors: [Palette.paperHigh, Palette.paperLow],
                                       startPoint: .top, endPoint: .bottom)
                    }

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(quiet ? Typo.body : Typo.bodyMedium)
                        .foregroundStyle(quiet ? Palette.ink2 : Palette.ink)
                    Text(detail)
                        .font(Typo.caption)
                        .foregroundStyle(Palette.ink3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 6)
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Palette.ink3.opacity(0.6))
            }
            .padding(.vertical, 20)
            .overlay(alignment: .top) { Rectangle().fill(Palette.hairline).frame(height: 1) }
            .overlay(alignment: .bottom) {
                if isLast { Rectangle().fill(Palette.hairline).frame(height: 1) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var item: LineItem {
        LineItem(name: dish, unitPrice: .zero, category: ItemCategorizer.guess(dish))
    }
}

private struct Dots: View {
    var count: Int
    var current: Int

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<count, id: \.self) { i in
                Circle()
                    .fill(i == current ? Palette.ink : Palette.ink3.opacity(0.45))
                    .frame(width: 5, height: 5)
            }
        }
        .frame(maxWidth: .infinity)
        .accessibilityLabel("Passo \(current + 1) de \(count)")
    }
}

/// Several dishes in one frame, sharing a light. A table is more than one plate,
/// and the opening screen's job is to show that before a word is read.
struct StillLifeView: View {
    var dishes: [String]

    var body: some View {
        GeometryReader { geo in
            ZStack {
                ForEach(Array(dishes.enumerated()), id: \.offset) { index, dish in
                    let plan = Self.layout[min(index, Self.layout.count - 1)]
                    DishImageView(cacheKey: ImageStyle.cacheKey(for: item(dish)),
                                  prompt: ImageStyle.prompt(for: item(dish)),
                                  category: item(dish).category,
                                  cornerRadius: 0, size: 512)
                        .frame(width: geo.size.height * plan.scale,
                               height: geo.size.height * plan.scale)
                        .position(x: geo.size.width * plan.x, y: geo.size.height * plan.y)
                        // Things further back sit slightly lighter, the way a
                        // shallow depth of field renders them.
                        .opacity(0.82 + plan.depth * 0.18)
                        .zIndex(plan.depth)
                }
            }
        }
    }

    private func item(_ name: String) -> LineItem {
        LineItem(name: name, unitPrice: .zero, category: ItemCategorizer.guess(name))
    }

    private static let layout: [(x: CGFloat, y: CGFloat, scale: CGFloat, depth: Double)] = [
        (0.17, 0.38, 0.60, 0.15),
        (0.82, 0.55, 0.54, 0.30),
        (0.50, 0.62, 0.88, 0.90),
    ]
}
