/** Use the requested installed runtime, never simctl's incidental list order. */
export function selectCITemplate(listing, runtimeIdentifier) {
    if (!/^com\.apple\.CoreSimulator\.SimRuntime\.iOS-\d+(?:-\d+){1,2}$/.test(runtimeIdentifier ?? '')) {
        throw new Error('An explicit iOS runtime identifier is required for CI.');
    }
    const runtime = listing.runtimes?.find(item => item.identifier === runtimeIdentifier && item.isAvailable === true);
    if (!runtime) throw new Error(`Required Simulator runtime is unavailable: ${runtimeIdentifier}`);
    const device = listing.devices?.[runtimeIdentifier]?.find(item => item.isAvailable === true
        && item.deviceTypeIdentifier === 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro');
    if (!device || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(device.udid ?? '')
        || !['Booted', 'Shutdown'].includes(device.state)) {
        throw new Error(`No ready iPhone 17 Pro template for ${runtimeIdentifier}; refusing a different runtime/device.`);
    }
    return { ...device, runtime: { identifier: runtime.identifier, version: runtime.version, buildVersion: runtime.buildversion } };
}
