// What the extension's pdf.js (built for current Chrome) expects and Node 22 lacks, plus quiet for its one warning.
Promise.try ??= (fn, ...args) => new Promise(ok => ok(fn(...args)));
const warn = console.warn;   // pdf.js asks for its "legacy" build under Node; the modern one is fine for reading
console.warn = (...a) => (/legacy/.test(a[0]) ? undefined : warn(...a));
const log = console.log;
console.log = (...a) => (/legacy/.test(a[0]) ? undefined : log(...a));
Uint8Array.prototype.toHex ??= function () { return Array.from(this, b => b.toString(16).padStart(2, '0')).join(''); };
Uint8Array.prototype.toBase64 ??= function () { return Buffer.from(this).toString('base64'); };
Uint8Array.fromHex ??= hex => Uint8Array.from(Buffer.from(hex, 'hex'));
Uint8Array.fromBase64 ??= b64 => Uint8Array.from(Buffer.from(b64, 'base64'));
