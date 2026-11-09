"use client";

import DashboardLayout from "@/components/layout/DashboardLayout";
import { useEffect, useState } from "react";
import { doc, updateDoc } from "firebase/firestore";
import { cancelCourse, isFinishedCourse } from "@/lib/archive";
import { db } from "@/lib/firebase";
import CourseFields from "@/components/academy/CourseFields";
import { createCourse } from "@/lib/courses";
import { courseFigures, isOneToOne, isRunning, normStatus, normType, round1 } from "@/lib/stats";
import { loadStatsData } from "@/lib/statsLoader";
import { BookOpen, Search, Plus, Pencil, Ban, X, Calendar, Users } from "lucide-react";
import Link from "next/link";
import { Course } from "@/lib/types";
import { RequirePermission } from "@/components/auth/RequirePermission";
import { useAuth } from "@/contexts/AuthContext";

type StatusTab = "running" | "planned" | "completed" | "cancelled" | "all";
const TABS: { key: StatusTab; label: string }[] = [
    { key: "running", label: "Running" },
    { key: "planned", label: "Planned" },
    { key: "completed", label: "Completed" },
    { key: "cancelled", label: "Cancelled" },
    { key: "all", label: "All" },
];

function CoursesPage() {
    const { user } = useAuth();
    const [courses, setCourses] = useState<Course[]>([]);
    const [partial, setPartial] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState("");
    const [tab, setTab] = useState<StatusTab>("running");
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingCourse, setEditingCourse] = useState<Course | null>(null);

    const initialFormState: Partial<Course> = {
        code: "", name: "", description: "", type: "Rolling",
        schedule: { day: "Monday", start: "10:00", end: "12:00", frequency: "Weekly" },
        startDate: "", endDate: "", setting: "In-Person", venue: "", address: "", postcode: "", status: "Planned"
    };
    const [formData, setFormData] = useState<Partial<Course>>(initialFormState);

    useEffect(() => {
        fetchCourses();
    }, []);

    const fetchCourses = async () => {
        try {
            // Students, Classes and Hours (30 Sep 2026) come from src/lib/stats.ts, so they match
            // the course page, Class Reports, the Dashboard and the Funders Report.
            const { data: statsData, failed } = await loadStatsData(['courses', 'students', 'roster', 'attendance', 'oneToOne']);
            if (failed.includes('courses')) throw new Error("Courses could not be read");
            if (failed.length) console.warn("Some course figures could not be read:", failed);
            setPartial(failed);
            const figures = courseFigures(statsData);

            const data: (Course & { stats?: { hours: number, sessions: number, enrolledStudents: number } })[] = statsData.courses.map(sc => {
                const c = sc as unknown as Course;
                const f = figures[c.id];
                return {
                    ...c,
                    stats: {
                        hours: round1(f?.hours || 0),
                        sessions: f?.sessions || 0,
                        enrolledStudents: f?.students || 0,
                    }
                };
            });

            // Sort by Code
            data.sort((a, b) => (a.code || "").localeCompare(b.code || ""));

            setCourses(data);
        } catch (error) {
            console.error("Error fetching courses:", error);
        } finally {
            setLoading(false);
        }
    };

    const handleSave = async (e: React.FormEvent) => {
        // ... (existing save logic remains same, just ensuring state type compat)
        e.preventDefault();
        try {
            if (editingCourse) {
                const ref = doc(db, "course", editingCourse.id);
                await updateDoc(ref, formData);
                setCourses(prev => prev.map(c => c.id === editingCourse.id ? { ...c, ...formData } as any : c));
            } else {
                // Empty code = next free code (C0001, C0002, ...).
                const made = await createCourse(formData);
                setCourses(prev => [...prev, { id: made.id, ...formData, code: made.code } as any]);
            }
            setIsModalOpen(false);
            setEditingCourse(null);
            setFormData(initialFormState);
        } catch (error) {
            console.error("Error saving course:", error);
            alert("Failed to save course.");
        }
    };

    // Keep history (30 Sep 2026): a course is cancelled, never deleted, so its roster and
    // registers stay for reports. See src/lib/archive.ts.
    const handleCancel = async (course: any) => {
        if (isFinishedCourse(course.status)) return;
        if (!confirm(`Cancel ${course.code || ""} ${course.name || "this course"}?\n\nIts roster and registers are kept for reports. You can set it back to Running or Planned with Edit.`)) return;
        try {
            await cancelCourse(course.id, user?.uid || "");
            setCourses(prev => prev.map(c => c.id === course.id ? { ...c, status: "Cancelled" } as any : c));
        } catch (error) {
            console.error("Error cancelling course:", error);
            alert("The course could not be cancelled. You need the Courses permission.");
        }
    };

    const openEdit = (course: Course) => {
        setEditingCourse(course);
        setFormData(course);
        setIsModalOpen(true);
    };

    const openCreate = () => {
        setEditingCourse(null);
        setFormData(initialFormState);
        setIsModalOpen(true);
    };

    // Search (code, name, venue) and status tabs; status compared in lower case.
    const term = searchTerm.trim().toLowerCase();
    const matching = courses.filter((c: any) => !term || [c.code, c.name, c.venue].some(v => String(v || "").toLowerCase().includes(term)));
    const countFor = (k: StatusTab) => k === "all" ? matching.length : matching.filter((c: any) => normStatus(c.status) === k).length;
    const shown = tab === "all" ? matching : matching.filter((c: any) => normStatus(c.status) === tab);

    return (
        <DashboardLayout>
            <div className="flex justify-between items-center mb-6">
                <div>
                    <h1 className="text-2xl font-bold text-slate-800">Courses</h1>
                    <p className="text-slate-500">Manage educational programs and schedules.</p>
                </div>
                <button
                    onClick={openCreate}
                    className="bg-green-600 text-white px-4 py-2 rounded-lg flex items-center gap-2 hover:bg-green-700 transition"
                >
                    <Plus size={18} /> Create Course
                </button>
            </div>

            {partial.length > 0 && (
                <div className="mb-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
                    Some figures could not be loaded ({partial.join(", ")}), so the numbers below may be too low.
                </div>
            )}
            <div className="mb-6 flex flex-col md:flex-row md:items-center gap-4">
                <div className="relative flex-1 max-w-md">
                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                        type="search"
                        value={searchTerm}
                        onChange={e => setSearchTerm(e.target.value)}
                        placeholder="Search by code, name or venue"
                        className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg bg-white text-sm focus:ring-2 focus:ring-green-600 focus:border-transparent"
                    />
                </div>
                <div className="flex flex-wrap gap-2">
                    {TABS.map(t => (
                        <button
                            key={t.key}
                            onClick={() => setTab(t.key)}
                            className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${tab === t.key ? 'bg-green-600 text-white border-green-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}
                        >
                            {t.label} <span className={tab === t.key ? 'text-green-100' : 'text-slate-400'}>({countFor(t.key)})</span>
                        </button>
                    ))}
                </div>
            </div>

            {!loading && shown.length === 0 && (
                <div className="p-8 text-center text-slate-500 bg-white rounded-xl border border-dashed border-slate-300">
                    <BookOpen className="mx-auto mb-2 text-slate-300" size={32} />
                    No courses match.
                </div>
            )}
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
                {shown.map((course: any) => (
                    <div key={course.id} className="p-6 rounded-xl shadow-sm border relative group flex flex-col h-full" style={{ backgroundColor: 'white', borderColor: '#e2e8f0' }}>
                        <div className="flex justify-between items-start mb-2">
                            <div className="flex gap-2">
                                <span className={`px-2 py-1 text-xs font-bold rounded-full ${isRunning(course) ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-600'}`}>{course.status}</span>
                                <span className={`px-2 py-1 text-xs font-bold rounded-full ${normType(course.type) === 'Drop-in' ? 'bg-orange-100 text-orange-700' : isOneToOne(course) ? 'bg-teal-100 text-teal-700' : 'bg-blue-100 text-blue-700'}`}>
                                    {normType(course.type)}
                                </span>
                            </div>
                            <div className="flex gap-2">
                                <button onClick={() => openEdit(course)} className="text-slate-400 hover:text-[#7f4c12]" title="Edit course" aria-label="Edit course"><Pencil size={16} /></button>
                                {!isFinishedCourse(course.status) && (
                                    <button onClick={() => handleCancel(course)} className="text-slate-400 hover:text-red-600" title="Cancel course (keeps its history)" aria-label="Cancel course"><Ban size={16} /></button>
                                )}
                            </div>
                        </div>
                        <Link href={`/admin/courses/detail?id=${course.id}`} className="font-bold text-lg text-slate-800 mb-1 hover:text-green-700 transition-colors">
                            {course.code}: {course.name}
                        </Link>
                        <p className="text-sm text-slate-500 mb-4 line-clamp-2 flex-grow">{course.description}</p>

                        <div className="grid grid-cols-3 gap-2 mb-4">
                            <div className="bg-slate-50 p-2 rounded text-center">
                                <div className="text-lg font-bold text-blue-700">{course.stats?.enrolledStudents || 0}</div>
                                <div className="text-[10px] text-slate-500 uppercase">Students</div>
                            </div>
                            <div className="bg-slate-50 p-2 rounded text-center">
                                <div className="text-lg font-bold text-[#7f4c12]">{course.stats?.hours || 0}</div>
                                <div className="text-[10px] text-slate-500 uppercase">Hours</div>
                            </div>
                            <div className="bg-slate-50 p-2 rounded text-center">
                                <div className="text-lg font-bold text-slate-700">{course.stats?.sessions || 0}</div>
                                <div className="text-[10px] text-slate-500 uppercase">{isOneToOne(course) ? 'Sessions' : 'Classes'}</div>
                            </div>
                        </div>

                        <div className="mb-4">
                            <Link href={`/admin/courses/detail?id=${course.id}`} className="w-full text-center block bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium py-2 rounded transition-colors text-sm flex items-center justify-center gap-2">
                                <Users size={16} /> Manage Roster
                            </Link>
                        </div>

                        <div className="pt-4 border-t space-y-2 text-sm text-slate-600 mt-auto" style={{ borderColor: '#f1f5f9' }}>
                            <div className="flex items-start gap-2">
                                <Calendar size={14} className="text-slate-400 mt-1 flex-shrink-0" />
                                <div>
                                    <div className="font-medium">
                                        <span className="text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded text-xs mr-2">{course.schedule?.frequency || 'Weekly'}</span>
                                        {course.schedule?.day}, {course.schedule?.start} to {course.schedule?.end}
                                    </div>
                                    {course.schedule?.frequency === 'Custom' && course.schedule?.customNotes && (
                                        <div className="text-xs text-slate-500 mt-1 italic">{course.schedule.customNotes}</div>
                                    )}
                                </div>
                            </div>
                            <div className="text-xs text-slate-400 pl-6">
                                {course.startDate} to {course.endDate}
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            {/* Reuse similar Modal structure as Students but with Course fields */}
            {isModalOpen && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto">
                        <div className="flex justify-between items-center p-6 border-b border-slate-100 sticky top-0 bg-white">
                            <h3 className="font-bold text-xl text-slate-800">{editingCourse ? 'Edit Course' : 'Create Course'}</h3>
                            <button onClick={() => setIsModalOpen(false)}><X size={24} className="text-slate-400" /></button>
                        </div>
                        <form onSubmit={handleSave} className="p-6 space-y-4">
                            <CourseFields value={formData} onChange={setFormData} />

                            <div className="flex justify-end pt-4">
                                <button type="submit" className="bg-green-600 text-white px-6 py-2 rounded-lg font-bold hover:bg-green-700">Save Course</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </DashboardLayout>
    );
}

export default function GuardedCoursesPage() {
    return (
        <RequirePermission perm="courses">
            <CoursesPage />
        </RequirePermission>
    );
}
