'use strict'
// Ходьба: ленивые модули частей (загрузка при первом вызове, как было в movement.ts), запомненные: require из папки части
// не попадает в быстрый кеш Node по (папка, spec), и в горячем цикле (клетка A*, физический тик) каждый вызов разбирал бы
// путь заново.
let pickLoaded: typeof import('../pick') | undefined
export const lazyPick = (): typeof import('../pick') => (pickLoaded ??= require('../pick'))
let eyesLoaded: typeof import('../perception/eyes') | undefined
export const lazyEyes = (): typeof import('../perception/eyes') => (eyesLoaded ??= require('../perception/eyes'))
let itemsLoaded: typeof import('../items') | undefined
export const lazyItems = (): typeof import('../items') => (itemsLoaded ??= require('../items'))
let buildLoaded: typeof import('../build') | undefined
export const lazyBuild = (): typeof import('../build') => (buildLoaded ??= require('../build'))
