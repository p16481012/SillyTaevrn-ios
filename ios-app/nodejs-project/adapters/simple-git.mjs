import { UnsupportedFeatureError } from './unsupported.mjs';
export const CheckRepoActions = { IS_REPO_ROOT: 'root', IS_REPO_ROOT_OR_BARE: 'root-or-bare' };
export default function simpleGit() { throw new UnsupportedFeatureError('System Git executable'); }
