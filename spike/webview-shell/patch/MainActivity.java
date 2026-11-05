package org.coach.spike;

import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.util.HashMap;
import java.util.Map;

// The "bundled-isolated" mode only (build.sh): the app's own files answer with
// COOP/COEP, as serve.mjs does, so the page can be cross-origin isolated
// (SharedArrayBuffer, multi-threaded WebAssembly) without a server.
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        final Bridge b = this.bridge;
        b.setWebViewClient(new BridgeWebViewClient(b) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse r = super.shouldInterceptRequest(view, request);
                if (r == null) return null;
                Map<String, String> h = r.getResponseHeaders() == null ? new HashMap<>() : new HashMap<>(r.getResponseHeaders());
                h.put("Cross-Origin-Opener-Policy", "same-origin");
                h.put("Cross-Origin-Embedder-Policy", "require-corp");
                h.put("Cross-Origin-Resource-Policy", "same-origin");
                r.setResponseHeaders(h);
                return r;
            }
        });
    }
}
