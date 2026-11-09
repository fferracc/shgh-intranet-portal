"use client";

import DashboardLayout from "@/components/layout/DashboardLayout";
import { useEffect, useState } from "react";
import { collection, query, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Search, Plus, Pencil, Archive, ArchiveRestore, MapPin, ChevronDown, ChevronUp } from "lucide-react";
import { Student } from "@/lib/types";
import StudentMap from "@/components/academy/StudentMap";
import Link from "next/link";
import { RequirePermission } from "@/components/auth/RequirePermission";
import { useAuth } from "@/contexts/AuthContext";
import { archiveStudent, restoreStudent, isFinishedCourse } from "@/lib/archive";
import { isRunning } from "@/lib/stats";
import { loadStudentPrivateMap, overlayPrivate } from "@/lib/studentPrivate";
import { can } from "@/lib/permissions";
import StudentFormModal from "@/lib/students/StudentFormModal";
import EnrolModal, { EnrolCourse } from "@/lib/students/EnrolModal";
import { SaveResult } from "@/lib/students/saveStudent";
import { extraFieldRows } from "@/lib/students/studentForm";

function StudentsPage() {
    const { user } = useAuth();
    const [students, setStudents] = useState<Student[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState("");
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingStudent, setEditingStudent] = useState<Student | null>(null);
    const withPrivate = can(user, "students");

    // Filter & Sort States
    const [showMap, setShowMap] = useState(false);
    const [showEnrolledOnly, setShowEnrolledOnly] = useState(false);
    const [showArchived, setShowArchived] = useState(false);
    const [finishedCourseIds, setFinishedCourseIds] = useState<Set<string>>(new Set());
    const [sortAgeDirection, setSortAgeDirection] = useState<'none' | 'asc' | 'desc'>('none');

    // Enrollment Modal States
    const [enrollModalOpen, setEnrollModalOpen] = useState(false);
    const [selectedStudentForEnrollment, setSelectedStudentForEnrollment] = useState<Student | null>(null);
    const [availableCourses, setAvailableCourses] = useState<EnrolCourse[]>([]);

    useEffect(() => {
        fetchStudents();
    }, []);

    const fetchStudents = async () => {
        try {
            // Fetch students
            const q = query(collection(db, "students"));
            const snapshot = await getDocs(q);

            // Fetch roster and courses for enrollment data
            const rosterSnap = await getDocs(collection(db, "courseRoster"));
            const courseSnap = await getDocs(collection(db, "course"));
            const privateMap = await loadStudentPrivateMap();

            const courseNames: Record<string, string> = {};
            const activeCoursesList: EnrolCourse[] = [];
            const finished = new Set<string>();
            courseSnap.docs.forEach(d => {
                const data = d.data();
                courseNames[d.id] = data.name || "Unknown Course";
                if (isFinishedCourse(data.status)) finished.add(d.id);
                if (isRunning(data)) { // any capitals (src/lib/stats.ts)
                    activeCoursesList.push({ id: d.id, name: data.name || "Unknown Course", code: data.code || "" });
                }
            });
            setAvailableCourses(activeCoursesList);
            setFinishedCourseIds(finished);

            const studentEnrollments: Record<string, { id: string, name: string }[]> = {};
            rosterSnap.docs.forEach(doc => {
                const data = doc.data();
                // A roster row whose course no longer exists is ignored (left behind by an old delete).
                if (data.studentId && data.courseId && courseNames[data.courseId]) {
                    if (!studentEnrollments[data.studentId]) studentEnrollments[data.studentId] = [];
                    // Deduplicate
                    if (!studentEnrollments[data.studentId].some(c => c.id === data.courseId)) {
                        studentEnrollments[data.studentId].push({
                            id: data.courseId,
                            name: courseNames[data.courseId] || "Unknown Course"
                        });
                    }
                }
            });

            const data: (Student & { enrolledCourses?: { id: string, name: string }[] })[] = [];
            snapshot.forEach(doc => {
                data.push({
                    id: doc.id,
                    ...overlayPrivate(doc.data(), privateMap?.get(doc.id)),
                    enrolledCourses: studentEnrollments[doc.id] || []
                } as any);
            });
            setStudents(data as any);
        } catch (error) {
            console.error("Error fetching students:", error);
        } finally {
            setLoading(false);
        }
    };

    // Only the fields the form saved are put back on screen (1 Oct 2026).
    const handleSaved = (res: SaveResult) => {
        const savedFields = { ...res.main, ...res.priv };
        setStudents(prev => prev.some(s => s.id === res.id)
            ? prev.map(s => s.id === res.id ? { ...s, ...savedFields } as Student : s)
            : [...prev, { id: res.id, ...savedFields, createdAt: new Date().toISOString(), enrolledCourses: [] } as any]);
        setIsModalOpen(false);
        setEditingStudent(null);
    };

    // Keep history (30 Sep 2026): a student is archived, never deleted. Their past registers
    // stay for reports; they are taken off courses that are still planned or running.
    const handleArchive = async (student: Student) => {
        if (!confirm(`Archive ${student.name || "this student"}?\n\nThey are taken off courses that are still running or planned. Their past attendance is kept for reports. You can restore them later from "Show archived".`)) return;
        try {
            const ended = await archiveStudent(student.id, user?.uid || "");
            setStudents(prev => prev.map(s => s.id === student.id ? { ...s, archived: true, enrolledCourses: ((s as any).enrolledCourses || []).filter((c: any) => finishedCourseIds.has(c.id)) } as any : s));
            if (ended) alert(`${student.name || "The student"} is archived and was taken off ${ended} current course${ended === 1 ? "" : "s"}.`);
        } catch (error) {
            console.error("Error archiving student:", error);
            alert("The student could not be archived. You need the Students and Courses permissions.");
        }
    };

    const handleRestore = async (student: Student) => {
        try {
            await restoreStudent(student.id);
            setStudents(prev => prev.map(s => s.id === student.id ? { ...s, archived: false } as any : s));
        } catch (error) {
            console.error("Error restoring student:", error);
            alert("The student could not be restored.");
        }
    };

    const handleEnrolled = (course: EnrolCourse) => {
        const sid = selectedStudentForEnrollment?.id;
        setStudents(prev => prev.map(s => s.id === sid
            ? { ...s, enrolledCourses: [...((s as any).enrolledCourses || []), { id: course.id, name: course.name }] } as any
            : s));
        setEnrollModalOpen(false);
        setSelectedStudentForEnrollment(null);
    };

    const openEdit = (student: Student) => {
        setEditingStudent(student);
        setIsModalOpen(true);
    };

    const openCreate = () => {
        setEditingStudent(null);
        setIsModalOpen(true);
    };

    const archivedCount = students.filter(s => (s as any).archived === true).length;
    let filteredStudents = students.filter(s =>
        (showArchived ? (s as any).archived === true : (s as any).archived !== true) && (
        String(s.name || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
        String(s.email || "").toLowerCase().includes(searchTerm.toLowerCase()))
    );

    if (showEnrolledOnly) {
        filteredStudents = filteredStudents.filter(s => (s as any).enrolledCourses && (s as any).enrolledCourses.length > 0);
    }

    if (sortAgeDirection !== 'none') {
        filteredStudents = [...filteredStudents].sort((a, b) => {
            const ageA = Number(a.age) || 0, ageB = Number(b.age) || 0;
            return sortAgeDirection === 'asc' ? ageA - ageB : ageB - ageA;
        });
    }

    return (
        <DashboardLayout>
            <div className="flex justify-between items-center mb-6">
                <div>
                    <h1 className="text-2xl font-bold text-slate-800">Students</h1>
                    <p className="text-slate-500">Manage student records and enrolments. Open a student to see their attendance.</p>
                </div>
                <button
                    onClick={openCreate}
                    className="bg-blue-600 text-white px-4 py-2 rounded-lg flex items-center gap-2 hover:bg-blue-700 transition"
                >
                    <Plus size={18} /> Add Student
                </button>
            </div>

            <div className="p-4 rounded-xl shadow-sm border mb-6 space-y-4" style={{ backgroundColor: 'white', borderColor: '#e2e8f0' }}>
                <div className="relative">
                    <Search className="absolute left-3 top-2.5 text-slate-400" size={20} />
                    <input
                        type="text"
                        placeholder="Search students..."
                        className="pl-10 pr-4 py-2 border border-slate-200 rounded-lg w-full outline-none focus:ring-2 focus:ring-[#7f4c12]"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                    />
                </div>
                <div className="flex flex-wrap items-center gap-4 text-sm text-slate-600">
                    <label className="flex items-center gap-2 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={showEnrolledOnly}
                            onChange={e => setShowEnrolledOnly(e.target.checked)}
                            className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                        />
                        <span className="font-medium">Show enrolled only</span>
                    </label>

                    <label className="flex items-center gap-2 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={showArchived}
                            onChange={e => setShowArchived(e.target.checked)}
                            className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                        />
                        <span className="font-medium">Show archived ({archivedCount})</span>
                    </label>

                    <div className="h-6 w-px bg-slate-200"></div>

                    <button
                        onClick={() => setSortAgeDirection(prev => prev === 'asc' ? 'desc' : prev === 'desc' ? 'none' : 'asc')}
                        className="flex items-center gap-1 font-medium hover:text-slate-900 transition"
                    >
                        Sort by Age
                        {sortAgeDirection === 'asc' && <ChevronUp size={16} />}
                        {sortAgeDirection === 'desc' && <ChevronDown size={16} />}
                        {sortAgeDirection === 'none' && <span className="opacity-50 ml-1">(None)</span>}
                    </button>

                    <div className="h-6 w-px bg-slate-200"></div>

                    <button
                        onClick={() => setShowMap(!showMap)}
                        className={`flex items-center gap-1 font-medium transition px-3 py-1.5 rounded-lg border ${showMap ? 'bg-blue-50 text-blue-700 border-blue-200 shadow-inner' : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'}`}
                    >
                        <MapPin size={16} /> {showMap ? 'Hide Student Map' : 'Show Student Map'}
                    </button>
                </div>
            </div>

            {/* Map View */}
            {showMap && (
                <div className="mb-6 fade-in">
                    <StudentMap students={filteredStudents} />
                </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filteredStudents.map(student => (
                    <div key={student.id} className="p-6 rounded-xl shadow-sm border hover:shadow-md transition" style={{ backgroundColor: 'white', borderColor: '#e2e8f0' }}>
                        <div className="flex justify-between items-start mb-4">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-white shadow-sm" style={{ backgroundColor: '#2c4a00' }}>
                                    {String(student.name || "?").charAt(0)}
                                </div>
                                <div>
                                    <Link href={`/admin/students/detail?id=${student.id}`} className="hover:underline">
                                        <h3 className="font-bold text-blue-700 hover:text-blue-900">{student.name || "No name"}</h3>
                                    </Link>
                                    <p className="text-xs text-slate-500">{student.email || "No Email"}</p>
                                </div>
                            </div>
                            <div className="flex gap-1">
                                <button
                                    onClick={() => {
                                        setSelectedStudentForEnrollment(student);
                                        setEnrollModalOpen(true);
                                    }}
                                    className="p-1 mr-2 text-blue-600 bg-blue-50 hover:bg-blue-100 rounded border border-blue-100 flex items-center gap-1 text-xs font-semibold shadow-sm transition"
                                    title="Enrol on a course"
                                >
                                    <Plus size={14} /> Enrol
                                </button>
                                <button onClick={() => openEdit(student)} className="p-1 text-slate-400 hover:text-[#7f4c12] rounded" title="Edit student" aria-label="Edit student">
                                    <Pencil size={16} />
                                </button>
                                {(student as any).archived === true ? (
                                    <button onClick={() => handleRestore(student)} className="p-1 text-slate-400 hover:text-green-700 rounded" title="Restore student" aria-label="Restore student">
                                        <ArchiveRestore size={16} />
                                    </button>
                                ) : (
                                    <button onClick={() => handleArchive(student)} className="p-1 text-slate-400 hover:text-red-600 rounded" title="Archive student (keeps their history)" aria-label="Archive student">
                                        <Archive size={16} />
                                    </button>
                                )}
                            </div>
                        </div>
                        <div className="space-y-2 text-sm text-slate-600">
                            <div className="flex justify-between"><span>Age:</span> <span className="font-medium">{student.age || '—'}</span></div>
                            {student.dob && (
                                <div className="flex justify-between"><span>Date of Birth:</span> <span className="font-medium">{student.dob}</span></div>
                            )}
                            {student.nationality && (
                                <div className="flex justify-between"><span>Nationality:</span> <span className="font-medium">{student.nationality}</span></div>
                            )}
                            <div className="flex justify-between"><span>Postcode:</span> <span className="font-medium">{student.postcode || 'N/A'}</span></div>
                            {student.mobile && (
                                <div className="flex justify-between"><span>Mobile:</span> <span className="font-medium">{student.mobile}</span></div>
                            )}
                            {student.refugeeNumber && (
                                <div className="flex justify-between text-blue-700 font-semibold"><span>Refugee No:</span> <span>{student.refugeeNumber}</span></div>
                            )}
                            {student.sovereignReference && (
                                <div className="flex justify-between text-blue-700 font-semibold"><span>SH Ref:</span> <span>{student.sovereignReference}</span></div>
                            )}
                            {student.itLevel && (
                                <div className="flex justify-between"><span>IT Level:</span> <span className="font-medium capitalize">{student.itLevel}</span></div>
                            )}

                            <div className="pt-2 border-t border-slate-50 mt-2">
                                <span className="text-xs font-semibold text-slate-400 uppercase mb-1 block">Enrolled Courses ({(student as any).enrolledCourses?.length || 0})</span>
                                {(student as any).enrolledCourses && (student as any).enrolledCourses.length > 0 ? (
                                    <div className="flex flex-wrap gap-1 mt-1">
                                        {(student as any).enrolledCourses.map((c: any) => (
                                            <span key={c.id} className="text-[10px] bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full border border-blue-100">
                                                {c.name}
                                            </span>
                                        ))}
                                    </div>
                                ) : (
                                    <span className="text-xs text-slate-400 italic">None</span>
                                )}
                            </div>

                            {Number(student.age) > 0 && Number(student.age) < 18 && (
                                <div className="pt-2 border-t border-slate-50 mt-2">
                                    <p className="text-xs font-semibold text-slate-400 uppercase mb-1">Guardian</p>
                                    <p>{student.parentName} ({student.parentPhone})</p>
                                </div>
                            )}
                            
                            {extraFieldRows(student).length > 0 && (
                                <div className="pt-2 border-t border-slate-50 mt-2">
                                    <p className="text-xs font-semibold text-slate-400 uppercase mb-1">Additional Info</p>
                                    <div className="space-y-1">
                                        {extraFieldRows(student).map(r => (
                                            <div key={r.key} className="flex justify-between text-xs">
                                                <span>{r.label}:</span>
                                                <span className="font-medium truncate max-w-[150px]" title={r.value}>{r.value}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                ))}
            </div>

            <StudentFormModal
                open={isModalOpen}
                student={editingStudent}
                withPrivate={withPrivate}
                onClose={() => { setIsModalOpen(false); setEditingStudent(null); }}
                onSaved={handleSaved}
            />

            <EnrolModal
                open={enrollModalOpen && !!selectedStudentForEnrollment}
                studentId={selectedStudentForEnrollment?.id || ""}
                studentName={String(selectedStudentForEnrollment?.name || "")}
                runningCourses={availableCourses}
                alreadyOn={((selectedStudentForEnrollment as any)?.enrolledCourses || []).map((c: any) => c.id)}
                onClose={() => { setEnrollModalOpen(false); setSelectedStudentForEnrollment(null); }}
                onEnrolled={handleEnrolled}
            />

        </DashboardLayout>
    );
}

export default function GuardedStudentsPage() {
    return (
        <RequirePermission perm="students">
            <StudentsPage />
        </RequirePermission>
    );
}
