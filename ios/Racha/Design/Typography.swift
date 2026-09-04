import SwiftUI

/// Two faces, and a rule for each.
///
/// - **Newsreader** carries language and money. It is one family with an
///   optical-size axis, so display and text are the same design cut twice —
///   which is what a serif family is for, and what using a single display face
///   at every size throws away.
/// - **DM Sans** carries the interface: labels, buttons, metadata.
///
/// The face changed for a reason worth writing down. Instrument Serif is a
/// display cut with proportional figures: its "1" is 54% the width of its "0".
/// Measured, not guessed — the digits come out at 13.8, 7.5, 12.1, 11.1, 11.8,
/// 11.5, 12.1, 10.9, 13.0, 12.1 points at 30pt. That means no column of amounts
/// set in it can ever line up on the comma, no matter how it is aligned, and
/// hand-tabularising it with fixed cells only leaves the "1"s rattling inside
/// their boxes. Newsreader's figures are uniform width by construction (16.83
/// at 30pt, every digit), so a right-aligned column aligns because the typeface
/// says so and not because the layout is fighting it. In an app whose whole
/// claim is that the money is exact to the centavo, the figures have to
/// corroborate the claim.
///
/// The mono is gone. It had been doing display, ledger and label duty at once,
/// and a default coder mono is the signature of a machine-made mockup; the two
/// faces above cover every job it held.
///
/// `.monospacedDigit()` is still applied to every number. Without it a
/// live-updating total shivers as digits change width, which reads as instability
/// in exactly the place a person needs to feel none.
enum Typo {
    enum Face: String {
        case serif = "Newsreader-Regular"
        case serifMedium = "Newsreader-Medium"
        case sans = "DMSans-Regular"
        case sansMedium = "DMSans-Medium"
        case sansBold = "DMSans-Bold"
        case mono = "Newsreader-Regular"   // Pix payloads; nothing else needs it
    }

    /// Falls back to the system face when the bundled font is missing, so a build
    /// without the font files still renders correctly (just less warmly).
    static func font(_ face: Face, _ size: CGFloat, relativeTo style: Font.TextStyle = .body) -> Font {
        if UIFont(name: face.rawValue, size: size) != nil {
            return .custom(face.rawValue, size: size, relativeTo: style)
        }
        switch face {
        case .serif: return .system(size: size, weight: .regular, design: .serif)
        case .serifMedium: return .system(size: size, weight: .medium, design: .serif)
        case .mono: return .system(size: size, weight: .regular, design: .monospaced)
        case .sansBold: return .system(size: size, weight: .bold)
        case .sansMedium: return .system(size: size, weight: .medium)
        case .sans: return .system(size: size, weight: .regular)
        }
    }

    // Display — the serif, only for money and place names.
    static var hero: Font { font(.serif, 46, relativeTo: .largeTitle) }
    static var display: Font { font(.serif, 34, relativeTo: .title) }
    static var venue: Font { font(.serif, 30, relativeTo: .title2) }
    static var serifBody: Font { font(.serif, 22, relativeTo: .title3) }

    // Text
    static var body: Font { font(.sans, 15) }
    static var bodyMedium: Font { font(.sansMedium, 15) }
    static var small: Font { font(.sans, 13, relativeTo: .footnote) }
    static var caption: Font { font(.sans, 12, relativeTo: .caption) }
    static var button: Font { font(.sansBold, 16, relativeTo: .headline) }
    static var mono: Font { font(.mono, 12, relativeTo: .caption) }

    /// The one caps label in the system. It marks a section of a bill, and it
    /// appears at most twice on a screen — when every label shouts, none of them
    /// is a signal, and a page of letterspaced small caps is the house style of
    /// generated "editorial" work.
    static var label: Font { font(.sansMedium, 9.5, relativeTo: .caption2) }

    /// Quiet metadata: a date, a list of names, a state. Sentence case.
    static var meta: Font { font(.sans, 11.5, relativeTo: .caption) }

    static var receipt: Font { font(.sansMedium, 9.5, relativeTo: .caption2) }
    static var tileTitle: Font { font(.serif, 20, relativeTo: .title3) }
    static var tileAmount: Font { font(.serif, 15, relativeTo: .body) }
    static var galleryTitle: Font { font(.serif, 26, relativeTo: .title) }
    static var galleryNet: Font { font(.serif, 46, relativeTo: .largeTitle) }

    // First run.
    static var onboardTitle: Font { font(.serif, 40, relativeTo: .largeTitle) }
    static var proofTotal: Font { font(.serif, 25, relativeTo: .title2) }
    static var proofPart: Font { font(.serif, 16, relativeTo: .body) }
}

extension View {
    /// The section label. One spec, used for section rules in the ledger and
    /// nowhere else.
    func receiptLabel() -> some View {
        self.font(Typo.receipt)
            .tracking(1.24)
            .textCase(.uppercase)
            .foregroundStyle(Palette.ink4)
    }

    /// Quiet metadata. Sentence case, no tracking — this is what most of the
    /// interface's small text used to be shouting in caps.
    func metaLabel() -> some View {
        self.font(Typo.meta).foregroundStyle(Palette.ink3)
    }

    /// Section label, kept as an alias so older call sites keep compiling.
    func rachaLabel() -> some View { receiptLabel() }

    /// Every number in the app goes through this. See the note above.
    func money() -> some View {
        self.monospacedDigit()
    }
}
