/**
 * RETIRED (1 Oct 2026). The portal no longer connects to the Ghana Firebase project
 * (shgh-attendance-redesign) from the browser, and no longer signs in there anonymously.
 *
 * Anonymous sign-in with the public API key is open to anyone, so the children's names in
 * the Ghana `portalPublic` snapshot were in effect public. The portal server now reads the
 * Ghana data for people with the Ghana Operations permission: see `functions/ghana.js`
 * (callable `ghanaOverview`) and `src/lib/ghana/overview.ts`.
 *
 * Nothing imports this file any more. It is left as an empty stub so an old import fails
 * loudly at build time instead of quietly reopening the anonymous route, and it can be
 * deleted. The NEXT_PUBLIC_GHANA_FIREBASE_* environment variables are no longer used.
 */

export const GHANA_PROJECT_ID = 'shgh-attendance-redesign';
