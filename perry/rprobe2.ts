import { createElement as h, Component } from "react";
import { renderToString } from "react-dom/server";
class K extends Component<{}, { e: boolean }> {
  state = { e: false };
  static getDerivedStateFromError() { return { e: true }; }
  render() { return h("i", null, "class ok"); }
}
console.log("isReactComponent on proto chain:", !!(K.prototype as any).isReactComponent, typeof (Component.prototype as any).isReactComponent);
console.log("Object.getPrototypeOf(K.prototype)===Component.prototype", Object.getPrototypeOf(K.prototype) === Component.prototype);
try { console.log(renderToString(h(K))); } catch (e) { console.log("throw", String(e)); }
function P() {} ; P.prototype.flag = 1;
class Q extends (P as any) {}
console.log("plain fn base: inherited flag", (Q.prototype as any).flag);
