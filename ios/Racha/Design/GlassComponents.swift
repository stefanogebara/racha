import SwiftUI

/// The app's surface.
///
/// Not `.ultraThinMaterial`. The system materials are excellent and completely
/// generic — they would make Racha look like Settings. This card composes the
/// blur with the web app's exact glass tokens, a hairline rim that catches the
/// device tilt, and the refraction shader, so a Racha card is identifiable from
/// across a room.
struct GlassCard<Content: View>: View {
    var cornerRadius: CGFloat = 20
    var padding: CGFloat = 18
    /// Off for large scrolling collections: refraction is a layer effect and
    /// running twenty of them at once is the one way these visuals become a
    /// battery problem.
    var refract: Bool = true
    @ViewBuilder var content: Content

    @State private var tilt = TiltSource.shared
    @State private var clock = ShaderClock.shared
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        content
            .padding(padding)
            .background {
                if reduceTransparency {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(Palette.warmWhite)
                } else {
                    surface
                }
            }
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(rimGradient, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            // No shadow. Depth on the table is a hairline and a shade; only the
            // paper comanda is allowed to cast one.
    }

    private var surface: some View {
        // The docblock above opens with "Not `.ultraThinMaterial`" and this line
        // used to be exactly that. On the night ground (#27) the system material
        // resolves to a light-grey slab, which is the "looks like Settings"
        // outcome the card exists to avoid — and it washed the cream text on it
        // toward illegible. The palette's own answer is a flat step, because
        // depth here is a hairline and a shade, not a light.
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(Palette.surface)
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(Palette.glassCard)
            }
            .modifier(RefractionModifier(enabled: refract, cornerRadius: cornerRadius,
                                         tilt: tilt.tilt, time: clock.time))
    }

    /// The rim brightens on the side the light comes from. It is one hairline and
    /// it is most of why the card reads as a physical object.
    private var rimGradient: LinearGradient {
        let lean = tilt.tilt.x
        return LinearGradient(
            colors: [
                Palette.glassBorder.opacity(0.95 - lean * 0.25),
                Palette.glassBorder.opacity(0.45),
                Palette.glassBorder.opacity(0.70 + lean * 0.25)
            ],
            startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

private struct RefractionModifier: ViewModifier {
    let enabled: Bool
    let cornerRadius: CGFloat
    let tilt: CGPoint
    let time: Double
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        if enabled && !reduceTransparency {
            content.liquidGlass(cornerRadius: cornerRadius, tilt: tilt, strength: 0.85, time: time)
        } else {
            content
        }
    }
}

/// The burgundy pill from the web app, with the press shader on it.
struct RachaButton: View {
    var title: String
    var icon: String?
    var style: Style = .primary
    var action: () -> Void

    enum Style { case primary, ghost, quiet }

    @State private var press: Double = 0
    @State private var touch: CGPoint = .zero

    var body: some View {
        GeometryReader { geo in
            label
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(Rectangle())
                .pressResponse(press, at: touch)
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            if press == 0 { Haptics.shared.press() }
                            touch = value.location
                            withAnimation(Motion.snappy) { press = 1 }
                        }
                        .onEnded { value in
                            withAnimation(Motion.snappy) { press = 0 }
                            let inside = geo.frame(in: .local).contains(value.location)
                            if inside { action() }
                        }
                )
        }
        .frame(height: style == .primary ? 54 : 46)
        // The press effect needs a raw DragGesture (a Button swallows the touch
        // location the shader wants), which costs the button its identity: to
        // VoiceOver, Switch Control and the automation runner this was a piece
        // of text. Every primary action in the app — Começar, Pagar, Escanear —
        // was unreachable without sight. The gesture stays; the role comes back.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(title))
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { action() }
    }

    @ViewBuilder private var label: some View {
        HStack(spacing: 8) {
            if let icon { Image(systemName: icon).font(.system(size: 15, weight: .semibold)) }
            Text(title).font(Typo.button)
        }
        .foregroundStyle(foreground)
        .frame(maxWidth: .infinity)
        .background(background)
        .clipShape(Capsule())
        .overlay {
            if style == .ghost {
                Capsule().strokeBorder(Palette.inputBorder, style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
            }
        }
        .shadow(color: style == .primary ? Palette.burgundy.opacity(0.28) : .clear, radius: 18, y: 6)
    }

    private var foreground: Color {
        switch style {
        case .primary: return .white
        case .ghost, .quiet: return Palette.stone
        }
    }

    @ViewBuilder private var background: some View {
        switch style {
        case .primary:
            LinearGradient(colors: [Palette.burgundy, Palette.burgundyDark],
                           startPoint: .top, endPoint: .bottom)
        case .ghost:
            Color.clear
        case .quiet:
            Palette.glassSubtle
        }
    }
}

/// The 46pt-radius chip from the web app's `.mode`.
struct RachaChip: View {
    var title: String
    var isOn: Bool
    var action: () -> Void

    var body: some View {
        Button {
            Haptics.shared.tick()
            withAnimation(Motion.snappy) { action() }
        } label: {
            Text(title)
                .font(Typo.bodyMedium)
                .foregroundStyle(isOn ? Palette.charcoal : Palette.stone)
                .padding(.vertical, 11)
                .padding(.horizontal, 16)
                .background {
                    Capsule().fill(isOn ? Palette.fieldHigh : Palette.glassSubtle)
                }
                .overlay {
                    Capsule().strokeBorder(isOn ? Palette.charcoal : Palette.hairline, lineWidth: 1)
                }
        }
        .buttonStyle(.plain)
    }
}

