import { UnsupportedFeatureError } from './unsupported.mjs';
export default function webp() {
    return { mime: 'image/webp',
        encode() { throw new UnsupportedFeatureError('WebP encoding'); },
        decode() { throw new UnsupportedFeatureError('WebP decoding'); },
    };
}
