/** Explicit failure prevents unsupported features from reporting fake success. */
export class UnsupportedFeatureError extends Error {
    constructor(feature) {
        super(`${feature} is not available in the iOS runtime.`);
        this.name = 'UnsupportedFeatureError';
        this.code = 'IOS_UNSUPPORTED_FEATURE';
        this.status = 501;
        this.feature = feature;
    }
}
