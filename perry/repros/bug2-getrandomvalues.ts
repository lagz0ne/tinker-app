const a = new Int32Array(4);
const r = crypto.getRandomValues(a);
console.log("same", r === a, typeof r, Object.prototype.toString.call(r), "a0", a[0] !== 0);
const u = crypto.getRandomValues(new Uint8Array(4));
console.log("u8", u && u.length, u instanceof Uint8Array);
