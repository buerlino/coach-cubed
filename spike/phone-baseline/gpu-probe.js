(async () => {
  const out = { ua: navigator.userAgent, secure: isSecureContext, gpu: !!navigator.gpu,
                cores: navigator.hardwareConcurrency, memoryGB: navigator.deviceMemory ?? null,
                crossOriginIsolated: self.crossOriginIsolated, webcodecs: typeof VideoDecoder === 'function' };
  if (navigator.gpu) {
    try {
      const a = await navigator.gpu.requestAdapter();
      out.adapter = a ? { info: a.info ? { vendor: a.info.vendor, architecture: a.info.architecture, description: a.info.description } : null,
                          features: [...a.features], maxBufferSize: a.limits.maxBufferSize,
                          maxStorageBufferBindingSize: a.limits.maxStorageBufferBindingSize } : null;
      if (a) { const d = await a.requestDevice(); out.device = !!d; d.destroy(); }
    } catch (e) { out.adapterError = String(e); }
  }
  const c = document.createElement('canvas');
  out.webgl2 = !!c.getContext('webgl2');
  return out;
})()
