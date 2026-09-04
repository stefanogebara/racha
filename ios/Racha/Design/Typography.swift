import SwiftUI

/// The web app's three faces, with the same jobs:
///
/// - **Instrument Serif** for money and venue names. It is the one typeface in
///   the system with any warmth, so it is reserved for the two things a person
///   actually looks at.
/// - **DM Sans** for everything else. Optical-size axis, so small text is not
///   just the big text shrunk.
/// - **JetBrains Mono** for codes (Pix copia-e-cola) and nothing else.
///
/// `.monospacedDigit()` is applied to every number, everywhere. Without it a
/// live-updating total shivers as digits change width, which reads as instability
/// in exactly the place a person needs to feel none.
enum Typo {
    enum Face: String {
        case serif = "InstrumentSerif-Regular"
        case sans = "DMSans-Regular"
        case sansMedium = "DMSans-Medium"
        case sansBold = "DMSans-Bold"
        case mono = "JetBrainsMono-Regular"
    }

    /// Falls back to the system face when the bundled font is missing, so a build
    /// without the font files still renders correctly (just less warmly).
    static func font(_ face: Face, _ size: CGFloat, relativeTo style: Font.TextStyle = .body) -> Font {
        if UIFont(name: face.rawValue, size: size) != nil {
            return .custom(face.rawValue, size: size, relativeTo: style)
        }
        switch face {
        case .serif: return .system(size: size, weight: .regular, design: .serif)
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

    /// The all-caps tracked label from the web app (`.label`).
    static var label: Font { font(.sansBold, 11, relativeTo: .caption2) }

    // Gallery. The mono micro-label is the detail that makes the interface read
    // as a bill rather than as a generic app — it borrows the receipt's own
    // voice, and it costs nothing.
    static var receipt: Font { font(.mono, 9.5, relativeTo: .caption2) }
    static var tileTitle: Font { font(.serif, 20, relativeTo: .title3) }
    static var tileAmount: Font { font(.serif, 15, relativeTo: .body) }
    static var galleryTitle: Font { font(.serif, 26, relativeTo: .title) }
    static var galleryNet: Font { font(.serif, 46, relativeTo: .largeTitle) }
}

extension View {
    /// The receipt micro-label: mono, 9.5px, wide tracking, uppercase.
    func receiptLabel() -> some View {
        self.font(Typo.receipt)
            .tracking(1.6)
            .textCase(.uppercase)
            .foregroundStyle(Palette.ink3)
    }

    /// Section label: 11px, bold, 0.14em tracking, uppercase, stone.
    func rachaLabel() -> some View {
        self.font(Typo.label)
            .tracking(1.54)
            .textCase(.uppercase)
            .foregroundStyle(Palette.stone)
    }

    /// Every number in the app goes through this. See the note above.
    func money() -> some View {
        self.monospacedDigit()
    }
}
