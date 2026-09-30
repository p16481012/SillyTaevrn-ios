// Executable discovery is unavailable in the iOS sandbox.
export const sync = () => false;
export default async function commandExists() { return false; }
