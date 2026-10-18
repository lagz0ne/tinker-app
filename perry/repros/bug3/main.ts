import { Base } from "./base.ts"
class Sub extends Base { y = 1 }
const r = new Sub()
try { r.addChildren([1]); console.log("ok", r.children) } catch (e) { console.log("fail", String(e)) }
