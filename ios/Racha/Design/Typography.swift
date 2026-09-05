import SwiftUI
import CoreText

/// One family, three widths.
///
/// Archivo is a variable face with a width axis, so the poster cut (width 62,
/// weight 850 — compressed and black, the way a bar chalkboard is lettered), the
/// headline cut (92 / 500) and the body cut (100 / 400) are one design at three
/// widths, not three typefaces. The critique loop killed the second family: a
/// voice that shows up on one screen is a costume, not a role. The figures are
/// tabular at every width and weight (measured: ten digits identical to the
/// hundredth of a pixel), which is what lets a column of amounts align on the
/// comma because the typeface says so.
///
/// The poster cut is used for exactly one thing per screen — the figure the
/// screen is about — and never for two things at once.
///
/// Without the bundled font the app falls back to San Francisco with its width
/// variants (`.compressed` for the poster, `.condensed` for the headline), which
/// keeps the hierarchy intact and loses only the voice.
enum Typo {
    /// Kept for the one onboarding call site that picks a face by name.
    enum Face: String {
        case serif = "poster"       // the display cut; there is no serif any more
        case serifMedium = "headline"
        case sans = "body"
        case sansMedium = "bodyMedium"
        case sansBold = "bodySemibold"
        case mono = "body"          // Pix payloads; tabular body is enough
    }

    enum Cut { case poster, headline, body, bodyMedium, bodySemibold }

    static let family = "Archivo"
    private static let wdth: UInt32 = 0x77647468   // 'wdth'
    private static let wght: UInt32 = 0x77676874   // 'wght'

    private static var bundled: Bool = { UIFont(name: family, size: 12) != nil }()

    /// The variable font at a given width and weight, via CoreText variation
    /// attributes; SwiftUI has no API for a width axis on a custom face.
    static func archivo(_ size: CGFloat, width: CGFloat, weight: CGFloat) -> Font? {
        guard bundled else { return nil }
        let variation: [NSNumber: NSNumber] = [NSNumber(value: wdth): NSNumber(value: Double(width)),
                                               NSNumber(value: wght): NSNumber(value: Double(weight))]
        var attrs: [UIFontDescriptor.AttributeName: Any] = [.name: family]
        attrs[UIFontDescriptor.AttributeName(rawValue: kCTFontVariationAttribute as String)] = variation
        let descriptor = UIFontDescriptor(fontAttributes: attrs)
        return Font(UIFont(descriptor: descriptor, size: size))
    }

    static func font(_ cut: Cut, _ size: CGFloat) -> Font {
        switch cut {
        case .poster:
            return archivo(size, width: 62, weight: 850)
                ?? .system(size: size, weight: .black).width(.compressed)
        case .headline:
            return archivo(size, width: 92, weight: 500)
                ?? .system(size: size, weight: .medium).width(.condensed)
        case .body:
            return archivo(size, width: 100, weight: 400) ?? .system(size: size, weight: .regular)
        case .bodyMedium:
            return archivo(size, width: 100, weight: 500) ?? .system(size: size, weight: .medium)
        case .bodySemibold:
            return archivo(size, width: 100, weight: 600) ?? .system(size: size, weight: .semibold)
        }
    }

    /// Legacy signature kept for the onboarding view.
    static func font(_ face: Face, _ size: CGFloat, relativeTo style: Font.TextStyle = .body) -> Font {
        switch face {
        case .serif: return font(.headline, size)
        case .serifMedium: return font(.headline, size)
        case .sans, .mono: return font(.body, size)
        case .sansMedium: return font(.bodyMedium, size)
        case .sansBold: return font(.bodySemibold, size)
        }
    }

    // The one poster per screen.
    static var hero: Font { font(.poster, 104) }
    static var galleryNet: Font { font(.poster, 104) }

    // Headlines: the venue, the sheet title, the thread title.
    static var display: Font { font(.headline, 34) }
    static var venue: Font { font(.headline, 34) }
    static var galleryTitle: Font { font(.headline, 22) }
    static var onboardTitle: Font { font(.headline, 34) }
    static var tileTitle: Font { font(.headline, 17) }
    /// The person's own words in the thread: the headline cut, a size up from body.
    static var serifBody: Font { font(.body, 14.5) }

    // Text.
    static var body: Font { font(.body, 15) }
    static var bodyMedium: Font { font(.bodyMedium, 15) }
    static var small: Font { font(.body, 13) }
    static var caption: Font { font(.body, 12.5) }
    static var button: Font { font(.bodySemibold, 16) }
    static var mono: Font { font(.body, 12) }
    static var tileAmount: Font { font(.body, 14) }
    static var proofTotal: Font { font(.headline, 25) }
    static var proofPart: Font { font(.body, 16) }

    /// Section labels speak plainly: sentence case, no tracking. The only
    /// letterspaced caps left in the product is the wordmark.
    static var label: Font { font(.bodyMedium, 12.5) }
    static var meta: Font { font(.body, 12.5) }
    static var receipt: Font { font(.bodyMedium, 12.5) }
}

extension View {
    /// A section label: sentence case, the quiet ink, no rule.
    func receiptLabel() -> some View {
        self.font(Typo.receipt).foregroundStyle(Palette.ink3)
    }

    /// Quiet metadata.
    func metaLabel() -> some View {
        self.font(Typo.meta).foregroundStyle(Palette.ink3)
    }

    func rachaLabel() -> some View { receiptLabel() }

    /// Every number in the app goes through this. Archivo's figures are tabular by
    /// construction; `.monospacedDigit()` keeps the system fallback honest too.
    func money() -> some View {
        self.monospacedDigit()
    }
}
