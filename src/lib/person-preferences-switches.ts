/**
 * The two switches of "a signed-in person's activities and saved places follow
 * them" (mukoko-dev/mukoko-weather#484). A module of its own, two constants and
 * nothing else, so the browser can read them without loading the contract or
 * the merge: while a switch is off, none of that code is fetched.
 *
 * Nothing is written until the platform has the fields in the `identity.persons`
 * validator (a change in nyuchi/data-infra that only nyuchi applies). Until
 * then the route answers `503 preferences_unavailable` and the browser sends
 * nothing, the same pattern as `PLATFORM_DEVICES_READY` in
 * `platform-devices.ts`. Flip a constant in code, in the same change that
 * records that the validator was applied and updates
 * `preferences-route-off.test.ts`, which pins the shipped state
 * (CONTRIBUTING.md, "Turning on activities that follow the person").
 */

/** Activities, and the route as a whole. Flip once nyuchi applied the validator. */
export const PERSON_PREFERENCES_READY = false;

/**
 * Saved places. Flip only once the owner has decided the key custody and the
 * encrypted-or-readable question (the pull request for #484 states it). They
 * are ciphertext only until then (data-infra ADR-0002).
 */
export const PERSON_SAVED_PLACES_READY = false;
