import SwiftUI

/// One racha in the gallery.
///
/// Not a card. A card is a box with chrome — a border, a fill, a shadow — and
/// twelve of them stacked read as a list of containers rather than a set of
/// things. This is a *plate*: a cut-out dish on a sheet of the app's own stock,
/// with the caption set beneath it like a contact sheet.
///
/// The information order is what a person actually scans: picture (which meal
/// was this?), then date and party size, then the name, then state and amount.
/// `paguei`/`devia` deliberately does **not** appear here — that is card-level
/// detail, and putting it on every tile is what turned the old gallery into a
/// spreadsheet with pictures.
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
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(summary)
    }

    /// The sheet the dish sits on: a lighter cut of the same paper, with a
    /// hairline. The cut-out's own alpha does the rest.
    private var plate: some View {
        DishImageView(cacheKey: ImageStyle.cacheKey(for: heroItem),
                      prompt: ImageStyle.prompt(for: heroItem),
                      cornerRadius: 3,
                      size: 512,
                      inset: 0.04)
            .aspectRatio(1, contentMode: .fit)
            .background {
                LinearGradient(colors: [Palette.paperHigh, Palette.paperMid, Palette.paperLow],
                               startPoint: .top, endPoint: .bottom)
            }
            .overlay {
                Rectangle().strokeBorder(Palette.hairline, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: 3, style: .continuous))
            .matchedGeometryEffect(id: state.id, in: namespace, isSource: true)
    }

    private var caption: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("\(Self.day.string(from: state.updatedAt).uppercased()) · \(state.participants.count) pessoas")
                .receiptLabel()
            Text(state.title)
                .font(Typo.tileTitle)
                .foregroundStyle(Palette.ink)
                .lineLimit(1)
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Label {
                    Text(state.isSettled ? "quite" : "aberto")
                } icon: {
                    Circle()
                        .fill(state.isSettled ? Palette.positive : Palette.action)
                        .frame(width: 5, height: 5)
                }
                .labelStyle(.dotLeading)
                .font(Typo.caption)
                .foregroundStyle(Palette.ink3)

                Spacer(minLength: 4)

                Text(BRL.format(split.total, currency: state.currency))
                    .font(Typo.tileAmount)
                    .money()
                    .foregroundStyle(Palette.ink2)
            }
        }
    }

    /// The dish that represents the whole racha: the most expensive line, which
    /// is almost always the thing people remember ordering.
    private var heroItem: LineItem {
        state.items.max { $0.total < $1.total }
            ?? LineItem(name: state.kind.label, unitPrice: .zero, category: .other)
    }

    private var summary: String {
        let money = BRL.format(split.total, currency: state.currency)
        return "\(state.title), \(state.kind.label), \(state.participants.count) pessoas, \(money), \(state.isSettled ? "quite" : "aberto")."
    }

    private static let day: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "pt_BR")
        f.dateFormat = "dd MMM"
        return f
    }()
}

/// A dot before the label, baseline-aligned. `.titleAndIcon` puts too much air
/// between them at this size.
private struct DotLeadingLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 5) {
            configuration.icon
            configuration.title
        }
    }
}
extension LabelStyle where Self == DotLeadingLabelStyle {
    static var dotLeading: DotLeadingLabelStyle { DotLeadingLabelStyle() }
}
