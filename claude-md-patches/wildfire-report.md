# Suggested CLAUDE.md wording for the wildfire report type

Not applied (CLAUDE.md is not edited by this change). Apply by hand on the
development branches; `main` never holds CLAUDE.md.

## "Community Weather Reporting (Waze-Style)" - report types

Replace "**Report types (13):** light-rain, heavy-rain, thunderstorm, hail,
flooding, strong-wind, clear-skies, cloudy, fog, mist, haze, dust, frost."
with:

**Report types (14):** light-rain, heavy-rain, thunderstorm, hail, flooding,
wildfire, strong-wind, clear-skies, cloudy, fog, mist, haze, dust, frost.
Sourced from `src/lib/report-types.ts` ... Must stay in sync with the backend
allowlist in THREE other places, changed together: `REPORT_TYPES` in
`weather_core::community` (the validation source of truth), the bridge's copy in
`workers/mongo-bridge/src/validate.ts`, and the fallback question pair in
`weather_core::community::fallback_questions` (plus
`tests/fixtures/community-contract.json`). `report-types.test.ts` compares the
TS list with both the Rust and the bridge lists.

Add a paragraph:

**A wildfire report is never verified.** `weather_core::community::
NEVER_VERIFIED` (`["wildfire"]`) is checked first in `cross_validate`, so a
wildfire report is `verified: false` with a forecast, without one, and whatever
the weather says (hot, dry and windy is not a fire). The bridge repeats it
(`NEVER_VERIFIED_REPORT_TYPES`; a wildfire report marked verified is a 400), and
the app never draws the Verified mark for it (`showsVerified()` in
`report-types.ts`): `RecentReports` and the `CommunityLane` panel show
"Community report, unverified" (`UNVERIFIED_REPORT_LABEL`) instead. The wizard
shows a note before Submit and again after sending: "This is not an emergency
service. If anyone is in danger, call your local emergency services first."
(`EMERGENCY_NOTICE`; never a phone number, the app is used in many countries).
A report sends no notification to anyone. The 5-an-hour limit, the 24/48/72 h
lifetimes and the 300-character description cap are the same as for every type.
The icon is the Lucide `Flame` (the other types use the app's own SVG icons).

## "Rate limiting" / `POST /v1/reports/clarify`

"one of the 13 types" -> "one of the 14 types". Wildfire has its own fixed pair
(what you can see: smoke, flames or both; roughly how far away); it asks what is
seen and never tells anyone to act.

## Fixtures

`tests/fixtures/report-clarify.json` gained a hand-added wildfire prompt case
(`_extended`), and `report-submit.json`'s unknown-type refusal text lists the
14th type (`_extended`); the Python that produced them is deleted, so any new
report type is written into these fixtures by hand and named in `_extended`.
`community-contract.json` gained the wildfire `fallbackQuestions` vector.
