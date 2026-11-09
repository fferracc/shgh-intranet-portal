// Grant dates (1 Oct 2026). Deadlines and milestone dates are calendar days, so they are kept
// as 'YYYY-MM-DD' strings and never turned into a moment in time: `new Date("2026-07-01")`
// is UTC midnight and `toISOString()` of a UK midnight in summer is the day before, which
// moved dates by one day. Text is read the UK way: 01/07/2026 is 1 July.
import { isoToLondon, londonToday } from "@/lib/social/londonTime";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");

function valid(y: number, m: number, d: number): string {
    if (!y || m < 1 || m > 12 || d < 1 || d > 31) return "";
    const t = new Date(Date.UTC(y, m - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return "";
    return `${y}-${pad(m)}-${pad(d)}`;
}
const fullYear = (y: number) => (y < 100 ? 2000 + y : y);

/** Any stored deadline (old ISO timestamps included) as 'YYYY-MM-DD' in UK time, or "". */
export function toYmd(value: unknown): string {
    if (!value) return "";
    if (typeof value === "object" && value && "toDate" in value && typeof (value as { toDate: () => Date }).toDate === "function") {
        return isoToLondon((value as { toDate: () => Date }).toDate()).date;
    }
    const s = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // An old timestamp: the UK calendar day of that moment (saved as UK or UTC midnight before).
    if (/^\d{4}-\d{2}-\d{2}T/.test(s) && !isNaN(Date.parse(s))) return isoToLondon(s).date;
    return parseUkDate(s);
}

/** A date written as text, read the UK way (day first). Returns 'YYYY-MM-DD' or "". */
export function parseUkDate(text: string): string {
    const s = String(text || "").replace(/(\d)(st|nd|rd|th)\b/gi, "$1").replace(/,/g, " ").replace(/\s+/g, " ").trim();
    let m = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(s);
    if (m) return valid(+m[1], +m[2], +m[3]);
    m = /\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})\b/.exec(s);
    if (m) return valid(fullYear(+m[3]), +m[2], +m[1]); // day / month / year
    m = /\b(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{2,4})\b/.exec(s); // 1 July 2026
    if (m) { const mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()); if (mo >= 0) return valid(fullYear(+m[3]), mo + 1, +m[1]); }
    m = /\b([A-Za-z]{3,9})\.? (\d{1,2}) (\d{4})\b/.exec(s); // July 1 2026
    if (m) { const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()); if (mo >= 0) return valid(+m[3], mo + 1, +m[2]); }
    return "";
}

/** 'YYYY-MM-DD' shown as 01/07/2026 (or with options, e.g. { day: "numeric", month: "short" }). */
export function formatUkDate(ymd: string, opts?: Intl.DateTimeFormatOptions): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
    if (!m) return "";
    if (!opts) return `${m[3]}/${m[2]}/${m[1]}`;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)).toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });
}

/** 'YYYY-MM-DD' as a local Date at midnight, for placing on a timeline next to `new Date()`. */
export function ymdToLocalDate(ymd: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

export const ymdYear = (ymd: string) => (/^\d{4}/.test(ymd || "") ? ymd.slice(0, 4) : "");

export { londonToday };
