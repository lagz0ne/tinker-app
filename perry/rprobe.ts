import { createElement as h, Suspense, use } from "react";
import { renderToReadableStream } from "react-dom/server";
async function show(name: string, el: any) {
  try {
    const s = await renderToReadableStream(el, { onError: (e: unknown) => console.log(name, "onError", String(e)) });
    await s.allReady;
    console.log(name, "=>", await new Response(s).text());
  } catch (e) { console.log(name, "throw", String(e)); }
}
await show("plain", h("p", null, "hi"));
await show("promise child", h("p", null, Promise.resolve("p")));
const p = Promise.resolve("used");
function U() { return use(p) as any; }
await show("use()", h(Suspense, { fallback: "f" }, h(U)));
await show("iter", h("p", null, new Set(["a", "b"])));
function C() { return h("b", null, "c"); }
await show("fn comp", h(C));
