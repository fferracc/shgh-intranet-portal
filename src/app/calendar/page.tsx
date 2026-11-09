"use client";

import { RequirePermission } from "@/components/auth/RequirePermission";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useEffect, useMemo, useState } from "react";
import { collection, query, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Course } from "@/lib/types";
import { isRunning, isOneToOne } from "@/lib/stats";
import { describeSchedule } from "@/lib/courses";
import { UK_BANK_HOLIDAYS_2025_2026 } from "@/lib/bankHolidays";
import { ChevronLeft, ChevronRight, ExternalLink, X } from "lucide-react";
import Link from "next/link";

// Weekly class calendar (updated 1 Oct 2026):
//  * the grid runs from 7:00 to 22:00;
//  * only running courses (any capitals), and only between their start and end dates when set;
//  * weekly courses every week; fortnightly and monthly ones on the right weeks, counted from the
//    start date (without a start date they are listed under "Custom schedule");
//  * courses with a Custom frequency, no weekday or no times are listed under the grid, not placed every week;
//  * on a bank holiday the day's classes are struck through: "No class (bank holiday)".

const FIRST_HOUR = 7;
const LAST_HOUR = 22;
const ROW_PX = 50;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Local "YYYY-MM-DD" (not toISOString, which is a day out during British Summer Time). */
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** "2026-09-14" (or a longer ISO string) as a local date, or null. */
function parseDay(v: unknown): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ""));
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
}
const mondayOf = (d: Date) => {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = x.getDay();
    x.setDate(x.getDate() - (day === 0 ? 6 : day - 1));
    return x;
};
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const hoursOf = (time: unknown): number | null => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(time || ""));
    return m ? Number(m[1]) + Number(m[2]) / 60 : null;
};

/** "Monday", "mon", "MONDAY" -> 1; unknown -> null. */
function weekdayIndex(day: unknown): number | null {
    const s = String(day || "").trim().toLowerCase();
    if (!s) return null;
    const i = DAY_NAMES.findIndex(n => n.toLowerCase() === s || n.toLowerCase().slice(0, 3) === s.slice(0, 3));
    return i >= 0 ? i : null;
}

