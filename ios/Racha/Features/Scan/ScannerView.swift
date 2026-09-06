import SwiftUI
import AVFoundation

/// The camera, pointed at the sticker on the table.
///
/// Deliberately not a generic "scan anything" screen. It reads one thing, says
/// what it is doing in one line, and gets out of the way — because it sits
/// between a person who has just sat down and the bill they came to split.
///
/// Three things it refuses to do: keep the camera running after a hit (battery,
/// and the session is a shared resource), retry silently on an unreadable code
/// (the person needs to know to move the phone), and treat "not a Racha QR" the
/// same as "that table is gone" — different problems, different sentences.
struct ScannerView: View {
    /// Called once, with a parsed table. The presenter dismisses.
    var onScan: (TableQR) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var model = ScannerModel()
    @State private var typing = false
    @State private var typed = ""

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()

                switch model.phase {
                case .denied, .unavailable:
                    unavailable
                default:
                    CameraPreview(session: model.session).ignoresSafeArea()
                    reticle
                }

                VStack {
                    Spacer()
                    caption
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 34)
            }
            .navigationTitle("Escanear a mesa")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { dismiss() }.tint(Palette.cream)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("Digitar código") { typing = true }.tint(Palette.cream)
                }
            }
            .task { await model.start() }
            .onDisappear { model.stop() }
            .onChange(of: model.scanned) { _, qr in
                guard let qr else { return }
                model.stop()
                Haptics.shared.money()
                onScan(qr)
                dismiss()
            }
            .alert("Código da mesa", isPresented: $typing) {
                TextField("o código embaixo do QR", text: $typed)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Abrir") {
                    guard let qr = TableQR.parse(typed, defaultOrigin: RachaEnvironment.origin) else { return }
                    onScan(qr)
                    dismiss()
                }
                Button("Cancelar", role: .cancel) { typed = "" }
            } message: {
                Text("Dá pra digitar o código impresso embaixo do QR, se a câmera não estiver ajudando.")
            }
        }
        .preferredColorScheme(.dark)
    }

    /// A frame, not a decoration: it is where the QR has to be.
    private var reticle: some View {
        RoundedRectangle(cornerRadius: 20, style: .continuous)
            .strokeBorder(Palette.cream.opacity(0.9), lineWidth: 2)
            .frame(width: 236, height: 236)
            .shadow(color: .black.opacity(0.4), radius: 20)
    }

    private var caption: some View {
        Text(model.phase.caption)
            .font(Typo.body)
            .foregroundStyle(Palette.cream)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
            .background {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(.black.opacity(0.55))
            }
    }

    private var unavailable: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(model.phase == .denied ? "Sem acesso à câmera" : "Câmera indisponível")
                .font(Typo.display)
                .foregroundStyle(Palette.cream)
            Text(model.phase == .denied
                 ? "O Racha usa a câmera só pra ler o QR da mesa. Dá pra liberar nos Ajustes, ou digitar o código impresso embaixo do QR."
                 : "Esse aparelho não tem câmera disponível agora. Dá pra digitar o código impresso embaixo do QR.")
                .font(Typo.body)
                .foregroundStyle(Palette.cream.opacity(0.7))
                .fixedSize(horizontal: false, vertical: true)
            RachaButton(title: "Digitar o código", icon: nil) { typing = true }
                .padding(.top, 6)
            if model.phase == .denied {
                RachaButton(title: "Abrir os Ajustes", icon: nil, style: .ghost) {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
            }
        }
        .padding(28)
    }
}

/// Owns the capture session. An `@Observable` on the main actor, with the
/// session's own work kept off it — `AVCaptureSession.startRunning()` blocks,
/// and blocking the main thread here would stutter the very preview that tells
/// the person the camera is live.
@MainActor
@Observable
final class ScannerModel {
    enum Phase: Equatable {
        case starting, scanning, denied, unavailable

        var caption: String {
            switch self {
            case .starting:    return "Ligando a câmera…"
            case .scanning:    return "Aponta pro QR da mesa"
            case .denied:      return "Sem acesso à câmera"
            case .unavailable: return "Câmera indisponível"
            }
        }
    }

    private(set) var phase: Phase = .starting
    private(set) var scanned: TableQR?

    let session = AVCaptureSession()
    private let delegate = MetadataDelegate()
    private var configured = false

    func start() async {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            break
        case .notDetermined:
            guard await AVCaptureDevice.requestAccess(for: .video) else { phase = .denied; return }
        default:
            phase = .denied
            return
        }
        guard configure() else { phase = .unavailable; return }
        delegate.onCode = { [weak self] code in
            Task { @MainActor in self?.accept(code) }
        }
        phase = .scanning
        let session = session
        await Task.detached(priority: .userInitiated) {
            if !session.isRunning { session.startRunning() }
        }.value
    }

    func stop() {
        let session = session
        Task.detached(priority: .utility) {
            if session.isRunning { session.stopRunning() }
        }
    }

    /// First valid table wins; anything else is ignored rather than reported,
    /// because a camera sweeping a bar table sees menus, wifi cards and Pix
    /// codes, and a stream of "that's not a table" would be noise, not help.
    private func accept(_ code: String) {
        guard scanned == nil,
              let qr = TableQR.parse(code, defaultOrigin: RachaEnvironment.origin) else { return }
        scanned = qr
    }

    private func configure() -> Bool {
        guard !configured else { return true }
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return false }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return false }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(delegate, queue: DispatchQueue(label: "racha.scan"))
        // Set after adding the output: the available types are empty before it
        // is attached, and assigning an unsupported type raises.
        output.metadataObjectTypes = output.availableMetadataObjectTypes.contains(.qr) ? [.qr] : []
        configured = true
        return true
    }
}

private final class MetadataDelegate: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
    var onCode: ((String) -> Void)?

    func metadataOutput(_ output: AVCaptureMetadataOutput,
                        didOutput objects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        for object in objects {
            guard let readable = object as? AVMetadataMachineReadableCodeObject,
                  readable.type == .qr, let value = readable.stringValue else { continue }
            onCode?(value)
            return
        }
    }
}

private struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.layer.session = session
        view.layer.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_ view: PreviewView, context: Context) {}

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        override var layer: AVCaptureVideoPreviewLayer { super.layer as! AVCaptureVideoPreviewLayer }
    }
}
