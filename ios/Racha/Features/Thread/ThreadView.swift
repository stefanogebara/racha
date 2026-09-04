import SwiftUI
import PhotosUI

/// One racha, as a conversation.
///
/// Layout is three zones, top to bottom:
/// 1. a compact header that stays put (title, total, who's short);
/// 2. the transcript, which is the main surface;
/// 3. the composer, pinned above the keyboard.
///
/// The ledger itself is *not* a separate tab. It lives in a sheet reachable from
/// the header, because the thread is the product and a tab bar would say
/// otherwise. What the thread does show inline is every change the agent made,
/// as an undoable ribbon under the message that caused it.
struct ThreadView: View {
    let rachaID: UUID
    var namespace: Namespace.ID

    @Environment(RachaRepository.self) private var repository
    @Environment(Navigator.self) private var navigator
    @Environment(AppSettings.self) private var settings

    @State private var session: AgentSession?
    @State private var draft = ""
    @State private var photo: PhotosPickerItem?
    @State private var showingLedger = false
    @State private var showingSettle = false
    @State private var wasSettled = false
    @FocusState private var composerFocused: Bool

    private var state: RachaState? { repository.state(rachaID) }

    var body: some View {
        VStack(spacing: 0) {
            grabber
            header
            transcript
            composer
        }
        .background {
            RoundedRectangle(cornerRadius: 30, style: .continuous)
                .fill(.ultraThinMaterial)
                .overlay {
                    RoundedRectangle(cornerRadius: 30, style: .continuous)
                        .fill(Palette.glassPanel)
                }
                .ignoresSafeArea(edges: .bottom)
        }
        .overlay {
            RoundedRectangle(cornerRadius: 30, style: .continuous)
                .strokeBorder(Palette.glassBorder, lineWidth: 1)
                .ignoresSafeArea(edges: .bottom)
        }
        .clipShape(RoundedRectangle(cornerRadius: 30, style: .continuous))
        .matchedGeometryEffect(id: rachaID, in: namespace, isSource: false)
        .task(id: rachaID) { await startSession() }
        .onChange(of: state?.isSettled ?? false) { was, now in
            // The settled moment. Fired from the ledger's own truth, so it happens
            // whether the last payment came from a tap or from the agent.
            guard now, !was, !wasSettled else { return }
            wasSettled = true
            navigator.celebrate(rachaID, at: CGPoint(x: 200, y: 420))
        }
        .sheet(isPresented: $showingLedger) { LedgerSheet(rachaID: rachaID) }
        .sheet(isPresented: $showingSettle) { SettleSheet(rachaID: rachaID) }
        .onChange(of: photo) { _, item in Task { await attach(item) } }
    }

    // MARK: Chrome

    private var grabber: some View {
        Capsule()
            .fill(Palette.stone.opacity(0.28))
            .frame(width: 38, height: 5)
            .padding(.top, 10)
            .padding(.bottom, 6)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
            .onTapGesture { navigator.close() }
            .accessibilityLabel("Voltar para todos os rachas")
            .accessibilityAddTraits(.isButton)
    }

