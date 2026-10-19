'use strict'
// Методы части сессии (`function f (this: Session, …)`) как методы класса: без параметра this.
export type PartMethods<M> = { [K in keyof M]: M[K] extends (this: any, ...a: infer A) => infer R ? (...a: A) => R : never }
