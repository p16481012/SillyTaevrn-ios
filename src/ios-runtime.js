import { isIOS } from './server-directory.js';

export const IOS_CAPABILITIES = Object.freeze({
    localTransformers: false,
    tokenization: { openai: 'exact', sentencepiece: 'estimated', huggingface: 'estimated' },
    vectorStorage: true,
    extensionInstall: true,
    extensionGitManagement: { version: true, update: true, branches: true },
    pacProxy: false,
});

/** @param {import('express').Express} app */
export function installIOSRoutes(app) {
    if (!isIOS) return;

    app.get('/api/ios/capabilities', (_, response) => response.json(IOS_CAPABILITIES));

    const unsupported = response => response.status(501).json({
        error: 'This operation needs a local inference engine that is not included in this iOS app. Use a remote provider.',
        code: 'IOS_LOCAL_INFERENCE_UNAVAILABLE',
    });

    app.use(['/api/extra/classify', '/api/extra/caption'], (_, response) => unsupported(response));
    app.use('/api/speech', (request, response, next) => {
        if (['/recognize', '/synthesize'].includes(request.path)) return unsupported(response);
        next();
    });
    app.use('/api/vector', (request, response, next) => {
        const source = request.body?.source ?? 'transformers';
        if (['/insert', '/query', '/query-multi'].includes(request.path) && source === 'transformers') {
            return unsupported(response);
        }
        next();
    });
}
