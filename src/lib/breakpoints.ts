/**
 * Tailwind's `sm` breakpoint, in one place for code that has to ask the same
 * question the `sm:` classes answer (src/app/globals.css `--breakpoint-sm:
 * 40rem`). A class cannot read this constant, so breakpoints.test.ts holds the
 * two to each other: change the theme value and the test fails until this
 * follows.
 */
export const SM_BREAKPOINT_PX = 640;

/** Matches from `sm` up: the centred dialog, not the phone sheet. */
export const SM_UP_QUERY = `(min-width: ${SM_BREAKPOINT_PX}px)`;