    @ViewBuilder private var header: some View {
        if let state {
            let split = state.split
            let remaining = (split.total - state.confirmedPaid).clampedNonNegative

            VStack(spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(state.title)
                            .font(Typo.venue)
                            .foregroundStyle(Palette.charcoal)
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                        Text("\(state.participants.count) pessoas · \(state.items.count) itens")
                            .font(Typo.caption)
                            .foregroundStyle(Palette.stone)
                    }
                    Spacer()
                    Button { Haptics.shared.tick(); showingLedger = true } label: {
                        VStack(alignment: .trailing, spacing: 1) {
                            Text("Total").rachaLabel()
                            AnimatedMoney(cents: split.total, currency: state.currency,
                                          font: Typo.serifBody)
                        }
                    }
                    .buttonStyle(.plain)
                }

                if !state.isSettled {
                    HStack(spacing: 10) {
                        LiquidProgress(fill: split.total.raw > 0
                                       ? Double(state.confirmedPaid.raw) / Double(split.total.raw) : 0,
                                       height: 7)
                        Text("falta \(BRL.format(remaining, currency: state.currency))")
                            .font(Typo.caption)
                            .money()
                            .foregroundStyle(Palette.stone)
                            .fixedSize()
                    }
                } else {
                    SettledRibbon(kind: state.kind)
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 12)
        }
    }

    // MARK: Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if let state, session?.messages.isEmpty == true {
                        ThreadOpener(state: state) { suggestion in
                            send(suggestion)
                        }
                        .padding(.horizontal, 18)
                    }

                    ForEach(session?.messages ?? []) { message in
                        MessageBubble(message: message) { edit in
                            Task {
                                Haptics.shared.undone()
                                await session?.undo(edit)
                            }
                        }
                        .padding(.horizontal, 18)
                        .id(message.id)
                        .transition(.asymmetric(
                            insertion: .move(edge: .bottom).combined(with: .opacity).combined(with: .scale(scale: 0.94, anchor: .bottom)),
                            removal: .opacity))
                    }

                    if let phase = session?.streamPhase, phase != .idle,
                       session?.messages.last?.isStreaming != true {
                        WorkingIndicator(phase: phase)
                            .padding(.horizontal, 18)
                            .id("working")
                    }

                    Color.clear.frame(height: 12).id("bottom")
                }
                .padding(.top, 4)
                .animation(Motion.fluid, value: session?.messages.count ?? 0)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: session?.messages.last?.text) {
                withAnimation(.easeOut(duration: 0.22)) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: session?.messages.count) {
                withAnimation(Motion.fluid) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
    }

    // MARK: Composer

    private var composer: some View {
        VStack(spacing: 10) {
            if let state, !state.isSettled, !state.participants.isEmpty {
                QuickActions(state: state,
                             onSettle: { showingSettle = true },
                             onAsk: { send($0) })
            }

            HStack(alignment: .bottom, spacing: 10) {
                PhotosPicker(selection: $photo, matching: .images) {
                    Image(systemName: "camera.fill")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(Palette.stone)
                        .frame(width: 44, height: 44)
                        .background(Circle().fill(Palette.glassSubtle))
                        .overlay { Circle().strokeBorder(Palette.hairline, lineWidth: 1) }
                }
                .accessibilityLabel("Mandar foto da nota")

                ComposerField(text: $draft, isFocused: $composerFocused) {
                    send(draft)
                }

                SendButton(isActive: !draft.trimmingCharacters(in: .whitespaces).isEmpty,
                           isBusy: session?.isThinking ?? false) {
                    if session?.isThinking == true {
                        session?.cancel()
                    } else {
                        send(draft)
                    }
                }
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, 10)
        .padding(.bottom, 12)
        .background {
            Rectangle()
                .fill(.thinMaterial)
                .overlay(Rectangle().fill(Palette.glassSubtle))
                .mask(LinearGradient(colors: [.clear, .black, .black],
                                     startPoint: .top, endPoint: .center))
                .ignoresSafeArea(edges: .bottom)
        }
    }

    // MARK: Actions

    private func startSession() async {
        guard session?.rachaID != rachaID else { return }
        let transport: any AgentTransport = settings.hasAgentKey
            ? LiveTransport()
            : MockTransport()
        let client = AnthropicClient(config: .opus(key: settings.anthropicKey), transport: transport)
        let created = AgentSession(rachaID: rachaID, repository: repository, client: client,
                                   transcripts: TranscriptStore()) {
            HistoryIndex.build(from: repository.allStates, meID: repository.meID)
        }
        await created.load()
        session = created
        wasSettled = repository.state(rachaID)?.isSettled ?? false
    }

    private func send(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        Haptics.shared.tick()
        session?.send(trimmed)
        draft = ""
    }

    private func attach(_ item: PhotosPickerItem?) async {
        guard let item, let data = try? await item.loadTransferable(type: Data.self) else { return }
        // Downscale before it goes anywhere near the wire. A modern phone photo is
        // ~4MB; a receipt is legible at 1600px and that is a 10× cost reduction on
        // input tokens plus a much faster round trip at the table.
        guard let jpeg = ImageDownscaler.jpeg(from: data, maxDimension: 1600, quality: 0.72) else { return }
        Haptics.shared.press()
        session?.send("", imageBase64: jpeg.base64EncodedString())
        photo = nil
    }
}

/// Resize + re-encode a photo for the vision request.
enum ImageDownscaler {
    static func jpeg(from data: Data, maxDimension: CGFloat, quality: CGFloat) -> Data? {
        guard let image = UIImage(data: data) else { return nil }
        let longest = max(image.size.width, image.size.height)
        guard longest > maxDimension else { return image.jpegData(compressionQuality: quality) }
        let scale = maxDimension / longest
        let target = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: target)
        let resized = renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: target)) }
        return resized.jpegData(compressionQuality: quality)
    }
}
