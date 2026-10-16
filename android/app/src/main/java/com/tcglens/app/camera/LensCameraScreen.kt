package com.tcglens.app.camera

import androidx.camera.core.CameraSelector
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner

private val Background = Color(0xFF031218)
private val Accent = Color(0xFFFFD42A)

@Composable
fun LensCameraScreen(cameraGranted: Boolean, requestCamera: () -> Unit) {
    Box(Modifier.fillMaxSize().background(Background)) {
        if (cameraGranted) CameraPreview(Modifier.fillMaxSize()) else PermissionContent(requestCamera)
        Column(Modifier.fillMaxSize().padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("TCG Lens", color = Color.White, style = MaterialTheme.typography.titleLarge)
                Spacer(Modifier.weight(1f))
                FilledTonalButton(onClick = {}) { Text("?") }
            }
            Spacer(Modifier.weight(1f))
            if (cameraGranted) {
                Surface(color = Color.Black.copy(alpha = 0.62f), shape = RoundedCornerShape(50)) {
                    Text("Pointez une carte ou un produit", color = Color.White, modifier = Modifier.padding(horizontal = 18.dp, vertical = 10.dp))
                }
            }
        }
    }
}

@Composable
private fun PermissionContent(requestCamera: () -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text("Accès à la caméra", color = Color.White, style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(12.dp))
        Text("La reconnaissance fonctionne localement par défaut. Aucune vidéo n’est stockée par TCG Lens.", color = Color.White.copy(alpha = .75f))
        Spacer(Modifier.height(24.dp))
        Button(onClick = requestCamera, colors = ButtonDefaults.buttonColors(containerColor = Accent, contentColor = Color.Black)) { Text("Autoriser la caméra") }
    }
}

@Composable
private fun CameraPreview(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val lifecycleOwner = context as LifecycleOwner
    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            val previewView = PreviewView(ctx)
            val providerFuture = ProcessCameraProvider.getInstance(context)
            providerFuture.addListener({
                val provider = providerFuture.get()
                val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
                provider.unbindAll()
                provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview)
            }, ContextCompat.getMainExecutor(context))
            previewView
        }
    )
}