/// A person, as a warm disc with their initials. Stable colour across rachas.
struct AvatarBubble: View {
    var participant: Participant
    var size: CGFloat = 30
    var isMe: Bool = false

    var body: some View {
        ZStack {
            Circle().fill(Palette.avatar(seed: participant.avatarSeed).gradient)
            Text(participant.initials)
                .font(.system(size: size * 0.38, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
        }
        .frame(width: size, height: size)
        .overlay {
            Circle().strokeBorder(isMe ? Palette.charcoal.opacity(0.55) : .white.opacity(0.6),
                                  lineWidth: isMe ? 1.5 : 1)
        }
        .shadow(color: .black.opacity(0.10), radius: 3, y: 1)
    }
}

/// Overlapping avatars for a group. Caps at four plus a count.
struct AvatarStack: View {
    var participants: [Participant]
    var size: CGFloat = 26
    var meID: Participant.ID?

    var body: some View {
        HStack(spacing: -size * 0.32) {
            ForEach(participants.prefix(4)) { p in
                AvatarBubble(participant: p, size: size, isMe: p.id == meID)
            }
            if participants.count > 4 {
                Text("+\(participants.count - 4)")
                    .font(.system(size: size * 0.36, weight: .semibold))
                    .foregroundStyle(Palette.stone)
                    .frame(width: size, height: size)
                    .background(Circle().fill(Palette.glassSubtle))
                    .overlay { Circle().strokeBorder(.white.opacity(0.6), lineWidth: 1) }
            }
        }
    }
}

/// The liquid progress bar. Vertical fill direction is handled by rotating the
/// shader's `uv.x` axis at the call site.
struct LiquidProgress: View {
    var fill: Double
    var height: CGFloat = 10
    /// Rises briefly when the value changes, so the surface sloshes on update.
    @State private var energy: Double = 0
    @State private var clock = ShaderClock.shared
    @State private var hold = ClockSubscription()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { geo in
            Rectangle()
                .fill(.clear)
                .colorEffect(RachaShader.progressLiquid(
                    size: geo.size,
                    fill: fill.clamped(to: 0...1),
                    time: reduceMotion ? 0 : clock.time,
                    energy: reduceMotion ? 0 : energy))
        }
        .frame(height: height)
        .clipShape(Capsule())
        .onDisappear { hold.want(false) }
        .onChange(of: fill) {
            guard !reduceMotion else { return }
            // The slosh is a reaction to a payment landing, not an idle state.
            // Holding the clock for the bar's whole life animated a progress
            // bar that was not moving.
            hold.want(true)
            withAnimation(.easeOut(duration: 0.12)) { energy = 1 }
            withAnimation(.easeInOut(duration: 1.4).delay(0.12)) { energy = 0.15 }
            Task {
                try? await Task.sleep(for: .seconds(1.8))
                hold.want(false)
            }
        }
        .accessibilityElement()
        .accessibilityLabel("Progresso do pagamento")
        .accessibilityValue("\(Int(fill * 100)) por cento")
    }
}

/// Money that animates between values digit-stably.
///
/// The count-up is not decoration: watching R$ 284,00 become R$ 327,40 is how a
/// person notices the agent changed something. A number that teleports is a
/// number that can change without being seen — which is the exact failure mode
/// the product forbids.
/// Dinheiro que anima a troca de dígitos — SEM guardar cópia do valor.
///
/// A versão anterior espelhava o valor num `@State displayed`, semeado no
/// `onAppear` e atualizado por `onChange`. Numa tela de pagamento isso produziu
/// exatamente o que um espelho produz quando dessincroniza: na galeria, o herói
/// "Sua parte" ficou em **R$ 72,50** enquanto o botão logo abaixo dizia
/// **Pagar R$ 90,10** — os dois lendo `state.due(of: me)`, a mesma variável na
/// mesma avaliação do corpo. Estável, oito segundos depois de abrir. A folha de
/// pagar renderiza o mesmo `due` com um `Text` comum e sempre acertou; quem
/// espelha erra.
///
/// E o defeito era INVISÍVEL pra suíte de testes: o `.accessibilityLabel`
/// carregava o valor verdadeiro, então o XCUITest — que lê a árvore de
/// acessibilidade — via 90,10 e passava. Quem ouve a tela ouvia o número certo;
/// quem olha lia o errado. Doze fluxos verdes não podiam ver isso.
///
/// Autorização obtida sobre um valor que não é o valor é CDC art. 6º III, e é a
/// mesma família do defeito que a revisão de compliance achou na web quando a
/// folha da carteira cotava a moeda errada.
///
/// Agora o texto é DERIVADO de `cents`, e não há estado onde divergir.
/// `.contentTransition(.numericText)` com `.animation(_:value:)` dá a mesma
/// animação de dígitos na TROCA, que é pra isso que ela existe — não pra
/// encenar uma contagem a partir de zero na primeira aparição.
struct AnimatedMoney: View {
    var cents: Cents
    var currency: Currency = .brl
    var font: Font = Typo.display
    var color: Color = Palette.charcoal

    var body: some View {
        Text(BRL.format(cents, currency: currency))
            .font(font)
            .money()
            .foregroundStyle(color)
            .contentTransition(.numericText(value: Double(cents.raw)))
            .animation(Motion.ledger, value: cents)
            .accessibilityLabel(BRL.format(cents, currency: currency))
    }
}
