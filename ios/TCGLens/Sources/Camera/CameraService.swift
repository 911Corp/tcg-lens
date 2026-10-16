import AVFoundation
import Observation

@MainActor
@Observable
final class CameraService: NSObject {
    let session = AVCaptureSession()
    var authorization: AVAuthorizationStatus = AVCaptureDevice.authorizationStatus(for: .video)
    var running = false

    func requestAndStart() async {
        if authorization == .notDetermined {
            _ = await AVCaptureDevice.requestAccess(for: .video)
            authorization = AVCaptureDevice.authorizationStatus(for: .video)
        }
        guard authorization == .authorized else { return }
        configureIfNeeded()
        if !session.isRunning {
            Task.detached { [session] in session.startRunning() }
        }
        running = true
    }

    private func configureIfNeeded() {
        guard session.inputs.isEmpty else { return }
        session.beginConfiguration()
        session.sessionPreset = .high
        defer { session.commitConfiguration() }
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return }
        session.addInput(input)
    }
}
