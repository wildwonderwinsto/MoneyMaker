export const HIDE_CONFIRM =
  "Hide this trader? This unfollows them and sells everything copied from them right now (your sell floor still applies). Anything that can't be sold now closes when they sell or the market settles.";

/**
 * Whether a click on the Hide / Restore button should go ahead. Hiding sells positions at
 * once and can't be undone by restoring, so it asks first (UI-11); restoring doesn't.
 */
export function confirmHide(hidden: boolean, ask: (message: string) => boolean): boolean {
  return hidden || ask(HIDE_CONFIRM);
}
