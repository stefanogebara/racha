import SwiftUI

/// One table in the gallery.
///
/// Not a card with chrome. A cut-out dish on a step of the table's own surface,
/// with the caption set beneath it like a contact sheet. The information order
/// is what a person actually scans: picture (which meal was this?), then date
/// and party size, then the venue, then what *you* paid there — the one number
/// that is yours on a past table.
struct RachaTile: View {
    var state: RachaState
    var meID: Participant.ID
    var namespace: Namespace.ID

    private var split: SplitResult { state.split }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            plate
            caption
        }
        .padding(14)
        .background {
            RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.surface)
        }
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(state.isSettled ? Palette.rule2 : Palette.rule, lineWidth: 1)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(summary)
    }

    private var plate: some View {
        DishImageView(cacheKey: ImageStyle.cacheKey(for: heroItem),
                      prompt: ImageStyle.prompt(for: heroItem),
                      category: heroItem.category,
                      cornerRadius: 6,
                      size: 512,
                      inset: 0.04)
            .aspectRatio(1.22, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .matchedGeometryEffect(id: state.id, in: namespace, isSource: true)
    }

    private var caption: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(state.venue?.name ?? state.title)
                .font(Typo.tileTitle)
                .foregroundStyle(Palette.ink)
                .lineLimit(1)
            Text("\(Self.day.string(from: state.updatedAt).lowercased()) · \(state.participants.count) pessoas")
                .metaLabel()
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(state.isSettled ? "você pagou" : "sua parte")
                    .font(Typo.caption)
                    .foregroundStyle(Palette.ink3)
                    .lineLimit(1)
                Spacer(minLength: 4)
                // Money never wraps ("R$" on one line, "129,25" on the next —
                // seen on the simulator at R$ 129,25 in a two-column grid). The
                // amount wins the width fight; the label yields.
                Text(BRL.format(state.isSettled ? state.paid(by: meID) : state.due(of: meID),
                                currency: state.currency))
                    .font(Typo.tileAmount)
                    .money()
                    .foregroundStyle(state.isSettled ? Palette.ink2 : Palette.ink)
                    .lineLimit(1)
                    .layoutPriority(1)
            }
        }
    }

    /// The dish that stands for the table: the most expensive line, which is
    /// almost always the thing people remember ordering.
    private var heroItem: LineItem {
        state.items.max { $0.total < $1.total }
            ?? LineItem(name: state.kind.label, unitPrice: .zero, category: .other)
    }

    private var summary: String {
        let money = BRL.format(split.total, currency: state.currency)
        return "\(state.venue?.name ?? state.title), \(state.participants.count) pessoas, conta \(money), \(state.isSettled ? "mesa fechada" : "mesa aberta")."
    }

    private static let day: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "pt_BR")
        f.dateFormat = "d MMM"
        return f
    }()
}
