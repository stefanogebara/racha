import SwiftUI

/// A message, plus whatever it did to the ledger.
///
/// The edit ribbon under the agent's text is the product's central promise made
/// visible: every agent-driven change is labelled, shows its effect on the total,
/// and undoes with one tap. It is attached to the message rather than living in a
/// separate audit screen so the explanation and the action are never more than a
/// thumb apart.
struct MessageBubble: View {
    var message: ChatMessage
    var onUndo: (LedgerEdit) -> Void

    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: 44) }

            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 8) {
                if !message.text.isEmpty || message.isStreaming {
                    bubble
                }
                if !message.edits.isEmpty {
                    VStack(spacing: 6) {
                        ForEach(message.edits) { edit in
                            EditRibbon(edit: edit) { onUndo(edit) }
                        }
                    }
                    .frame(maxWidth: 320, alignment: .leading)
                }
                if let failure = message.failure {
                    FailureNote(text: failure)
                }
            }

            if message.role != .user { Spacer(minLength: 44) }
        }
    }

    @ViewBuilder private var bubble: some View {
        switch message.role {
        case .user:
            Text(message.text)
                .font(Typo.body)
                .foregroundStyle(.white)
                .padding(.horizontal, 15)
                .padding(.vertical, 11)
                .background {
                    UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 20,
                                           bottomTrailingRadius: 6, topTrailingRadius: 20,
                                           style: .continuous)
                        .fill(LinearGradient(colors: [Palette.burgundy, Palette.burgundyDark],
                                             startPoint: .topLeading, endPoint: .bottomTrailing))
                }
                .shadow(color: Palette.burgundy.opacity(0.22), radius: 12, y: 4)

        case .agent:
            StreamingText(text: message.text, isStreaming: message.isStreaming)
                .padding(.horizontal, 15)
                .padding(.vertical, 11)
                .background {
                    UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 6,
                                           bottomTrailingRadius: 20, topTrailingRadius: 20,
                                           style: .continuous)
                        .fill(Color.white.opacity(0.72))
                }
                .overlay {
                    UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 6,
                                           bottomTrailingRadius: 20, topTrailingRadius: 20,
                                           style: .continuous)
                        .strokeBorder(Palette.glassBorder, lineWidth: 1)
                }
                .shadow(color: Palette.charcoal.opacity(0.05), radius: 14, y: 5)

        case .system:
            Text(message.text)
                .font(Typo.caption)
                .foregroundStyle(Palette.stone)
                .frame(maxWidth: .infinity, alignment: .center)
        }
    }
}

/// The undoable change.
struct EditRibbon: View {
    var edit: LedgerEdit
    var onUndo: () -> Void

    @State private var offset: CGFloat = 0

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: edit.isUndone ? "arrow.uturn.backward" : "pencil.line")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(edit.isUndone ? Palette.stone : Palette.amber)
                .frame(width: 16, height: 16)
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: 2) {
                Text(edit.summary)
                    .font(Typo.small)
                    .foregroundStyle(edit.isUndone ? Palette.stone : Palette.charcoal)
                    .strikethrough(edit.isUndone, color: Palette.stone)
                    .fixedSize(horizontal: false, vertical: true)

                if let delta = edit.deltaCents, !delta.isZero, !edit.isUndone {
                    Text(delta.isNegative ? BRL.format(delta) : "+\(BRL.format(delta))")
                        .font(Typo.caption)
                        .money()
                        .foregroundStyle(delta.isNegative ? Palette.emerald : Palette.charcoal)
                }
            }

            Spacer(minLength: 4)

            if !edit.isUndone {
                Button {
                    withAnimation(Motion.snappy) { onUndo() }
                } label: {
                    Text("desfazer")
                        .font(Typo.caption)
                        .foregroundStyle(Palette.burgundy)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(Capsule().fill(Palette.burgundy.opacity(0.09)))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(edit.isUndone ? Palette.glassSubtle : Palette.amberSoft.opacity(0.10))
        }
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(edit.isUndone ? Palette.hairline : Palette.amberSoft.opacity(0.28),
                              lineWidth: 1)
        }
        .offset(x: offset)
        // Swipe left to undo, as an alternative to the button — "one gesture", as
        // the brief put it. The button stays because a gesture nobody discovers is
        // not an affordance.
        .gesture(
            DragGesture(minimumDistance: 12)
                .onChanged { value in
                    guard !edit.isUndone, value.translation.width < 0 else { return }
                    offset = max(-110, value.translation.width * 0.7)
                }
                .onEnded { value in
                    if !edit.isUndone && value.translation.width < -70 {
                        withAnimation(Motion.snappy) { offset = 0; onUndo() }
                    } else {
                        withAnimation(Motion.snappy) { offset = 0 }
                    }
                }
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel(edit.isUndone ? "Desfeito: \(edit.summary)" : edit.summary)
        .accessibilityAction(named: "Desfazer") { if !edit.isUndone { onUndo() } }
    }
}

/// A turn that failed. Soft, and explicit that nothing was lost — because after a
/// dropped connection the person's real question is "did it eat my bill?".
struct FailureNote: View {
    var text: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 11))
                .foregroundStyle(Palette.amber)
            Text(text)
                .font(Typo.caption)
                .foregroundStyle(Palette.stone)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Palette.amberSoft.opacity(0.10))
        }
    }
}

/// What the agent is doing right now, in one word.
struct WorkingIndicator: View {
    var phase: AgentSession.StreamPhase
    @State private var pulse = false

    var body: some View {
        HStack(spacing: 9) {
            ZStack {
                Circle()
                    .fill(Palette.burgundy.opacity(0.18))
                    .frame(width: 22, height: 22)
                    .scaleEffect(pulse ? 1.35 : 0.85)
                    .opacity(pulse ? 0 : 0.9)
                Circle()
                    .fill(Palette.burgundy)
                    .frame(width: 7, height: 7)
            }
            Text(label)
                .font(Typo.small)
                .foregroundStyle(Palette.stone)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background {
            Capsule().fill(Color.white.opacity(0.6))
        }
        .overlay { Capsule().strokeBorder(Palette.hairline, lineWidth: 1) }
        .onAppear {
            withAnimation(.easeOut(duration: 1.1).repeatForever(autoreverses: false)) { pulse = true }
        }
        .accessibilityLabel(label)
    }

    private var label: String {
        switch phase {
        case .idle: return ""
        case .thinking: return "pensando"
        case .writing: return "escrevendo"
        case .working(let what): return what
        }
    }
}
