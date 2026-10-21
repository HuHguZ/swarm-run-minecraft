// Keep tactical ownership separate from the caller's optional style parameter.
type HuntCtl = { aborted?: boolean }
const covers = new WeakMap<object, HuntCtl>()
export function setHuntCover (session: object, ctl: HuntCtl, ready: boolean) {
  if (ready) covers.set(session, ctl)
  else if (covers.get(session) === ctl) covers.delete(session)
}
export function ownsHuntCover (session: { current?: { ctl?: HuntCtl } }): boolean {
  const ctl = covers.get(session)
  return !!ctl && !ctl.aborted && ctl === session.current?.ctl
}
