import { eventSource, event_types } from './events.js';

// The backend is the authority for iOS feature support. Keep this module
// inert in desktop browsers and Android Capacitor sessions on localhost.
const native = window.__ST_IOS_APP__;
const localOrigin = location.protocol === 'http:'
    && ['localhost', '127.0.0.1'].includes(location.hostname)
    && location.port === '8000';

const unavailableChoices = [
    { selectId: 'vectors_source', value: 'transformers', name: 'Local vectorization', korean: '로컬 벡터화' },
    { selectId: 'caption_source', value: 'local', name: 'Local image captioning', korean: '로컬 이미지 설명' },
    { selectId: 'expression_api', value: '0', name: 'Local expression classification', korean: '로컬 표정 분류' },
    { selectId: 'tts_provider', value: 'SpeechT5', name: 'SpeechT5', korean: 'SpeechT5' },
];

function addDescription(select, id, message) {
    let note = document.getElementById(id);
    if (!note) {
        note = document.createElement('small');
        note.id = id;
        note.className = 'neutral_warning';
        note.textContent = message;
        const anchor = select.id === 'tts_provider' ? select.closest('.tts_block') || select : select;
        anchor.insertAdjacentElement('afterend', note);
    }
    const descriptions = new Set((select.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
    if (!descriptions.has(id)) {
        descriptions.add(id);
        select.setAttribute('aria-describedby', [...descriptions].join(' '));
    }
}

function applyLocalInferenceGuidance() {
    const korean = document.documentElement.lang.toLowerCase().startsWith('ko');
    for (const { selectId, value, name, korean: koreanName } of unavailableChoices) {
        const select = document.getElementById(selectId);
        const option = Array.from(select?.options || []).find(option => option.value === value);
        if (!option) continue;
        const message = korean
            ? `${koreanName}는 이 iOS 앱에 로컬 추론 엔진이 없어 사용할 수 없습니다. 사용 가능한 원격 제공자를 선택하세요.`
            : `${name} is unavailable in this iOS app because it has no local inference engine. Select a supported remote provider.`;
        option.disabled = true;
        option.title = message;
        addDescription(select, `st-ios-unavailable-${selectId}`, message);
    }
}

function applyTokenizerGuidance(capabilities) {
    const tokenization = capabilities.tokenization || {};
    if (tokenization.sentencepiece !== 'estimated'
        && !['estimated', 'partial'].includes(tokenization.huggingface)) return;
    const select = document.getElementById('tokenizer');
    if (!select) return;
    const korean = document.documentElement.lang.toLowerCase().startsWith('ko');
    const builtInModels = tokenization.huggingfaceExactModels || [];
    const partial = tokenization.huggingface === 'partial'
        && builtInModels.includes('claude') && builtInModels.includes('llama3');
    const message = partial
        ? (korean
            ? 'iOS에서 SentencePiece 토큰 수는 추정치입니다. 내장 Claude·Llama 3 토크나이저는 검증된 JavaScript 경로를 사용하며, 그 외 Hugging Face 모델은 추정치입니다.'
            : 'On iOS, SentencePiece token counts are estimates. Bundled Claude and Llama 3 tokenizers use a validated JavaScript implementation; other Hugging Face models remain estimates.')
        : (korean
            ? 'iOS에서는 SentencePiece 및 Hugging Face 계열 토큰 수가 추정치입니다. OpenAI/GPT-2 또는 지원되는 원격 API 토큰 계산을 사용하면 정확한 값을 얻을 수 있습니다.'
            : 'On iOS, SentencePiece and Hugging Face token counts are estimates. OpenAI/GPT-2 or a supported remote API can provide exact counts.');
    addDescription(select, 'st-ios-tokenizer-estimate', message);
}

async function installCapabilityGuidance() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let capabilities;
    try {
        const response = await fetch('/api/ios/capabilities', {
            cache: 'no-store',
            credentials: 'same-origin',
            signal: controller.signal,
        });
        const responseURL = new URL(response.url);
        if (response.status !== 200 || responseURL.origin !== location.origin || responseURL.pathname !== '/api/ios/capabilities') return;
        capabilities = await response.json();
    } finally {
        clearTimeout(timeout);
    }

    if (capabilities?.localTransformers === false) {
        applyLocalInferenceGuidance();
        // Extension settings are injected after the main document loads. Watch
        // only those drawers; chat streaming must not trigger rescans.
        const observer = new MutationObserver(() => applyLocalInferenceGuidance());
        for (const id of ['extensions_settings', 'extensions_settings2']) {
            const container = document.getElementById(id);
            if (container) observer.observe(container, { childList: true, subtree: true });
        }
    }
    applyTokenizerGuidance(capabilities || {});
}

if (native && localOrigin && typeof native.deploymentId === 'string' && typeof native.version === 'string') {
    eventSource.on(event_types.APP_READY, () => {
        void installCapabilityGuidance().catch(() => {
            console.warn('Could not load iOS capability guidance.');
        });
    });
}