type Freq = "weekly" | "fortnightly" | "monthly" | "custom";
function freqOf(c: Course): Freq {
    const f = String(c.schedule?.frequency || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
    if (!f || f === "weekly" || f === "everyweek") return "weekly";
    if (["biweekly", "fortnightly", "every2weeks", "everytwoweeks"].includes(f)) return "fortnightly";
    if (f === "monthly" || f === "everymonth") return "monthly";
    return "custom";
}

/** Placed on the grid (true) or listed under "Custom schedule" (false). */
function placeOnGrid(c: Course): boolean {
    if (isOneToOne(c)) return false;
    const f = freqOf(c);
    if (f === "custom") return false;
    if (weekdayIndex(c.schedule?.day) === null) return false;
    const start = hoursOf(c.schedule?.start), end = hoursOf(c.schedule?.end);
    if (start === null || end === null || end <= start) return false;
    if ((f === "fortnightly" || f === "monthly") && !parseDay(c.startDate)) return false;
    return true;
}

/** Is the date within the course's start and end dates (each only when set)? */
function withinDates(c: Course, d: Date): boolean {
    const s = parseDay(c.startDate), e = parseDay(c.endDate);
    if (s && d < s) return false;
    if (e && d > e) return false;
    return true;
}

/** Does a gridded course meet on this date? */
function meetsOn(c: Course, d: Date): boolean {
    if (weekdayIndex(c.schedule?.day) !== d.getDay()) return false;
    if (!withinDates(c, d)) return false;
    const f = freqOf(c);
    if (f === "weekly") return true;
    const start = parseDay(c.startDate)!;
    // The first class: the first day on or after the start date that falls on the course's weekday.
    const first = new Date(start);
    while (first.getDay() !== d.getDay()) first.setDate(first.getDate() + 1);
    if (f === "fortnightly") {
        const diffDays = Math.round((d.getTime() - first.getTime()) / 86400000);
        return diffDays >= 0 && diffDays % 14 === 0;
    }
    // Monthly: the same week of the month as the first class (1st, 2nd, 3rd...), or the last one.
    const occurrence = (x: Date) => Math.ceil(x.getDate() / 7);
    const isLast = (x: Date) => addDays(x, 7).getMonth() !== x.getMonth();
    if (isLast(first) && occurrence(first) >= 4) return isLast(d);
    return occurrence(first) === occurrence(d);
}

function CalendarPageContent() {
    const [courses, setCourses] = useState<Course[]>([]);
    const [weekStart, setWeekStart] = useState<Date>(() => mondayOf(new Date()));
    const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchCourses = async () => {
            try {
                // 1. Users for volunteer names
                const usersSnap = await getDocs(collection(db, "users"));
                const usersMap: Record<string, string> = {};
                usersSnap.forEach(doc => {
                    const data = doc.data();
                    if (['volunteer', 'staff', 'admin', 'super_admin'].includes(data.role)) {
                        usersMap[doc.id] = data.name || data.displayName || data.email || "Unknown";
                    }
                });

                // 2. Course assignments: who teaches what
                const assignSnap = await getDocs(collection(db, "courseAssignments"));
                const courseVolunteers: Record<string, { id: string, name: string }[]> = {};
                assignSnap.forEach(doc => {
                    const data = doc.data();
                    if (data.volunteerId && data.courseId) {
                        if (!courseVolunteers[data.courseId]) courseVolunteers[data.courseId] = [];
                        if (!courseVolunteers[data.courseId].some(v => v.id === data.volunteerId)) {
                            courseVolunteers[data.courseId].push({ id: data.volunteerId, name: usersMap[data.volunteerId] || "Unknown Volunteer" });
                        }
                    }
                });

                // 3. Running courses only (any capitals)
                const snapshot = await getDocs(query(collection(db, "course")));
                const data: Course[] = [];
                snapshot.forEach(doc => {
                    const docData = doc.data();
                    if (isRunning(docData)) {
                        data.push({ id: doc.id, ...docData, volunteers: courseVolunteers[doc.id] || [] } as Course);
                    }
                });
                setCourses(data);
            } catch (e) {
                console.error("Could not load the calendar", e);
            } finally {
                setLoading(false);
            }
        };
        fetchCourses();
    }, []);

    const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
    const weekEnd = weekDays[6];
    const todayKey = dayKey(new Date());
    const holidays = useMemo(() => {
        const m = new Map<string, string>();
        UK_BANK_HOLIDAYS_2025_2026.forEach(h => m.set(h.date, h.title));
        return m;
    }, []);

    const gridCourses = courses.filter(placeOnGrid);
    // Custom schedule list: running courses not placed on the grid that run at some point this week.
    const customCourses = courses
        .filter(c => !placeOnGrid(c))
        .filter(c => {
            const s = parseDay(c.startDate), e = parseDay(c.endDate);
            return !(s && s > weekEnd) && !(e && e < weekStart);
        })
        .sort((a, b) => (a.code || a.name || "").localeCompare(b.code || b.name || ""));

    const hourRows = Array.from({ length: LAST_HOUR - FIRST_HOUR }, (_, i) => i + FIRST_HOUR); // 7:00 ... 21:00 rows, ending at 22:00
    const isThisWeek = dayKey(weekStart) === dayKey(mondayOf(new Date()));
    const fmtShort = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });

    return (
        <DashboardLayout>
            <div className="flex flex-col md:flex-row md:justify-between md:items-center gap-4 mb-6">
                <div>
                    <h1 className="text-2xl font-bold text-slate-800">Weekly Schedule</h1>
                    <p className="text-slate-500">Running courses for the week. Click a class for its details.</p>
                </div>
                <div className="flex items-center gap-2 bg-white p-2 rounded-lg shadow-sm border border-slate-100">
                    <button onClick={() => setWeekStart(addDays(weekStart, -7))} className="p-2 hover:bg-slate-50 rounded" aria-label="Previous week"><ChevronLeft size={20} /></button>
                    <span className="font-medium text-slate-700 min-w-[150px] text-center">
                        {fmtShort(weekDays[0])} to {fmtShort(weekDays[6])} {weekDays[6].getFullYear()}
                    </span>
                    <button onClick={() => setWeekStart(addDays(weekStart, 7))} className="p-2 hover:bg-slate-50 rounded" aria-label="Next week"><ChevronRight size={20} /></button>
                    <button onClick={() => setWeekStart(mondayOf(new Date()))} disabled={isThisWeek}
                        className="ml-1 px-3 py-1.5 text-sm font-semibold rounded border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-default">
                        Today
                    </button>
                </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
                <div className="grid grid-cols-8 border-b border-slate-100 bg-slate-50/50">
                    <div className="p-4 text-center font-bold text-slate-400 text-xs uppercase tracking-wider border-r border-slate-100">Time</div>
                    {weekDays.map((date, i) => {
                        const isToday = dayKey(date) === todayKey;
                        const holiday = holidays.get(dayKey(date));
                        return (
                            <div key={i} className={`p-3 text-center border-r border-slate-100 last:border-r-0 ${holiday ? 'bg-rose-50' : isToday ? 'bg-blue-50/50' : ''}`}>
                                <div className="font-bold text-slate-700">{date.toLocaleDateString("en-GB", { weekday: 'short' })}</div>
                                <div className={`text-xs mt-1 ${isToday ? 'text-blue-600 font-bold' : 'text-slate-400'}`}>{date.getDate()}</div>
                                {holiday && <div className="text-[10px] leading-tight mt-1 font-semibold text-rose-700" title={holiday}>Bank holiday</div>}
                            </div>
                        );
                    })}
                </div>

                <div className="relative overflow-y-auto" style={{ height: "600px" }}>
                    <div className="relative" style={{ height: `${hourRows.length * ROW_PX}px` }}>
                        {/* Hour lines */}
                        {hourRows.map(hour => (
                            <div key={hour} className="grid grid-cols-8 relative" style={{ height: `${ROW_PX}px` }}>
                                <div className="border-r border-b border-slate-100 text-right pr-3 text-xs text-slate-400 pt-1">
                                    {hour}:00
                                </div>
                                {weekDays.map((d, i) => (
                                    <div key={i} className={`border-r border-b border-slate-100 last:border-r-0 ${holidays.has(dayKey(d)) ? 'bg-rose-50/40' : ''}`}></div>
                                ))}
                            </div>
                        ))}

                        {/* Classes */}
                        {weekDays.map((dayDate, dayIndex) => {
                            const holiday = holidays.get(dayKey(dayDate));
                            const dayEvents = gridCourses.filter(c => meetsOn(c, dayDate));
                            if (dayEvents.length === 0) return null;

                            const eventStyleData = dayEvents
                                .map(event => ({
                                    event,
                                    start: Math.max(FIRST_HOUR, hoursOf(event.schedule?.start) ?? FIRST_HOUR),
                                    end: Math.min(LAST_HOUR, hoursOf(event.schedule?.end) ?? FIRST_HOUR),
                                    colIndex: 0, totalCols: 1,
                                }))
                                .filter(e => e.end > e.start)
                                .sort((a, b) => a.start - b.start);

                            // Side by side when classes overlap
                            eventStyleData.forEach(current => {
                                const overlaps = eventStyleData.filter(o => o.start < current.end && o.end > current.start);
                                if (overlaps.length > 1) {
                                    const maxGroup = Math.max(...overlaps.map(o => eventStyleData.filter(e => e.start < o.end && e.end > o.start).length));
                                    overlaps.forEach(o => { o.totalCols = Math.max(o.totalCols, maxGroup); });
                                    overlaps.sort((a, b) => a.start - b.start).forEach((evt, idx) => { evt.colIndex = idx; });
                                }
                            });

                            return eventStyleData.map(({ event, start, end, colIndex, totalCols }) => {
                                const top = (start - FIRST_HOUR) * ROW_PX;
                                const height = (end - start) * ROW_PX;
                                const dayColumnLeft = 12.5 + (dayIndex * 12.5); // the time column is 12.5%
                                const widthPerEvent = 12.4 / totalCols;
                                const left = dayColumnLeft + (colIndex * widthPerEvent);
                                return (
                                    <div
                                        key={`${event.id}-${dayIndex}`}
                                        onClick={() => setSelectedCourse(event)}
                                        className={`absolute border-l-4 rounded px-1 py-1 text-xs cursor-pointer hover:shadow-md transition-shadow group z-10 overflow-hidden hover:z-20 hover:min-w-[150px] hover:ring-1 ring-slate-200 ${holiday ? 'bg-slate-100 border-slate-400 hover:bg-white' : 'bg-blue-100 border-blue-600 hover:bg-white'}`}
                                        style={{ top: `${top}px`, height: `${height}px`, left: `${left}%`, width: `${widthPerEvent}%`, marginLeft: '1px' }}
                                        title={holiday ? `${event.name}: no class (bank holiday, ${holiday})` : `${event.name} (${event.schedule.start} to ${event.schedule.end})`}
                                    >
                                        <div className={`font-semibold truncate ${holiday ? 'text-slate-500 line-through' : 'text-blue-800'}`}>{event.code}</div>
                                        <div className={`truncate text-[10px] leading-tight ${holiday ? 'text-slate-500 line-through' : 'text-blue-700'}`}>{event.name}</div>
                                        {holiday ? (
                                            <div className="text-rose-700 truncate text-[9px] leading-tight mt-1 font-semibold">No class (bank holiday)</div>
                                        ) : event.volunteers && event.volunteers.length > 0 && (
                                            <div className="text-slate-500 truncate text-[9px] leading-tight mt-1">
                                                {event.volunteers.map(v => String(v.name || "").split(' ')[0]).join(', ')}
                                            </div>
                                        )}
                                    </div>
                                );
                            });
                        })}
                    </div>
                </div>
            </div>

            {/* Courses that are not on a fixed weekly time */}
            <div className="mt-6 bg-white rounded-xl shadow-sm border border-slate-100 p-5">
                <h2 className="font-bold text-slate-800">Custom schedule</h2>
                <p className="text-sm text-slate-500 mb-3">Running courses this week that do not meet at a fixed weekly time, so they are not placed on the grid.</p>
                {loading ? (
                    <p className="text-sm text-slate-400">Loading…</p>
                ) : customCourses.length === 0 ? (
                    <p className="text-sm text-slate-400 italic">None this week.</p>
                ) : (
                    <ul className="divide-y divide-slate-100">
                        {customCourses.map(c => (
                            <li key={c.id} className="py-2 flex items-start justify-between gap-3">
                                <button onClick={() => setSelectedCourse(c)} className="text-left min-w-0">
                                    <span className="font-semibold text-blue-700 hover:underline">{c.code ? `${c.code} ` : ""}{c.name || "Unnamed course"}</span>
                                    <span className="block text-xs text-slate-500">{describeSchedule(c)}{(freqOf(c) === "fortnightly" || freqOf(c) === "monthly") && !parseDay(c.startDate) ? ". Add a start date to place it on the right weeks." : ""}</span>
                                </button>
                                <Link href={`/admin/courses/detail?id=${c.id}`} className="text-xs font-semibold text-blue-600 hover:underline whitespace-nowrap">Open course</Link>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {/* Course details */}
            {selectedCourse && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setSelectedCourse(null)}>
                    <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 animate-in fade-in zoom-in duration-200" onClick={e => e.stopPropagation()}>
                        <div className="flex justify-between items-start mb-4">
                            <div>
                                <h3 className="text-xl font-bold text-slate-800">{selectedCourse.name}</h3>
                                <p className="text-blue-600 font-medium">{selectedCourse.code}</p>
                            </div>
                            <button onClick={() => setSelectedCourse(null)} className="p-1 hover:bg-slate-100 rounded-full text-slate-400 hover:text-slate-600" aria-label="Close">
                                <X size={20} />
                            </button>
                        </div>

                        <div className="space-y-4">
                            <div className="bg-slate-50 p-4 rounded-lg space-y-2">
                                <div className="flex justify-between items-center text-sm">
                                    <span className="text-slate-500">Day</span>
                                    <span className="font-medium">
                                        <span className="text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded text-[10px] mr-2 uppercase tracking-wide font-bold">{selectedCourse.schedule?.frequency || 'Weekly'}</span>
                                        {selectedCourse.schedule?.day || "Not set"}
                                    </span>
                                </div>
                                <div className="flex justify-between items-center text-sm">
                                    <span className="text-slate-500">Time</span>
                                    <span className="font-medium">{selectedCourse.schedule?.start && selectedCourse.schedule?.end ? `${selectedCourse.schedule.start} to ${selectedCourse.schedule.end}` : "Not set"}</span>
                                </div>
                                <div className="flex justify-between items-center text-sm">
                                    <span className="text-slate-500">Dates</span>
                                    <span className="font-medium">{selectedCourse.startDate || "No start date"} <span className="text-slate-400 font-normal mx-1">to</span> {selectedCourse.endDate || "no end date"}</span>
                                </div>
                                {(freqOf(selectedCourse) === "custom" || isOneToOne(selectedCourse)) && (
                                    <div className="text-sm mt-2 pt-2 border-t border-slate-200">
                                        <span className="text-slate-500 block mb-1">Schedule details</span>
                                        <span className="text-slate-700 italic">{describeSchedule(selectedCourse)}</span>
                                    </div>
                                )}
                                <div className="flex justify-between items-center text-sm pt-2 border-t border-slate-200 mt-2">
                                    <span className="text-slate-500">Setting</span>
                                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${selectedCourse.setting === 'Online' || selectedCourse.setting === 'Virtual' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                                        {selectedCourse.setting === 'Virtual' ? 'Online' : selectedCourse.setting || 'Not set'}
                                    </span>
                                </div>
                            </div>

                            {selectedCourse.description && (
                                <div>
                                    <h4 className="text-sm font-semibold text-slate-700 mb-1">Description</h4>
                                    <p className="text-sm text-slate-600 leading-relaxed">{selectedCourse.description}</p>
                                </div>
                            )}

                            {selectedCourse.venue && (
                                <div className="flex items-start gap-2 text-sm text-slate-600">
                                    <span className="font-semibold">Venue:</span>
                                    <span>{selectedCourse.venue}</span>
                                </div>
                            )}

                            {selectedCourse.volunteers && selectedCourse.volunteers.length > 0 && (
                                <div className="mt-4 pt-4 border-t border-slate-100">
                                    <h4 className="text-sm font-semibold text-slate-700 mb-2">Assigned Volunteers</h4>
                                    <div className="flex flex-wrap gap-2">
                                        {selectedCourse.volunteers.map(v => (
                                            <span key={v.id} className="bg-blue-50 text-blue-700 px-2 py-1 rounded-full text-[11px] font-medium border border-blue-100">
                                                {v.name}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="mt-6 flex justify-between items-center">
                            <Link href={`/admin/courses/detail?id=${selectedCourse.id}`} className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition text-sm">
                                Open course <ExternalLink size={14} />
                            </Link>
                            <button onClick={() => setSelectedCourse(null)} className="px-4 py-2 bg-slate-100 text-slate-700 font-medium rounded-lg hover:bg-slate-200 transition">
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </DashboardLayout>
    );
}

// The menu hid this page without the permission, but the page itself had no check (30 Sep 2026).
export default function CalendarPage() {
    return <RequirePermission perm="calendar"><CalendarPageContent /></RequirePermission>;
}
