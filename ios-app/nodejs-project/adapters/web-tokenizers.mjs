import { UnsupportedFeatureError } from './unsupported.mjs';
export class Tokenizer {
    static async fromJSON() { throw new UnsupportedFeatureError('WASM web tokenizer'); }
}
