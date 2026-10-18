export class Base {
  children?: unknown
  addChildren = (c: unknown) => this._add(c)
  _add = (c: unknown) => { this.children = c; return this }
}
