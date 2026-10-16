import SwiftUI

struct LensCameraScreen: View {
    @State private var camera = CameraService()
    @State private var result: LensResult? = nil

    var body: some View {
        ZStack {
            LensTheme.background.ignoresSafeArea()
            if camera.authorization == .authorized {
                CameraPreview(session: camera.session).ignoresSafeArea()
            } else {
                permissionView
            }
            VStack {
                HStack {
                    Text("TCG Lens").font(.headline).foregroundStyle(.white)
                    Spacer()
                    Button("?") {}.buttonStyle(.borderedProminent).tint(.black.opacity(0.55))
                }.padding()
                Spacer()
                if let result { ResultOverlay(result: result).padding() }
                else if camera.authorization == .authorized {
                    Text("Pointez une carte ou un produit")
                        .padding(.horizontal, 18).padding(.vertical, 10)
                        .background(.black.opacity(0.62), in: Capsule())
                        .foregroundStyle(.white)
                        .padding(.bottom, 24)
                }
            }
        }
        .task { await camera.requestAndStart() }
    }

    private var permissionView: some View {
        VStack(spacing: 20) {
            Image(systemName: "camera.fill").font(.system(size: 48)).foregroundStyle(LensTheme.accent)
            Text("Accès à la caméra").font(.title2.bold()).foregroundStyle(.white)
            Text("La reconnaissance fonctionne localement par défaut. Aucune vidéo n’est stockée par TCG Lens.")
                .multilineTextAlignment(.center).foregroundStyle(.white.opacity(0.75))
            Button("Autoriser la caméra") { Task { await camera.requestAndStart() } }
                .buttonStyle(.borderedProminent).tint(LensTheme.accent).foregroundStyle(.black)
        }.padding(32)
    }
}

private struct ResultOverlay: View {
    let result: LensResult
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(result.name).font(.headline)
            Text(result.subtitle).font(.caption).foregroundStyle(.secondary)
            HStack {
                if let price = result.price { Text(price).font(.title3.bold()) }
                Spacer()
                if let heat = result.heat { Text("🔥 \(heat)").font(.headline) }
            }
        }
        .padding(16)
        .foregroundStyle(.white)
        .background(LensTheme.panel, in: RoundedRectangle(cornerRadius: 18))
    }
}
