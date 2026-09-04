import SwiftUI

/// One racha in the timeline.
///
/// The information hierarchy is deliberate and comes straight from the brief:
/// cover image, who was there, what I paid vs what I owed, whether it's settled.
/// In that order, because that is the order a person scans — picture first
/// (which meal was this?), faces second (who was I with?), then the money.
///
/// The money line is the only place both numbers appear together, and they are
/// labelled "paguei" / "devia" rather than "credit" / "debit". Nobody standing in
/// a bar thinks in accounting terms.
struct RachaCard: View {
    var state: RachaState
    var meID: Participant.ID
    var namespace: Namespace.ID

    @Environment(\.imageEngine) private var engine

    private var position: NetBalance? { state.position(of: meID) }
    private var split: SplitResult { state.split }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            cover
            ledger
                .padding(.horizontal, 18)
                .padding(.vertical, 16)
        }
        .background {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(.ultraThinMaterial)
                .overlay {
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .fill(Palette.glassCard)
                }
        }
        .overlay {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .strokeBorder(Palette.glassBorder, lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .shadow(color: Palette.charcoal.opacity(0.05), radius: 2, y: 1)
        .shadow(color: Palette.charcoal.opacity(0.06), radius: 28, y: 12)
        // The card is the source and destination of the zoom. Refraction is off
        // here on purpose — a scrolling list of layer effects is the one place
        // these visuals would become a battery complaint.
        .matchedGeometryEffect(id: state.id, in: namespace, isSource: true)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilitySummary)
    }

    // MARK: Cover

    private var cover: some View {
        ZStack(alignment: .bottomLeading) {
            DishImageView(cacheKey: coverKey, prompt: coverPrompt, cornerRadius: 0, size: 1024)
                .frame(height: 178)
                .frame(maxWidth: .infinity)
                .clipped()

            // A scrim only where text sits, so the picture keeps its top two thirds.
            LinearGradient(colors: [.clear, Palette.charcoal.opacity(0.55)],
                           startPoint: .center, endPoint: .bottom)
                .frame(height: 178)
                .allowsHitTesting(false)

            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(state.kind.label.uppercased())
                        .font(Typo.label)
                        .tracking(1.4)
                        .foregroundStyle(.white.opacity(0.75))
                    Text(state.title)
                        .font(Typo.venue)
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                Spacer()
                AvatarStack(participants: state.participants, size: 28, meID: meID)
            }
            .padding(16)
        }
        .frame(height: 178)
        .clipped()
    }

    // MARK: Ledger line

    private var ledger: some View {
        VStack(spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                money(label: "Paguei", cents: position?.paid ?? .zero, color: Palette.charcoal)
                Spacer(minLength: 12)
                money(label: "Devia", cents: position?.owed ?? .zero, color: Palette.stone,
                      alignment: .trailing)
            }

            if state.isSettled {
                settledBadge
            } else {
                openState
            }
        }
    }

    private func money(label: String, cents: Cents, color: Color,
                       alignment: HorizontalAlignment = .leading) -> some View {
        VStack(alignment: alignment, spacing: 1) {
            Text(label).rachaLabel()
            Text(BRL.format(cents, currency: state.currency))
                .font(Typo.serifBody)
                .money()
                .foregroundStyle(color)
        }
    }

    @ViewBuilder private var openState: some View {
        let net = position?.net ?? .zero
        VStack(spacing: 8) {
            LiquidProgress(fill: paidFraction, height: 8)
            HStack(spacing: 6) {
                if split.hasUnassigned {
                    Label("\(split.unassigned.count) sem dono", systemImage: "questionmark.circle")
                        .font(Typo.caption)
                        .foregroundStyle(Palette.amber)
                } else if !net.isZero {
                    Text(net.isNegative
                         ? "Você deve \(BRL.format(net.magnitude, currency: state.currency))"
                         : "Te devem \(BRL.format(net, currency: state.currency))")
                        .font(Typo.caption)
                        .money()
                        .foregroundStyle(net.isNegative ? Palette.burgundy : Palette.emerald)
                }
                Spacer()
                Text("falta \(BRL.format(remaining, currency: state.currency))")
                    .font(Typo.caption)
                    .money()
                    .foregroundStyle(Palette.stone)
            }
        }
    }

    private var settledBadge: some View {
        HStack(spacing: 7) {
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 13))
                .foregroundStyle(Palette.emeraldBright)
            Text(state.kind.isRecurring ? "Ciclo fechado" : "Fechado")
                .font(Typo.bodyMedium)
                .foregroundStyle(Palette.emerald)
            Spacer()
            Text(BRL.format(split.total, currency: state.currency))
                .font(Typo.small)
                .money()
                .foregroundStyle(Palette.stone)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 12)
        .background {
            Capsule().fill(Palette.emeraldBright.opacity(0.12))
        }
    }

    // MARK: Derived

    private var remaining: Cents {
        (split.total - state.confirmedPaid).clampedNonNegative
    }

    private var paidFraction: Double {
        guard split.total.raw > 0 else { return 0 }
        return Double(state.confirmedPaid.raw) / Double(split.total.raw)
    }

    /// The three priciest items are what the cover depicts — a picture of the
    /// meal, not of a category.
    private var headlineItems: [String] {
        state.items.sorted { $0.total > $1.total }.prefix(3).map { ImageStyle.subject(for: $0) }
    }

    private var coverKey: String {
        ImageStyle.coverCacheKey(kind: state.kind, headline: headlineItems)
    }

    private var coverPrompt: String {
        ImageStyle.coverPrompt(kind: state.kind, title: state.title, headline: headlineItems)
    }

    private var accessibilitySummary: String {
        let paid = BRL.format(position?.paid ?? .zero, currency: state.currency)
        let owed = BRL.format(position?.owed ?? .zero, currency: state.currency)
        let status = state.isSettled ? "fechado" : "falta \(BRL.format(remaining, currency: state.currency))"
        let people = state.participants.map(\.shortName).joined(separator: ", ")
        return "\(state.title), \(state.kind.label). Com \(people). Paguei \(paid), devia \(owed). \(status)."
    }
}
