import { UnsupportedFeatureError } from './unsupported.mjs';
export default async function open() { throw new UnsupportedFeatureError('Opening a browser from Node'); }
