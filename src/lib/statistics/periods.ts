// Reporting periods of the Statistics page. Every period ends today at the latest, except
// "Last month" and "Last financial year", which are whole periods in the past.
import { todayStr, type DateRange } from "@/lib/stats";
import { leaveYearStart } from "@/lib/leaveUtils";

export type PeriodRule = "all" | "thisMonth" | "lastMonth" | "last3" | "last12" | "thisFY" | "lastFY" | "thisLeaveYear" | "custom";

export const PERIOD_OPTIONS: { rule: PeriodRule; label: string }[] = [
    { rule: "all", label: "All time" },
    { rule: "thisMonth", label: "This month" },
    { rule: "lastMonth", label: "Last month" },
    { rule: "last3", label: "Last 3 months" },
    { rule: "last12", label: "Last 12 months" },
    { rule: "thisFY", label: "This financial year (from 1 April)" },
    { rule: "lastFY", label: "Last financial year" },
    { rule: "thisLeaveYear", label: "This leave year (from 1 May)" },
    { rule: "custom", label: "Custom" },
];

export const periodLabel = (rule: PeriodRule) => PERIOD_OPTIONS.find(p => p.rule === rule)?.label || "Custom";

const day = (y: number, m: number, d: number) => todayStr(new Date(y, m, d));

export function periodRange(rule: PeriodRule, custom: DateRange = {}, now: Date = new Date()): DateRange {
    const y = now.getFullYear();
    const m = now.getMonth();
    const today = todayStr(now);
    const fyStart = m >= 3 ? y : y - 1;
    switch (rule) {
        case "all": return {};
        case "thisMonth": return { from: day(y, m, 1), to: today };
        case "lastMonth": return { from: day(y, m - 1, 1), to: day(y, m, 0) };
        case "last3": return { from: day(y, m - 3, now.getDate() + 1), to: today };
        case "last12": return { from: day(y - 1, m, now.getDate() + 1), to: today };
        case "thisFY": return { from: `${fyStart}-04-01`, to: today };
        case "lastFY": return { from: `${fyStart - 1}-04-01`, to: `${fyStart}-03-31` };
        case "thisLeaveYear": return { from: `${leaveYearStart(now)}-05-01`, to: today };
        case "custom": return { from: custom.from || undefined, to: custom.to || undefined };
    }
}

/** 'YYYY-MM-DD' to "1 April 2026". */
export function longDay(d?: string): string {
    if (!d) return "";
    const [y, m, dd] = d.split("-").map(Number);
    if (!y || !m || !dd) return d;
    return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).format(new Date(Date.UTC(y, m - 1, dd, 12)));
}

export function periodText(range: DateRange): string {
    if (!range.from && !range.to) return "All time";
    if (range.from && range.to) return `${longDay(range.from)} to ${longDay(range.to)}`;
    if (range.from) return `From ${longDay(range.from)}`;
    return `Up to ${longDay(range.to)}`;
}
