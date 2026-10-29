/**
 * Host half. It exists so the package composes as a row; every contribution is made in the browser
 * (see ./client), because that is where the pointer type, the keyboard and the home-screen icon
 * live.
 */
export const name = '@idsh/mobile'

/** Nothing to do on the host: no service, no config, no state. */
// oxlint-disable-next-line no-empty-function -- the host half has nothing to do
export function apply(): void {}
