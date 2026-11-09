"use client";

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { fetchGhanaOverview, GhanaOverviewError, daysSince, type GhanaErrorKind } from '@/lib/ghana/overview';
import {
    CalendarDays,
    Users,
    CheckSquare,
    Loader2,
    Calendar,
    MapPin,
    BarChart3,
    BookOpen,
    AlertTriangle,
    Clock,
    RefreshCw,
    ShieldAlert
} from 'lucide-react';
import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
} from 'recharts';
import { cn } from '@/lib/utils';
import { RequirePermission } from "@/components/auth/RequirePermission";

/*
 * The Ghana app (a different Firebase project) publishes a snapshot into its
 * `portalPublic` collection. It holds children's names, so the browser never reads it:
 * the portal server does, through the `ghanaOverview` callable (functions/ghana.js),
 * and only for people with the Ghana Operations permission. The callable returns the
 * same documents, cleaned, and everything on this screen is computed from them:
 *
 *   portalPublic/summary          { classes, totalStudents, enrolledStudents,
 *                                   teacherCount, updatedAt }
 *   portalPublic/class_<courseId> { code, name, archived, enrolled,
 *                                   roster:[id], teacherIds:[id], names:{id:name},
 *                                   days:{ 'YYYY-MM-DD': {p,l,a,t,v} }, updatedAt }
 *
 * `p`/`l`/`a` are the ids marked present, late and absent, `t` the teachers, and `v`
 * says the register was taken by app v2 - which writes a row per child, so p+l+a is
 * the whole register and the rate is exact.
 *
 * Older registers only ever recorded who turned up, so a rate for one of those days
 * needs a denominator from somewhere. It must NOT come from the current roster: a
 * child admitted in September was never in a January class, and September's
 * promotions overwrote the rosters, so today's Primary 2 is not January's Primary 2.
 *
 * Instead the denominator comes from the registers themselves - each child's
 * ATTENDANCE SPAN in this class, the first and last register they appear on. A child
 * counts toward a day only if that day falls inside their own span. A child admitted
 * in September has a span that starts in September and therefore cannot be counted
 * against January; a child promoted out in September has a span that ends there.
 * Nothing outside the register data is ever used.
 *
 * Such a figure is an estimate and is labelled one: a child who never once appeared
 * in a period is invisible to it, so it reads slightly high. A register taken by v2
 * needs none of this - it names everyone, so its rate is measured, not estimated.
 */

const STALE_AFTER_DAYS = 7;
const GHANA_PROJECT_ID = 'shgh-attendance-redesign';
const PORTAL_SERVICE_ACCOUNT = '000000000000-compute@developer.gserviceaccount.com';

type DayStats = {
    date: string;
    present: string[];   // on time
    late: string[];
    absent: string[];
    teachers: string[];
    exact: boolean;      // the register recorded absences too
};

type Span = { first: string; last: string };

type ClassSnapshot = {
    id: string;
    code: string;
    name: string;
    archived: boolean;
    enrolled: number;
    roster: string[];
    teacherIds: string[];
    names: Record<string, string>;
    days: DayStats[];
    spans: Record<string, Span>;   // per child, from this class's own registers
    updatedAt: string;
};

type ClassStats = {
    id: string;
    code: string;
    name: string;
    enrolled: number;
    registers: number;          // every register on record
    measuredRegisters: number;  // took a full register, absences included
    estimatedRegisters: number; // only recorded who turned up
    childrenSeen: number;       // distinct children across this class's registers
    onTime: number;
    late: number;
    missed: number;             // expected minus attended
    expected: number;
    attended: number;
    rate: number | null;        // null only when there are no registers at all
    estimated: boolean;         // any part of the rate came from a span estimate
};

const asArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/**
 * Every child appearing on any register for this class, with their own span.
 *
 * The span STARTS at their first appearance - never earlier, which is what keeps a
 * child admitted in September from being measured against January.
 *
 * It ENDS at their last appearance, except for a child still on the class roster
 * today: they plainly have not left, so their span runs to the latest register and
 * a stretch of days they missed still counts against them. Without that, a child
 * who stops turning up would simply vanish from the denominator.
 */
const spansOf = (days: DayStats[], roster: string[]): Record<string, Span> => {
    const spans: Record<string, Span> = {};
    let latest = '';
    days.forEach(day => {
        if (day.date > latest) latest = day.date;
        [...day.present, ...day.late, ...day.absent].forEach(id => {
            const cur = spans[id];
            if (!cur) spans[id] = { first: day.date, last: day.date };
            else {
                if (day.date < cur.first) cur.first = day.date;
                if (day.date > cur.last) cur.last = day.date;
            }
        });
    });
    roster.forEach(id => {
        if (spans[id] && latest > spans[id].last) spans[id].last = latest;
    });
    return spans;
};

