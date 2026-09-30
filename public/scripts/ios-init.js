import { event_types, eventSource } from './events.js';

// The native marker identifies this app; a desktop localhost or Android
// Capacitor session must keep its normal layout and startup behavior.
const native = window.__ST_IOS_APP__;
const localOrigin = location.protocol === 'http:'
    && ['localhost', '127.0.0.1'].includes(location.hostname)
    && location.port === '8000';

if (native && localOrigin && typeof native.deploymentId === 'string' && typeof native.version === 'string') {
    const reportError = (message) => {
        window.webkit?.messageHandlers?.stError?.postMessage({ message: String(message).slice(0, 400) });
    };

    document.documentElement.classList.add('st-ios');
    document.body.classList.add('st-ios');
    const cssReady = new Promise((resolve) => {
        const stylesheet = document.createElement('link');
        stylesheet.id = 'st-ios-css';
        stylesheet.rel = 'stylesheet';
        stylesheet.href = '/css/ios-overrides.css';
        stylesheet.addEventListener('load', () => resolve(true), { once: true });
        stylesheet.addEventListener('error', () => {
            reportError('Could not load the iOS stylesheet.');
            resolve(false);
        }, { once: true });
        document.head.appendChild(stylesheet);
    });

    let viewportFrame = 0;
    const lastViewportValues = new Map();
    function updateViewport() {
        cancelAnimationFrame(viewportFrame);
        viewportFrame = requestAnimationFrame(() => {
            const viewport = window.visualViewport;
            // Pinch zoom changes visualViewport too; preserve the layout when
            // zoomed and use its bounds only for the unzoomed keyboard viewport.
            const unzoomed = viewport && Math.abs(viewport.scale - 1) < 0.01;
            const height = unzoomed ? viewport.height : window.innerHeight;
            const width = unzoomed ? viewport.width : window.innerWidth;
            const top = unzoomed ? Math.max(0, viewport.offsetTop) : 0;
            const left = unzoomed ? Math.max(0, viewport.offsetLeft) : 0;
            const bounds = {
                height,
                width,
                'offset-top': top,
                'offset-left': left,
                'inset-bottom': Math.max(0, window.innerHeight - height - top),
                'inset-right': Math.max(0, window.innerWidth - width - left),
            };
            for (const [name, value] of Object.entries(bounds)) {
                const pixels = `${Math.round(value)}px`;
                if (lastViewportValues.get(name) !== pixels) {
                    document.documentElement.style.setProperty(`--st-viewport-${name}`, pixels);
                    lastViewportValues.set(name, pixels);
                }
            }
            document.body.classList.toggle('st-ios-keyboard', height < window.innerHeight - 100);
            // Keyboard focus can scroll WKWebView's document in addition to
            // reducing its visual viewport. The app scrolls chat/drawers inside
            // their own elements; restore only this unwanted root displacement.
            // Preserve root/visual viewport panning while the user pinch zooms.
            if ((!viewport || unzoomed) && (window.scrollX || window.scrollY)) {
                window.scrollTo(0, 0);
            }
        });
    }
    window.__ST_IOS_RESUME__ = updateViewport;
    window.addEventListener('resize', updateViewport);
    window.addEventListener('scroll', updateViewport);
    window.addEventListener('pageshow', updateViewport);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) updateViewport();
    });
    window.visualViewport?.addEventListener('resize', updateViewport);
    // WebKit may pan the visual viewport to the focused field without changing
    // its size. Keep modal bounds above the keyboard during that scroll too.
    window.visualViewport?.addEventListener('scroll', updateViewport);
    updateViewport();

    // First-run onboarding intentionally waits for input before APP_READY.
    // Reveal that interaction without treating the application as initialized.
    eventSource.on(event_types.APP_INITIALIZATION_INTERACTION, ({ active, reason } = {}) => {
        if (typeof active !== 'boolean') return;
        window.__ST_IOS_INTERACTION__ = active;
        void cssReady.then(loaded => {
            if (!loaded) return;
            window.webkit?.messageHandlers?.stInteraction?.postMessage({
                active,
                reason: typeof reason === 'string' ? reason.slice(0, 80) : 'initialization',
                deploymentId: native.deploymentId,
                version: native.version,
            });
        });
    });

    async function announceReady() {
        if (window.__ST_IOS_READY__ || !await cssReady) return;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
        try {
            const response = await fetch('/api/ios/health', {
                cache: 'no-store',
                credentials: 'same-origin',
                signal: controller.signal,
            });
            if (response.status !== 200) throw new Error(`Local health check returned HTTP ${response.status}.`);
            const responseURL = new URL(response.url);
            if (responseURL.origin !== location.origin || responseURL.pathname !== '/api/ios/health') {
                throw new Error('The local health request was redirected to an unexpected address.');
            }
            const health = await response.json();
            if (health.ready !== true || health.deploymentId !== native.deploymentId || health.version !== native.version) {
                throw new Error('The interface and local backend deployment do not match.');
            }
            updateViewport();
            window.__ST_IOS_READY__ = true;
            window.webkit?.messageHandlers?.stReady?.postMessage({
                deploymentId: health.deploymentId,
                version: health.version,
            });
        } finally {
            clearTimeout(timeout);
        }
    }

    // APP_READY is replayed by EventEmitter when initialization has already
    // completed, so a late module load cannot miss the native readiness signal.
    eventSource.on(event_types.APP_READY, () => {
        void announceReady().catch(error => reportError(error instanceof Error ? error.message : 'Interface initialization failed.'));
    });
}
