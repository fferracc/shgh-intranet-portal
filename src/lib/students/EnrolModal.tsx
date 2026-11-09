"use client";

// Enrol a student on a running course (1 Oct 2026). Used by the Students list and the student page.
import { useEffect, useState } from "react";
import { addDoc, collection } from "firebase/firestore";
import { BookOpen, GraduationCap, X } from "lucide-react";
import { db } from "@/lib/firebase";

export interface EnrolCourse { id: string; name: string; code?: string }

/** Adds a courseRoster row with enrolledAt. */
export async function enrolStudent(studentId: string, courseId: string): Promise<void> {
    await addDoc(collection(db, "courseRoster"), {
        courseId, studentId, role: "student", enrolledAt: new Date().toISOString(),
    });
}

export default function EnrolModal({ open, studentId, studentName, runningCourses, alreadyOn, onClose, onEnrolled }: {
    open: boolean;
    studentId: string;
    studentName: string;
    /** Courses whose status is running (any capitals). */
    runningCourses: EnrolCourse[];
    /** Course ids the student is on now. */
    alreadyOn: string[];
    onClose: () => void;
    onEnrolled: (course: EnrolCourse) => void;
}) {
    const [courseId, setCourseId] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    useEffect(() => { if (open) { setCourseId(""); setError(""); setSaving(false); } }, [open]);
    if (!open) return null;

    const choices = runningCourses.filter(c => !alreadyOn.includes(c.id))
        .sort((a, b) => (a.code || a.name || "").localeCompare(b.code || b.name || ""));

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        const course = choices.find(c => c.id === courseId);
        if (!course) return;
        setSaving(true); setError("");
        try {
            await enrolStudent(studentId, course.id);
            onEnrolled(course);
        } catch (err) {
            console.error("Error enrolling student:", err);
            setError("The student could not be enrolled. Please try again.");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 fade-in">
            <div className="bg-white rounded-xl shadow-lg w-full max-w-lg overflow-hidden">
                <div className="bg-blue-50/50 p-6 border-b border-blue-100 flex justify-between items-start">
                    <div>
                        <h3 className="font-bold text-xl text-slate-800 flex items-center gap-2">
                            <GraduationCap className="text-blue-600" size={24} />
                            Course Enrolment
                        </h3>
                        <p className="text-sm text-slate-500 mt-1">Enrol <span className="font-semibold text-slate-700">{studentName || "this student"}</span> on a running course.</p>
                    </div>
                    <button type="button" onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-600 bg-white rounded-full p-1 shadow-sm border border-slate-200">
                        <X size={20} />
                    </button>
                </div>
                <form onSubmit={submit} className="p-6 space-y-6">
                    <div>
                        <label className="block text-sm font-semibold text-slate-700 mb-2">Running courses</label>
                        {choices.length > 0 ? (
                            <select required className="w-full p-3 border border-slate-300 rounded-lg bg-white shadow-sm focus:ring-2 focus:ring-blue-500 outline-none transition"
                                value={courseId} onChange={e => setCourseId(e.target.value)}>
                                <option value="">Choose a course</option>
                                {choices.map(c => <option key={c.id} value={c.id}>{c.code ? `${c.code} ` : ""}{c.name || "Unnamed course"}</option>)}
                            </select>
                        ) : (
                            <div className="p-4 bg-orange-50 border border-orange-200 rounded-lg text-orange-700 text-sm flex gap-2 items-start">
                                <BookOpen size={18} className="flex-shrink-0 mt-0.5" />
                                <p>{runningCourses.length ? "This student is already on every running course." : "There are no running courses. Set a course's status to Running first."}</p>
                            </div>
                        )}
                    </div>
                    {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
                    <div className="flex justify-end pt-2 border-t border-slate-100">
                        <button type="button" onClick={onClose} className="px-4 py-2 text-slate-600 font-medium hover:bg-slate-100 rounded-lg mr-2 transition">Cancel</button>
                        <button type="submit" disabled={!courseId || saving}
                            className="bg-blue-600 text-white px-6 py-2 rounded-lg font-bold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center gap-2">
                            {saving ? "Enrolling…" : "Confirm Enrolment"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