/**
 * A register taken by v2 names everyone, so its rate is measured. An older one is
 * measured against the children whose attendance span covers that date - never
 * against the current roster. `expected` can never fall below `attended`.
 */
const dayFigures = (day: DayStats, spans: Record<string, Span>) => {
    const attended = day.present.length + day.late.length;
    if (day.exact) {
        const expected = attended + day.absent.length;
        return {
            attended, expected, inSpan: [...day.present, ...day.late, ...day.absent],
            estimated: false,
            pct: expected > 0 ? Math.round((attended / expected) * 100) : 0
        };
    }
    const inSpan = Object.keys(spans).filter(id => spans[id].first <= day.date && day.date <= spans[id].last);
    const expected = Math.max(inSpan.length, attended);
    return {
        attended, expected, inSpan, estimated: true,
        pct: expected > 0 ? Math.round((attended / expected) * 100) : 0
    };
};

const classStatsOf = (c: ClassSnapshot): ClassStats => {
    let onTime = 0, late = 0, expected = 0, attended = 0;
    let measuredRegisters = 0, estimatedRegisters = 0, estimated = false;
    c.days.forEach(day => {
        const f = dayFigures(day, c.spans);
        onTime += day.present.length;
        late += day.late.length;
        attended += f.attended;
        expected += f.expected;
        if (f.estimated) { estimatedRegisters++; estimated = true; } else measuredRegisters++;
    });
    return {
        id: c.id,
        code: c.code,
        name: c.name,
        enrolled: c.enrolled,
        registers: c.days.length,
        measuredRegisters, estimatedRegisters,
        childrenSeen: Object.keys(c.spans).length,
        onTime, late,
        missed: Math.max(0, expected - attended),
        expected, attended,
        rate: expected > 0 ? Math.round((attended / expected) * 100) : null,
        estimated
    };
};

