import { UnsupportedFeatureError } from './unsupported.mjs';

// Importing configuration starts no model download, ONNX or WebAssembly runtime.
export const env = { backends: { onnx: { wasm: {} } }, allowLocalModels: false, allowRemoteModels: false };
export async function pipeline() { throw new UnsupportedFeatureError('Local Transformers inference'); }
export class RawImage {
    static async fromBlob() { throw new UnsupportedFeatureError('Local Transformers image processing'); }
}
