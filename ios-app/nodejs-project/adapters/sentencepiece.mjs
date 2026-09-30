import { UnsupportedFeatureError } from './unsupported.mjs';
export class SentencePieceProcessor {
    async load() { throw new UnsupportedFeatureError('WASM SentencePiece tokenizer'); }
}