function GhanaAttendancePage() {
    const { user } = useAuth();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [errorKind, setErrorKind] = useState<GhanaErrorKind | null>(null);
    const [snapshots, setSnapshots] = useState<ClassSnapshot[]>([]);
    const [totalStudents, setTotalStudents] = useState<number>(0);
    const [totalTeachers, setTotalTeachers] = useState<number>(0);
    const [updatedAt, setUpdatedAt] = useState<string>('');

    const [selectedCourseId, setSelectedCourseId] = useState<string>('all');
    const [selectedGlobalCourseIds, setSelectedGlobalCourseIds] = useState<Set<string>>(new Set());
    const [viewDate, setViewDate] = useState<string>('');

    const fetchSnapshot = async () => {
        setLoading(true);
        setError(null);
        setErrorKind(null);
        try {
            const overview = await fetchGhanaOverview();
            setTotalStudents(overview.summary.totalStudents);
            setTotalTeachers(overview.summary.teacherCount);
            setUpdatedAt(overview.updatedAt || '');

            if (overview.empty) {
                setSnapshots([]);
                setErrorKind('other');
                setError('The Ghana app has not published any statistics yet. In the app, open Backup & Tools and press "Rebuild the portal statistics".');
                return;
            }

            const classes: ClassSnapshot[] = overview.classes.map(c => {
                const rawDays = c.days || {};
                const days: DayStats[] = Object.keys(rawDays).map(date => ({
                    date,
                    present: asArray(rawDays[date]?.p),
                    late: asArray(rawDays[date]?.l),
                    absent: asArray(rawDays[date]?.a),
                    teachers: asArray(rawDays[date]?.t),
                    exact: rawDays[date]?.v === true
                })).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
                const roster = asArray(c.roster);
                return {
                    id: String(c.id),
                    code: String(c.code || ''),
                    name: String(c.name || 'Unnamed class'),
                    archived: false,
                    enrolled: Number(c.enrolled) || 0,
                    roster,
                    teacherIds: asArray(c.teacherIds),
                    names: c.names || {},
                    days,
                    spans: spansOf(days, roster),
                    updatedAt: c.updatedAt || ''
                };
            });

            classes.sort((a, b) =>
                a.code.localeCompare(b.code) || a.name.localeCompare(b.name));

            setSnapshots(classes);
            setSelectedGlobalCourseIds(new Set(classes.map(c => c.id)));
        } catch (e) {
            console.error('Error loading the Ghana statistics:', e);
            const kind: GhanaErrorKind = e instanceof GhanaOverviewError ? e.kind : 'other';
            const message = e instanceof Error ? e.message : String(e);
            setSnapshots([]);
            setErrorKind(kind);
            setError(kind === 'other' ? `Could not load the Ghana statistics. ${message}` : message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (user) fetchSnapshot();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user]);

    const allStats = useMemo(() => snapshots.map(classStatsOf), [snapshots]);

    const selected = snapshots.find(c => c.id === selectedCourseId) || null;
    const selectedStats = selected ? classStatsOf(selected) : null;

    useEffect(() => {
        setViewDate(selected && selected.days.length > 0 ? selected.days[0].date : '');
    }, [selectedCourseId, snapshots.length]);

    /*
     * The headline is the AVERAGE OF CLASS RATES: each class's own rate first, then the
     * plain average across the chosen classes, so a large class does not drown out a
     * small one. A class with no registers has no rate and is left out. The bars are
     * built the same way (each class's on time, late and missed shares, then averaged),
     * so they agree with the headline. The pooled totals are kept for the small print.
     */
    const globalChart = useMemo(() => {
        let expected = 0, attended = 0;
        let measuredRegisters = 0, estimatedRegisters = 0, estimated = false;
        let onTimeShare = 0, lateShare = 0, missedShare = 0, anyLate = false;
        const rates: number[] = [];
        allStats.forEach(c => {
            if (!selectedGlobalCourseIds.has(c.id)) return;
            measuredRegisters += c.measuredRegisters;
            estimatedRegisters += c.estimatedRegisters;
            if (c.rate === null || c.expected === 0) return;
            expected += c.expected;
            attended += c.attended;
            rates.push(c.rate);
            onTimeShare += c.onTime / c.expected;
            lateShare += c.late / c.expected;
            missedShare += c.missed / c.expected;
            if (c.late > 0) anyLate = true;
            if (c.estimated) estimated = true;
        });
        const classesRated = rates.length;
        if (classesRated === 0) {
            return {
                bars: [] as { name: string; value: number }[], rate: null as number | null, classesRated,
                expected, attended, measuredRegisters, estimatedRegisters, estimated
            };
        }
        const avg = (share: number) => Math.round((share / classesRated) * 100);
        const bars = [{ name: 'On time', value: avg(onTimeShare) }];
        if (anyLate) bars.push({ name: 'Late', value: avg(lateShare) });
        bars.push({ name: estimated && measuredRegisters === 0 ? 'Not in' : 'Absent', value: avg(missedShare) });
        return {
            bars,
            rate: Math.round(rates.reduce((a, b) => a + b, 0) / classesRated),
            classesRated, expected, attended, measuredRegisters, estimatedRegisters, estimated
        };
    }, [allStats, selectedGlobalCourseIds]);

    // The top cards follow the class filter too. Children and teachers are counted once
    // each, however many of the chosen classes they belong to.
    const filterCards = useMemo(() => {
        const chosen = snapshots.filter(c => selectedGlobalCourseIds.has(c.id));
        const children = new Set<string>();
        const teachers = new Set<string>();
        let enrolledSum = 0, rosterKnown = false;
        chosen.forEach(c => {
            enrolledSum += c.enrolled;
            if (c.roster.length > 0) rosterKnown = true;
            c.roster.forEach(id => children.add(id));
            c.teacherIds.forEach(id => teachers.add(id));
        });
        return {
            classes: chosen.length,
            allChosen: snapshots.length > 0 && chosen.length === snapshots.length,
            children: rosterKnown ? children.size : enrolledSum,
            teachers: teachers.size
        };
    }, [snapshots, selectedGlobalCourseIds]);

    const publishedDaysAgo = daysSince(updatedAt);
    const stale = publishedDaysAgo !== null && publishedDaysAgo > STALE_AFTER_DAYS;

    if (loading) return (
        <div className="p-8 flex justify-center items-center min-h-[50vh]">
            <Loader2 className="animate-spin h-8 w-8 text-[#2c4a00]" />
        </div>
    );

    const currentDay = selected?.days.find(d => d.date === viewDate) || null;
    const nameOf = (id: string) => selected?.names?.[id] || 'Former pupil';

    return (
        <div className="p-6 max-w-7xl mx-auto space-y-6">
            <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white p-6 rounded-2xl shadow-sm border border-slate-100 relative overflow-hidden">
                <div className="absolute top-0 right-0 w-64 h-64 bg-green-50 rounded-full blur-3xl -mr-20 -mt-20 opacity-60"></div>
                <div className="relative z-10">
                    <h1 className="text-3xl font-extrabold text-slate-900 flex items-center gap-3">
                        <MapPin className="text-[#2c4a00] h-8 w-8" />
                        Ghana Operations
                    </h1>
                    <p className="text-slate-500 mt-1 font-medium">Attendance from the Ghana app, read for you by the portal.</p>
                </div>

                <div className="relative z-10 w-full md:w-72">
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">View Mode</label>
                    <select
                        className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl font-medium text-slate-700 shadow-sm focus:ring-2 focus:ring-[#2c4a00]/20 focus:border-[#2c4a00]/50 transition-all outline-none"
                        value={selectedCourseId}
                        onChange={(e) => setSelectedCourseId(e.target.value)}
                    >
                        <option value="all">🌐 Global Overview</option>
                        <optgroup label="Classes">
                            {snapshots.map(c => (
                                <option key={c.id} value={c.id}>
                                    {c.code ? `${c.code}: ` : ''}{c.name}
                                </option>
                            ))}
                        </optgroup>
                    </select>
                </div>
            </header>

            {!error && updatedAt && publishedDaysAgo !== null && (
                <div
                    className={cn(
                        "rounded-2xl px-5 py-3 flex flex-wrap items-center justify-between gap-3 border text-sm",
                        stale ? "bg-amber-50 border-amber-200 text-amber-900" : "bg-green-50/60 border-green-100 text-green-900"
                    )}
                    title={`Published on ${new Date(updatedAt).toLocaleString('en-GB')}`}
                >
                    <div className="flex items-start gap-3">
                        {stale
                            ? <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 mt-0.5" />
                            : <Clock className="h-5 w-5 shrink-0 text-green-700 mt-0.5" />}
                        <div>
                            <p className="font-bold">
                                {publishedDaysAgo === 0
                                    ? 'Figures published today'
                                    : `Figures published ${publishedDaysAgo} ${publishedDaysAgo === 1 ? 'day' : 'days'} ago`}
                            </p>
                            {stale && (
                                <p className="text-xs mt-0.5">
                                    These figures may be out of date. In the Ghana app, open Backup &amp; Tools and press &ldquo;Rebuild the portal statistics&rdquo;, then press Reload here.
                                </p>
                            )}
                        </div>
                    </div>
                    <button
                        onClick={fetchSnapshot}
                        className={cn(
                            "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border bg-white",
                            stale ? "border-amber-300 text-amber-800 hover:bg-amber-100" : "border-green-200 text-[#2c4a00] hover:bg-green-100"
                        )}
                    >
                        <RefreshCw size={12} /> Reload
                    </button>
                </div>
            )}

            {error && errorKind === 'not_granted' && (
                <div className="bg-amber-50 border border-amber-300 rounded-2xl p-6 flex gap-4 items-start">
                    <ShieldAlert className="text-amber-600 h-6 w-6 shrink-0 mt-0.5" />
                    <div className="space-y-4 text-sm text-amber-950">
                        <div>
                            <h3 className="font-bold text-base text-amber-900">The portal is not yet allowed to read the Ghana data</h3>
                            <p className="mt-1">This needs doing once. Until it is done, nobody can see the Ghana figures here.</p>
                        </div>

                        <div>
                            <p className="font-bold mb-1">Step 1: give the portal read access</p>
                            <ol className="list-decimal ml-5 space-y-1">
                                <li>Open the Google Cloud console for the project <code className="font-mono bg-white/70 px-1 rounded">{GHANA_PROJECT_ID}</code>.</li>
                                <li>Go to <strong>IAM and admin</strong>, then <strong>IAM</strong>.</li>
                                <li>Press <strong>Grant access</strong>.</li>
                                <li>
                                    Under <strong>New principal</strong>, paste:
                                    <code className="block mt-1 font-mono text-xs bg-white border border-amber-200 px-2 py-1.5 rounded select-all break-all">{PORTAL_SERVICE_ACCOUNT}</code>
                                </li>
                                <li>Choose the role <strong>Cloud Datastore Viewer</strong>.</li>
                                <li>Press <strong>Save</strong>.</li>
                                <li>Wait a minute, then press <strong>Reload</strong> below.</li>
                            </ol>
                        </div>

                        <div>
                            <p className="font-bold mb-1">Step 2: afterwards, switch off public access</p>
                            <p className="mb-1">Only once the figures show here:</p>
                            <ol className="list-decimal ml-5 space-y-1">
                                <li>Open the Firebase console for the Ghana project <code className="font-mono bg-white/70 px-1 rounded">{GHANA_PROJECT_ID}</code>.</li>
                                <li>Go to <strong>Authentication</strong>, then <strong>Sign-in method</strong>.</li>
                                <li>Open <strong>Anonymous</strong> and press <strong>Disable</strong>.</li>
                            </ol>
                        </div>

                        <button
                            onClick={fetchSnapshot}
                            className="inline-flex items-center gap-2 px-3 py-2 bg-amber-600 text-white text-sm font-bold rounded-lg hover:bg-amber-700"
                        >
                            <RefreshCw size={14} /> Reload
                        </button>
                    </div>
                </div>
            )}

            {error && errorKind !== 'not_granted' && (
                <div className="bg-red-50 border border-red-200 rounded-2xl p-5 flex gap-4 items-start">
                    <AlertTriangle className="text-red-500 h-6 w-6 shrink-0 mt-0.5" />
                    <div>
                        <h3 className="font-bold text-red-900">The Ghana statistics could not be loaded</h3>
                        <p className="text-sm text-red-800 mt-1">{error}</p>
                        <button
                            onClick={fetchSnapshot}
                            className="mt-3 inline-flex items-center gap-2 px-3 py-2 bg-red-600 text-white text-sm font-bold rounded-lg hover:bg-red-700"
                        >
                            <RefreshCw size={14} /> Try again
                        </button>
                    </div>
                </div>
            )}

            {!error && selectedCourseId === 'all' && (
                /* GLOBAL VIEW */
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <div className="bg-gradient-to-br from-[#2c4a00] to-[rgba(44,74,0,0.85)] p-6 rounded-2xl shadow-lg border border-[#2c4a00] text-white overflow-hidden relative">
                            <BookOpen className="absolute -bottom-6 -right-6 h-32 w-32 text-white/10" />
                            <h3 className="text-sm font-semibold text-white/80 uppercase tracking-wider mb-1">Active Classes</h3>
                            <p className="text-5xl font-black">{filterCards.classes}</p>
                            {!filterCards.allChosen && (
                                <p className="text-xs font-semibold text-white/70 mt-1">of {snapshots.length} chosen</p>
                            )}
                        </div>
                        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex flex-col justify-center">
                            <div className="flex items-center gap-4">
                                <div className="p-4 bg-blue-50 text-blue-600 rounded-xl"><Users size={28} /></div>
                                <div>
                                    <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-1">Children</h3>
                                    <div className="flex items-baseline gap-2">
                                        <p className="text-3xl font-bold text-slate-900">{filterCards.children}</p>
                                        <p className="text-sm font-semibold text-slate-500">{filterCards.allChosen ? 'in a class' : 'in the chosen classes'}</p>
                                    </div>
                                    {filterCards.allChosen && (
                                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">On the roll: <span className="text-slate-500">{totalStudents}</span></p>
                                    )}
                                </div>
                            </div>
                        </div>
                        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex flex-col justify-center">
                            <div className="flex items-center gap-4">
                                <div className="p-4 bg-orange-50 text-orange-600 rounded-xl"><CheckSquare size={28} /></div>
                                <div>
                                    <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-1">Teachers</h3>
                                    <div className="flex items-baseline gap-2">
                                        <p className="text-3xl font-bold text-slate-900">{filterCards.teachers}</p>
                                        <p className="text-sm font-semibold text-slate-500">{filterCards.allChosen ? 'assigned to a class' : 'in the chosen classes'}</p>
                                    </div>
                                    {filterCards.allChosen && (
                                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">On the staff list: <span className="text-slate-500">{totalTeachers}</span></p>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
                        <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
                            <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
                                <BarChart3 className="text-slate-400" />
                                Attendance Overview
                            </h2>
                            {globalChart.rate !== null && (
                                <div className="text-right">
                                    <div className="flex items-baseline gap-2 justify-end">
                                        <p className="text-4xl font-black text-[#2c4a00] leading-none">{globalChart.estimated ? '~' : ''}{globalChart.rate}%</p>
                                        {globalChart.estimated && (
                                            <span className="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full uppercase tracking-wider">
                                                estimate
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-xs font-bold text-slate-600 mt-1">Average of class rates</p>
                                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">
                                        {globalChart.classesRated} {globalChart.classesRated === 1 ? 'class' : 'classes'} · {globalChart.attended.toLocaleString('en-GB')} of {globalChart.expected.toLocaleString('en-GB')} places on {(globalChart.measuredRegisters + globalChart.estimatedRegisters).toLocaleString('en-GB')} registers
                                    </p>
                                </div>
                            )}
                        </div>

                        {globalChart.estimatedRegisters > 0 && (
                            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-5">
                                <strong>{globalChart.estimatedRegisters.toLocaleString()}</strong> of these {(globalChart.measuredRegisters + globalChart.estimatedRegisters).toLocaleString()} registers were taken before the app recorded absences, so they list only who turned up. For those days each child is counted only across the period they actually appear in that class, never against today&apos;s class list, so nobody is measured against a class they had not joined. A child who never appeared at all in a period is invisible to that calculation, so <strong>this figure reads slightly high</strong>. Registers taken from now on record absences and need no estimate.
                            </p>
                        )}

                        <div className="flex flex-col md:flex-row gap-8">
                            {/* Chart Area */}
                            <div className="w-full md:w-3/4 h-[350px]">
                                {globalChart.bars.length === 0 ? (
                                    <div className="h-full flex flex-col items-center justify-center text-center gap-2 px-8 text-slate-400 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                                        <BarChart3 className="h-10 w-10 opacity-20" />
                                        <p className="font-medium text-slate-500">No registers for the selected classes</p>
                                        <p className="text-xs max-w-sm">Pick a class on the right, or wait for the first register to be taken.</p>
                                    </div>
                                ) : (
                                    <ResponsiveContainer width="100%" height="100%">
                                        <BarChart data={globalChart.bars} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                                            <XAxis dataKey="name" stroke="#6b7280" fontSize={12} tickLine={false} axisLine={false} />
                                            <YAxis stroke="#6b7280" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(value) => `${value}%`} domain={[0, 100]} />
                                            <Tooltip
                                                cursor={{ fill: '#f3f4f6' }}
                                                contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                                                formatter={(value: number | undefined) => [`${value || 0}%`, 'Percentage']}
                                            />
                                            <Bar dataKey="value" fill="#2c4a00" radius={[4, 4, 0, 0]} name="Percentage" barSize={80} stroke="none" />
                                        </BarChart>
                                    </ResponsiveContainer>
                                )}
                            </div>

                            {/* Filters Area */}
                            <div className="w-full md:w-1/4 max-h-[350px] flex flex-col bg-slate-50/50 p-4 rounded-xl border border-slate-100">
                                <div className="flex items-center justify-between mb-3 border-b border-slate-200 pb-3">
                                    <h4 className="font-bold text-sm text-slate-800 uppercase tracking-widest">Filter Classes</h4>
                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => setSelectedGlobalCourseIds(new Set(allStats.map(c => c.id)))}
                                            className="text-[10px] px-2.5 py-1 bg-white hover:bg-slate-100 border border-slate-200 shadow-sm rounded text-slate-700 font-bold transition-colors uppercase"
                                        >
                                            All
                                        </button>
                                        <button
                                            onClick={() => setSelectedGlobalCourseIds(new Set())}
                                            className="text-[10px] px-2.5 py-1 bg-white hover:bg-slate-100 border border-slate-200 shadow-sm rounded text-slate-700 font-bold transition-colors uppercase"
                                        >
                                            None
                                        </button>
                                    </div>
                                </div>
                                <div className="overflow-y-auto pr-2 space-y-2 flex-grow custom-scrollbar">
                                    {allStats.map(course => (
                                        <label key={course.id} className="flex items-start space-x-3 cursor-pointer group hover:bg-white p-2 rounded-lg transition-all border border-transparent hover:border-slate-200 hover:shadow-sm">
                                            <input
                                                type="checkbox"
                                                checked={selectedGlobalCourseIds.has(course.id)}
                                                onChange={(e) => {
                                                    const newSet = new Set(selectedGlobalCourseIds);
                                                    if (e.target.checked) newSet.add(course.id);
                                                    else newSet.delete(course.id);
                                                    setSelectedGlobalCourseIds(newSet);
                                                }}
                                                className="rounded border-gray-300 text-[#2c4a00] focus:ring-[#2c4a00] h-4 w-4 mt-0.5 shrink-0"
                                            />
                                            <div className="flex-1">
                                                <span className="text-sm font-bold text-slate-700 group-hover:text-slate-900 leading-tight block">{course.name}</span>
                                                <span className="text-xs text-slate-400 font-medium">
                                                    {course.enrolled} children • {course.registers} {course.registers === 1 ? 'register' : 'registers'}
                                                    {course.rate !== null ? ` • ${course.estimated ? '~' : ''}${course.rate}%` : ''}
                                                </span>
                                            </div>
                                        </label>
                                    ))}
                                    {allStats.length === 0 && (
                                        <p className="text-xs text-slate-400 italic text-center py-4">No classes found.</p>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {!error && selectedCourseId !== 'all' && selected && selectedStats && (
                /* CLASS VIEW */
                <div className="animate-in fade-in slide-in-from-right-4 duration-500">
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

                        {/* Left Col - Roster & Stats */}
                        <div className="lg:col-span-1 space-y-6">
                            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
                                <h3 className="text-xl font-bold text-slate-900 mb-1">{selected.name}</h3>
                                {selected.code && <span className="inline-block px-2.5 py-1 bg-slate-100 text-slate-600 rounded text-xs font-bold font-mono tracking-widest mb-4">{selected.code}</span>}

                                <div className="flex gap-4 mt-2">
                                    <div className="flex-1 p-3 bg-blue-50/50 rounded-xl border border-blue-100/50">
                                        <p className="text-xs text-blue-600 font-semibold mb-1">Enrolled</p>
                                        <p className="text-xl font-black text-blue-900">{selected.enrolled}</p>
                                    </div>
                                    <div className="flex-1 p-3 bg-purple-50/50 rounded-xl border border-purple-100/50">
                                        <p className="text-xs text-purple-600 font-semibold mb-1">Teachers</p>
                                        <p className="text-xl font-black text-purple-900">{selected.teacherIds.length}</p>
                                    </div>
                                    <div className="flex-1 p-3 bg-green-50/50 rounded-xl border border-green-100/50">
                                        <p className="text-xs text-green-600 font-semibold mb-1">Attendance</p>
                                        <p className="text-xl font-black text-green-900">
                                            {selectedStats.rate !== null ? `${selectedStats.estimated ? '~' : ''}${selectedStats.rate}%` : 'None'}
                                        </p>
                                    </div>
                                </div>

                                {selectedStats.registers > 0 && (
                                    <div className="text-xs text-slate-500 mt-4 leading-relaxed space-y-1">
                                        <p>
                                            {selectedStats.registers} {selectedStats.registers === 1 ? 'register' : 'registers'} •{' '}
                                            {selectedStats.attended} of {selectedStats.expected} places filled
                                            {selectedStats.late > 0 ? `, ${selectedStats.late} late` : ''}
                                        </p>
                                        {selectedStats.estimatedRegisters > 0 && (
                                            <p className="text-amber-700">
                                                {selectedStats.estimatedRegisters} of those {selectedStats.estimatedRegisters === 1 ? 'register was' : 'registers were'} taken before absences were recorded, measured against the{' '}
                                                {selectedStats.childrenSeen} {selectedStats.childrenSeen === 1 ? 'child' : 'children'} who actually appear on them
                                                {selectedStats.childrenSeen < selectedStats.enrolled && (
                                                    <>, fewer than the {selectedStats.enrolled} in the class today, so those registers were not covering everyone</>
                                                )}.
                                            </p>
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* History Timeline */}
                            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 h-[600px] overflow-y-auto">
                                <h3 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-6">Attendance History</h3>

                                {selected.days.length === 0 ? (
                                    <div className="text-center py-10 text-slate-400">
                                        <Calendar className="h-10 w-10 mx-auto mb-3 opacity-20" />
                                        <p className="text-sm">No registers taken yet.</p>
                                    </div>
                                ) : (
                                    <div className="space-y-3">
                                        {selected.days.map((day) => {
                                            const r = dayFigures(day, selected.spans);
                                            return (
                                                <button
                                                    key={day.date}
                                                    onClick={() => setViewDate(day.date)}
                                                    className={cn(
                                                        "w-full text-left p-4 rounded-xl border transition-all duration-200 group flex justify-between items-center",
                                                        viewDate === day.date
                                                            ? "bg-[#2c4a00] border-[#2c4a00] text-white shadow-md"
                                                            : "bg-white border-slate-200 hover:border-[#2c4a00]/30 hover:bg-[#2c4a00]/5"
                                                    )}
                                                >
                                                    <div>
                                                        <h4 className="font-bold">{new Date(day.date).toLocaleDateString('en-GB', { month: 'short', day: 'numeric', year: 'numeric' })}</h4>
                                                        <p className={cn("text-xs mt-1", viewDate === day.date ? "text-green-100" : "text-slate-500")}>
                                                            {r.attended}/{r.expected} children
                                                            {day.late.length > 0 ? ` • ${day.late.length} late` : ''}
                                                            {day.teachers.length > 0 ? ` • ${day.teachers.length} ${day.teachers.length === 1 ? 'teacher' : 'teachers'}` : ''}
                                                        </p>
                                                    </div>
                                                    <div
                                                        className={cn(
                                                            "h-8 w-14 rounded-full flex items-center justify-center font-bold text-xs shrink-0",
                                                            viewDate === day.date
                                                                ? "bg-white/20 text-white"
                                                                : r.pct >= 80 ? "bg-green-100 text-green-800"
                                                                    : r.pct >= 50 ? "bg-amber-100 text-amber-800"
                                                                        : "bg-red-100 text-red-700"
                                                        )}
                                                        title={r.estimated
                                                            ? 'Estimated: this register recorded only who turned up, so it is measured against the children appearing in this class at the time'
                                                            : 'Measured: this register recorded absences too'}
                                                    >
                                                        {r.estimated ? '~' : ''}{r.pct}%
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Right Col - Detailed Look */}
                        <div className="lg:col-span-2">
                            <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-100 min-h-[700px]">
                                {!currentDay ? (
                                    <div className="h-full flex flex-col items-center justify-center text-slate-400">
                                        <CalendarDays className="h-16 w-16 mb-4 opacity-20" />
                                        <h3 className="text-xl font-medium text-slate-600">Select a date</h3>
                                        <p className="text-sm mt-2 max-w-sm text-center">Choose a date from the history timeline on the left to view detailed attendance for that session.</p>
                                    </div>
                                ) : (() => {
                                    const day = currentDay;
                                    const r = dayFigures(day, selected.spans);

                                    // The current roster is deliberately NOT mixed in. For a v2
                                    // register the list is the register itself; for an older one it
                                    // is the children whose attendance span covers this date, so a
                                    // child admitted later never appears against an earlier class.
                                    const childIds = Array.from(new Set([
                                        ...day.present, ...day.late, ...day.absent, ...r.inSpan
                                    ])).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));

                                    // Teacher rows are written only when someone is ticked in, so an
                                    // assigned teacher with no row was not marked - which is not the
                                    // same as being away. Only a register that recorded absences is
                                    // complete enough to list the ones who were not marked.
                                    const teacherIds = Array.from(new Set([
                                        ...day.teachers, ...(day.exact ? selected.teacherIds : [])
                                    ])).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));

                                    const chip = (id: string) => {
                                        const [label, cls] =
                                            day.late.includes(id) ? ['Late', 'bg-amber-100 text-amber-800']
                                                : day.present.includes(id) ? ['Present', 'bg-green-100 text-green-800']
                                                    // an older register did not record absences, so the
                                                    // most it can say is that this child was not marked in
                                                    : day.exact ? ['Absent', 'bg-red-100 text-red-700']
                                                        : ['Not marked in', 'bg-red-50 text-red-600'];
                                        return <span className={cn("text-xs font-bold px-2.5 py-1 rounded-full shrink-0", cls)}>{label}</span>;
                                    };

                                    return (
                                        <div className="animate-in fade-in duration-300">
                                            <div className="flex justify-between items-end border-b border-slate-100 pb-6 mb-6 gap-4">
                                                <div>
                                                    <h2 className="text-2xl font-black text-slate-900 mb-1">
                                                        {new Date(day.date).toLocaleDateString('en-GB', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                                                    </h2>
                                                    <div className="flex flex-wrap gap-2">
                                                        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-green-50 text-green-700 text-sm font-semibold">
                                                            <CheckSquare size={14} /> {day.present.length} on time
                                                        </span>
                                                        {day.late.length > 0 && (
                                                            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-50 text-amber-700 text-sm font-semibold">
                                                                <Clock size={14} /> {day.late.length} late
                                                            </span>
                                                        )}
                                                        {day.absent.length > 0 && (
                                                            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-red-50 text-red-700 text-sm font-semibold">
                                                                {day.absent.length} absent
                                                            </span>
                                                        )}
                                                        {!day.exact && (
                                                            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-50 text-amber-800 border border-amber-200 text-sm font-semibold">
                                                                estimate: this register recorded only who turned up
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                                <div className="text-right shrink-0">
                                                    <p className="text-4xl font-black text-[#2c4a00]">{r.estimated ? '~' : ''}{r.pct}%</p>
                                                    <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">{r.attended} of {r.expected}</p>
                                                </div>
                                            </div>

                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                                                {/* Children */}
                                                <div>
                                                    <h3 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-4 flex justify-between">
                                                        Children <span className="text-slate-600">{r.attended}/{r.expected}</span>
                                                    </h3>
                                                    <div className="space-y-2">
                                                        {childIds.map(id => (
                                                            <div key={id} className="flex justify-between items-center gap-3 p-3 rounded-lg border border-slate-50 bg-slate-50/50">
                                                                <span className="font-medium text-slate-800">{nameOf(id)}</span>
                                                                {chip(id)}
                                                            </div>
                                                        ))}
                                                        {childIds.length === 0 && <p className="text-slate-500 text-sm italic py-4">Nobody was on this register.</p>}
                                                        {!day.exact && childIds.length > 0 && (
                                                            <p className="text-xs text-slate-400 pt-2">
                                                                This register recorded only who turned up. The children listed are those attending this class around this date. A child who joined later is not shown, and &ldquo;not marked in&rdquo; means the register has no row for them, which is not the same as a recorded absence.
                                                            </p>
                                                        )}
                                                    </div>
                                                </div>

                                                {/* Teachers */}
                                                <div>
                                                    <h3 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-4 flex justify-between">
                                                        Teachers <span className="text-slate-600">{day.teachers.length}/{teacherIds.length}</span>
                                                    </h3>
                                                    <div className="space-y-2">
                                                        {teacherIds.map(id => (
                                                            <div key={id} className="flex justify-between items-center gap-3 p-3 rounded-lg border border-slate-50 bg-slate-50/50">
                                                                <span className="font-medium text-slate-800">{nameOf(id)}</span>
                                                                <span className={cn(
                                                                    "text-xs font-bold px-2.5 py-1 rounded-full shrink-0",
                                                                    day.teachers.includes(id) ? "bg-green-100 text-green-800" : "bg-slate-200 text-slate-500"
                                                                )}>
                                                                    {day.teachers.includes(id) ? 'Present' : 'Not marked'}
                                                                </span>
                                                            </div>
                                                        ))}
                                                        {teacherIds.length === 0 && <p className="text-slate-500 text-sm italic py-4">No teacher was marked in on this register.</p>}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })()}
                            </div>
                        </div>

                    </div>
                </div>
            )}
        </div>
    );
}

export default function GuardedGhanaAttendancePage() {
    return (
        <RequirePermission perm="ghana_ops">
            <GhanaAttendancePage />
        </RequirePermission>
    );
}
