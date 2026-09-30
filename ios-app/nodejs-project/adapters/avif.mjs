import { UnsupportedFeatureError } from './unsupported.mjs';
export default function avif() {
    return { mime: 'image/avif',
        encode() { throw new UnsupportedFeatureError('AVIF encoding'); },
        decode() { throw new UnsupportedFeatureError('AVIF decoding'); },
    };
}
