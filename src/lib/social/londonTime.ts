// UK wall clock time (Europe/London) to and from real instants (1 Oct 2026).
// The portal is used in the UK, but a browser set to another zone, or a date string read
// with `new Date("YYYY-MM-DD")` (which is UTC midnight), moved times by an hour in British
// Summer Time and dates by a day. Everything that shows or edits a UK time goes through here.
// Used by the social studio, the grants page and the recruitment interview form.

const PARTS = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

function londonFields(ms: number) {
    const o: Record<string, number> = {};
    for (const p of PARTS.formatToParts(new Date(ms))) if (p.type !== "literal") o[p.type] = Number(p.value);
    return { y: o.year, mo: o.month, d: o.day, h: o.hour === 24 ? 0 : o.hour, mi: o.minute, s: o.second };
}

/** Minutes London is ahead of UTC at this instant (0 in winter, 60 in summer). */
export function londonOffsetMinutes(ms: number): number {
    const f = londonFields(ms);
    const asUtc = Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s);
    return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** 'YYYY-MM-DD' + 'HH:MM' read as UK time, as an ISO instant. Empty string if not valid. */
export function londonToIso(date: string, time: string): string {
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
    const tm = /^(\d{1,2}):(\d{2})/.exec(time || "");
    if (!dm || !tm) return "";
    const guess = Date.UTC(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2]);
    let ms = guess - londonOffsetMinutes(guess) * 60000;
    // Around the clock change the offset at the result can differ from the guess.
    const again = guess - londonOffsetMinutes(ms) * 60000;
    if (again !== ms) ms = again;
    return isNaN(ms) ? "" : new Date(ms).toISOString();
}

/** An instant as UK date 'YYYY-MM-DD' and time 'HH:MM'. */
export function isoToLondon(iso: string | number | Date): { date: string; time: string } {
    const ms = iso instanceof Date ? iso.getTime() : typeof iso === "number" ? iso : Date.parse(iso);
    if (isNaN(ms)) return { date: "", time: "" };
    const f = londonFields(ms);
    const p = (n: number) => String(n).padStart(2, "0");
    return { date: `${f.y}-${p(f.mo)}-${p(f.d)}`, time: `${p(f.h)}:${p(f.mi)}` };
}

/** Today's UK date as 'YYYY-MM-DD'. */
export function londonToday(): string {
    return isoToLondon(Date.now()).date;
}

/** An instant shown in UK time, e.g. "Wednesday 1 October 2026, 14:30". */
export function formatLondon(iso: string | number | Date, opts?: Intl.DateTimeFormatOptions): string {
    const d = iso instanceof Date ? iso : new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString("en-GB", { timeZone: "Europe/London", ...(opts || { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) });
}
