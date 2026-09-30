/** Basic natural sorting when nodejs-mobile was built without ICU. */
export function installRuntimePolyfills(runtime = globalThis) {
    runtime.Intl ??= {};
    runtime.Intl.Collator ??= function Collator(_locale, options = {}) {
        const compare = (left, right) => {
            let a = String(left), b = String(right);
            if (['base', 'accent'].includes(options.sensitivity)) { a = a.toLowerCase(); b = b.toLowerCase(); }
            if (options.numeric) {
                const aa = a.match(/\d+|\D+/g) ?? [], bb = b.match(/\d+|\D+/g) ?? [];
                for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
                    if (aa[i] === bb[i]) continue;
                    if (/^\d+$/.test(aa[i]) && /^\d+$/.test(bb[i])) {
                        const numberA = aa[i].replace(/^0+(?=\d)/, ''), numberB = bb[i].replace(/^0+(?=\d)/, '');
                        if (numberA.length !== numberB.length) return numberA.length - numberB.length;
                        if (numberA !== numberB) return numberA < numberB ? -1 : 1;
                        continue;
                    }
                    return aa[i] < bb[i] ? -1 : 1;
                }
                return aa.length - bb.length;
            }
            return a < b ? -1 : a > b ? 1 : 0;
        };
        // Upstream calls both Intl.Collator() and new Intl.Collator().
        return { compare };
    };
}
