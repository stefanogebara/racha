import UIKit

/// The carved set: one block print per category, bundled with the app.
///
/// Decision #28 stopped the critique loop at 6/10 and named exactly what pixels
/// could not move: a pictogram set drawn in code does not have *one hand*. It is
/// a commission, not another round. This is that commission, filled at a
/// generator (decision #33) — provisional art, and marked as such — but it is a
/// real set: fourteen subjects carved in one pass, one tool, one weight.
///
/// The files carry NO colour. Each is an alpha mask: opaque where the block
/// touched the paper, transparent where it did not. That is the whole trick and
/// it is the same logic `ProceduralPlate` draws with — paper is where ink is
/// not. It also means one file serves both worlds: cream ink on the night
/// ground of the app, and near-black on the cream of the comanda. A baked-in
/// cream background would be a pale rectangle sitting on a dark screen.
enum CarvedSet {

    /// Categories with a block. `servico`, `taxa` and `other` are abstract — a
    /// service charge has no picture, and inventing one would be decoration.
    /// The travel categories are off the table product since decision #29.
    static let carved: Set<ItemCategory> = [
        .carne, .peixe, .massa, .petisco, .salada, .acompanhamento, .sobremesa,
        .cerveja, .drink, .vinho, .refrigerante, .cafe, .suco, .couvert,
    ]

    /// The mask for a category, or nil when it has no block. Masks are cached:
    /// a table of twelve rows asks for the same few blocks over and over.
    static func mask(for category: ItemCategory) -> UIImage? {
        guard carved.contains(category) else { return nil }
        if let hit = cache.object(forKey: category.rawValue as NSString) { return hit }
        guard let image = UIImage(named: "carved-\(category.rawValue)") else { return nil }
        cache.setObject(image, forKey: category.rawValue as NSString)
        return image
    }

    /// The block printed in `ink`. Rendered with `.alwaysTemplate` so the caller
    /// picks the ink and the same file works on either ground.
    static func print(_ category: ItemCategory, ink: UIColor, size: CGFloat) -> UIImage? {
        guard let mask = mask(for: category) else { return nil }
        let side = CGSize(width: size, height: size)
        return UIGraphicsImageRenderer(size: side).image { ctx in
            ink.setFill()
            ctx.cgContext.translateBy(x: 0, y: size)
            ctx.cgContext.scaleBy(x: 1, y: -1)
            guard let cg = mask.cgImage else { return }
            ctx.cgContext.clip(to: CGRect(origin: .zero, size: side), mask: cg)
            ctx.cgContext.fill(CGRect(origin: .zero, size: side))
        }
    }

    private static let cache = NSCache<NSString, UIImage>()
}
