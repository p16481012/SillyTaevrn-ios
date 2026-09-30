import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tiktoken as JsTiktoken, getEncodingNameForModel } from 'js-tiktoken/lite';

const encodings = new Set(['gpt2', 'r50k_base', 'p50k_base', 'p50k_edit', 'cl100k_base', 'o200k_base']);

function loadRanks(name) {
    if (!encodings.has(name)) throw new Error(`Unknown tiktoken encoding: ${name}`);
    // In the bundle import.meta.url points to server-bundle.mjs, next to assets/.
    const runtimeDir = process.env.ST_RUNTIME_DIR || path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(fs.readFileSync(path.join(runtimeDir, 'assets', 'tiktoken', `${name}.json`), 'utf8'));
}

/** The pinned js-tiktoken implementation exposes its byte maps as JS properties. */
export class Tiktoken {
    constructor(ranks, extendedSpecialTokens) {
        this.engine = new JsTiktoken(ranks, extendedSpecialTokens);
        if (!(this.engine.textMap instanceof Map) || !this.engine.inverseSpecialTokens) {
            throw new Error('The js-tiktoken byte decoding contract changed.');
        }
    }
    encode(text, allowedSpecial = [], disallowedSpecial = 'all') {
        this.assertLive();
        return Uint32Array.from(this.engine.encode(text, allowedSpecial, disallowedSpecial));
    }
    encode_ordinary(text) { return this.encode(text, [], []); }
    decode(tokens) {
        this.assertLive();
        // An individual token can end mid-codepoint: preserve its original UTF-8 bytes.
        const chunks = Array.from(tokens, id => {
            const bytes = this.engine.textMap.get(id) ?? this.engine.inverseSpecialTokens[id];
            if (!bytes) throw new Error(`Unknown token id: ${id}`);
            return bytes;
        });
        const output = new Uint8Array(chunks.reduce((size, bytes) => size + bytes.length, 0));
        let offset = 0;
        for (const bytes of chunks) { output.set(bytes, offset); offset += bytes.length; }
        return output;
    }
    free() { this.engine = null; }
    assertLive() { if (!this.engine) throw new Error('Tokenizer was already freed.'); }
}
export function get_encoding(name, extendedSpecialTokens) {
    return new Tiktoken(loadRanks(name), extendedSpecialTokens);
}
export function encoding_for_model(model, extendedSpecialTokens) {
    return get_encoding(getEncodingNameForModel(model), extendedSpecialTokens);
}
export default { Tiktoken, get_encoding, encoding_for_model };
