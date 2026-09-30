import { UnsupportedFeatureError } from './unsupported.mjs';

// PAC evaluates downloaded JavaScript through QuickJS/WASM. Ordinary proxies
// continue to use proxy-agent's HTTP, HTTPS and SOCKS implementations.
export class PacProxyAgent {
    constructor() { throw new UnsupportedFeatureError('PAC proxy scripts'); }
}
