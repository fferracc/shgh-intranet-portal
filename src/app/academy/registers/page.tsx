"use client";

// Historic Registers (30 Sep 2026, Franco). Every course's register in one place, with an
// Excel download of one course or many (one workbook). Figures come from src/lib/registers.ts,
// which uses the same fair attendance method as the rest of the portal.
// The page sits under /academy, whose layout already wraps it in DashboardLayout.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Download, Loader2, Search, AlertCircle, ExternalLink } from "lucide-react";
import { RequirePermission } from "@/components/auth/RequirePermission";
import { useAuth } from "@/contexts/AuthContext";
import { can } from "@/lib/permissions";
import { loadStatsData } from "@/lib/statsLoader";
import type { StatsPart } from "@/lib/statsLoader";
import { isFinished, isRunning, normStatus, normType } from "@/lib/stats";
import type { SAssignment, SAttendance, SCourse, SRoster, StatsData } from "@/lib/stats";
import { buildRegisterGrid, londonToday, ukDate } from "@/lib/registers";
import type { RegisterGrid } from "@/lib/registers";
import { downloadRegistersExcel } from "@/lib/registerExcel";

type Filter = "finished" | "running" | "all";
const FILTERS: { key: Filter; label: string }[] = [
    { key: "finished", label: "Finished" },
    { key: "running", label: "Running" },
    { key: "all", label: "All" },
];

const PARTS: StatsPart[] = ["courses", "students", "users", "roster", "assignments", "attendance"];

function groupBy<T extends { courseId?: string }>(rows: T[] | undefined): Map<string, T[]> {
    const m = new Map<string, T[]>();
    (rows || []).forEach(r => { if (r.courseId) (m.get(r.courseId) || m.set(r.courseId, []).get(r.courseId)!).push(r); });
    return m;
}

function HistoricRegistersContent() {
    const { user } = useAuth();
    const [loading, setLoading] = useState(true);
    const [data, setData] = useState<StatsData | null>(null);
    const [failed, setFailed] = useState<StatsPart[]>([]);
    const [error, setError] = useState("");
    const [filter, setFilter] = useState<Filter>("finished");
    const [search, setSearch] = useState("");
    const [selected, setSelected] = useState<Set<string>>(new Set());

    useEffect(() => {
        (async () => {
            try {
                const res = await loadStatsData(PARTS);
                setData(res.data);
                setFailed(res.failed);
            } catch (e) {
                console.error("Could not load registers", e);
                setError("Could not load the registers. Please try again.");
            } finally {
                setLoading(false);
            }
        })();
    }, []);

    // One grid per course, worked out once.
    const rows = useMemo(() => {
        if (!data) return [] as { course: SCourse; grid: RegisterGrid }[];
        const att = groupBy<SAttendance>(data.attendance);
        const ros = groupBy<SRoster>(data.roster);
        const asg = groupBy<SAssignment>(data.assignments);
        return [...data.courses]
            .sort((a, b) => String(a.code || "").localeCompare(String(b.code || "")) || String(a.name || "").localeCompare(String(b.name || "")))
            .map(course => ({
                course,
                grid: buildRegisterGrid(course, ros.get(course.id) || [], data.students || [], att.get(course.id) || [], data.users || [], asg.get(course.id) || []),
            }));
    }, [data]);

    const term = search.trim().toLowerCase();
    const matching = rows.filter(({ course }) => !term || [course.code, course.name, course.venue].some(v => String(v || "").toLowerCase().includes(term)));
    const inFilter = (c: SCourse, f: Filter) => f === "all" ? true : f === "finished" ? isFinished(c) : isRunning(c);
    const shown = matching.filter(r => inFilter(r.course, filter));
    const allShownSelected = shown.length > 0 && shown.every(r => selected.has(r.course.id));

    const toggle = (id: string) => setSelected(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });
    const toggleAllShown = () => setSelected(prev => {
        const next = new Set(prev);
        if (allShownSelected) shown.forEach(r => next.delete(r.course.id));
        else shown.forEach(r => next.add(r.course.id));
        return next;
    });

    const download = (list: { course: SCourse; grid: RegisterGrid }[], name: string) => {
        if (list.length === 0) return;
        try {
            downloadRegistersExcel(list, name);
        } catch (e) {
            console.error("Excel download failed", e);
            alert("The Excel file could not be made.");
        }
    };
    const downloadSelected = () => {
        const list = rows.filter(r => selected.has(r.course.id));
        download(list, list.length === 1 ? `Register ${list[0].course.code || list[0].course.name || ""} ${londonToday()}` : `Registers ${list.length} courses ${londonToday()}`);
    };

    const mayOpenCourse = can(user, "courses");

    if (loading) return <div className="p-8 flex justify-center text-slate-400"><Loader2 className="animate-spin mr-2" /> Loading registers...</div>;

    return (
        <div className="p-6 max-w-7xl mx-auto">
            <div className="flex flex-wrap justify-between items-start gap-4 mb-6">
                <div>
                    <h1 className="text-3xl font-bold text-slate-900">Historic Registers</h1>
                    <p className="text-slate-500 mt-1">Registers of every course, finished or running. Download one course or many in one Excel file.</p>
                </div>
                <button
                    onClick={downloadSelected}
                    disabled={selected.size === 0}
                    className="bg-[#2c4a00] hover:bg-[#1e3300] text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    <Download size={16} /> Download Excel{selected.size > 0 ? ` (${selected.size})` : ""}
                </button>
            </div>

            {(error || failed.length > 0) && (
                <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
                    <AlertCircle size={16} />
                    {error || `Could not load: ${failed.join(", ")}. The figures below may be incomplete.`}
                </div>
            )}

            {data && !failed.includes("courses") && (
                <>
                    <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 mb-6 flex flex-col md:flex-row md:items-center gap-4">
                        <div className="relative flex-1 max-w-md">
                            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                            <input
                                type="search"
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                placeholder="Search by code, name or venue"
                                className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg bg-slate-50 text-sm"
                            />
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {FILTERS.map(f => (
                                <button
                                    key={f.key}
                                    onClick={() => setFilter(f.key)}
                                    className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${filter === f.key ? "bg-[#2c4a00] text-white border-[#2c4a00]" : "bg-white text-slate-600 border-slate-300 hover:bg-slate-50"}`}
                                >
                                    {f.label} <span className={filter === f.key ? "text-green-100" : "text-slate-400"}>({matching.filter(r => inFilter(r.course, f.key)).length})</span>
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm text-left">
                                <thead className="bg-slate-100 text-slate-600 uppercase text-xs">
                                    <tr>
                                        <th className="px-4 py-3 border-b border-slate-200">
                                            <label className="flex items-center gap-2 cursor-pointer normal-case font-medium">
                                                <input type="checkbox" checked={allShownSelected} onChange={toggleAllShown} disabled={shown.length === 0} className="h-4 w-4" />
                                                Select all shown
                                            </label>
                                        </th>
                                        <th className="px-4 py-3 border-b border-slate-200">Code</th>
                                        <th className="px-4 py-3 border-b border-slate-200">Name</th>
                                        <th className="px-4 py-3 border-b border-slate-200">Type</th>
                                        <th className="px-4 py-3 border-b border-slate-200">Status</th>
                                        <th className="px-4 py-3 border-b border-slate-200 whitespace-nowrap">Dates</th>
                                        <th className="px-4 py-3 border-b border-slate-200 text-center">Classes held</th>
                                        <th className="px-4 py-3 border-b border-slate-200 text-center">Students</th>
                                        <th className="px-4 py-3 border-b border-slate-200 text-center">Attendance</th>
                                        <th className="px-4 py-3 border-b border-slate-200 text-right">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {shown.map(({ course, grid }) => (
                                        <tr key={course.id} className="border-b border-slate-100 hover:bg-slate-50">
                                            <td className="px-4 py-3">
                                                <input type="checkbox" checked={selected.has(course.id)} onChange={() => toggle(course.id)} className="h-4 w-4" aria-label={`Select ${course.code || course.name}`} />
                                            </td>
                                            <td className="px-4 py-3 font-mono text-xs text-slate-700">{course.code}</td>
                                            <td className="px-4 py-3 font-medium text-slate-900">{course.name}</td>
                                            <td className="px-4 py-3 text-slate-600">{normType(course.type)}</td>
                                            <td className="px-4 py-3">
                                                <span className={`px-2 py-0.5 text-xs font-bold rounded-full ${isRunning(course) ? "bg-green-100 text-green-700" : normStatus(course.status) === "cancelled" ? "bg-red-50 text-red-600" : "bg-slate-100 text-slate-600"}`}>{course.status || "No status"}</span>
                                            </td>
                                            <td className="px-4 py-3 text-slate-500 whitespace-nowrap text-xs">{course.startDate ? ukDate(course.startDate) : ""}{course.endDate ? ` to ${ukDate(course.endDate)}` : ""}</td>
                                            <td className="px-4 py-3 text-center">{grid.dates.length}</td>
                                            <td className="px-4 py-3 text-center">{grid.students.length}</td>
                                            <td className="px-4 py-3 text-center font-medium">{grid.fair && grid.fair.rate !== null ? `${grid.fair.rate}%` : <span className="text-slate-400 font-normal">No data</span>}</td>
                                            <td className="px-4 py-3 text-right whitespace-nowrap">
                                                <button
                                                    onClick={() => download([{ course, grid }], `Register ${course.code || course.name || course.id} ${londonToday()}`)}
                                                    className="text-slate-500 hover:text-[#2c4a00] inline-flex items-center gap-1 mr-4"
                                                    title="Download this register as Excel"
                                                >
                                                    <Download size={14} /> Excel
                                                </button>
                                                <Link
                                                    href={mayOpenCourse ? `/admin/courses/detail?id=${course.id}` : `/academy/reports?course=${course.id}`}
                                                    className="text-blue-700 hover:underline inline-flex items-center gap-1"
                                                >
                                                    <ExternalLink size={14} /> Open register
                                                </Link>
                                            </td>
                                        </tr>
                                    ))}
                                    {shown.length === 0 && (
                                        <tr><td colSpan={10} className="px-6 py-8 text-center text-slate-400 italic">No courses match.</td></tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                    <p className="mt-3 text-xs text-slate-500">
                        Finished means Completed or Cancelled. Students counts everyone who was ever on the course or came to a class. Attendance uses the fair method: each class is compared with the students on the course at that time.
                    </p>
                </>
            )}
        </div>
    );
}

export default function HistoricRegistersPage() {
    return <RequirePermission perm="class_reports"><HistoricRegistersContent /></RequirePermission>;
}
