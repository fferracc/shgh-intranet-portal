"use client";

import { RequirePermission } from "@/components/auth/RequirePermission";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useEffect, useState, Suspense } from "react";
import { doc, getDoc, collection, query, where, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Student } from "@/lib/types";
import { loadStudentPrivate, overlayPrivate } from "@/lib/studentPrivate";
import { isFinished, isRunning, normStatus, studentCourseAttendance, StatsData, StudentCourseAttendance } from "@/lib/stats";
import { ArrowLeft, Phone, Clock, Loader2, BookOpen, User, Info, FileText, Pencil, Plus, Archive, ArchiveRestore } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { can } from "@/lib/permissions";
import { archiveStudent, restoreStudent } from "@/lib/archive";
import StudentFormModal from "@/lib/students/StudentFormModal";
import EnrolModal, { EnrolCourse } from "@/lib/students/EnrolModal";
import { extraFieldRows, isOldNationality } from "@/lib/students/studentForm";

function StudentDetailsContent() {
    const searchParams = useSearchParams();
    const id = searchParams.get("id") as string;
    const { user } = useAuth();
    const withPrivate = can(user, "students");
    const [editOpen, setEditOpen] = useState(false);
    const [enrolOpen, setEnrolOpen] = useState(false);
    const [runningCourses, setRunningCourses] = useState<EnrolCourse[]>([]);
    const [onRosterNow, setOnRosterNow] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);

    const [student, setStudent] = useState<Student | null>(null);
    type CourseRow = { id: string, name: string, code?: string, status: string, onRoster: boolean, att: StudentCourseAttendance };
    const [enrolledCourses, setEnrolledCourses] = useState<CourseRow[]>([]);
    const [attendance, setAttendance] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (id) fetchData();
    }, [id]);

    const fetchData = async () => {
        try {
            // 1. Fetch Student Profile
            const studentDoc = await getDoc(doc(db, "students", id));
            if (studentDoc.exists()) {
                setStudent({ id: studentDoc.id, ...overlayPrivate(studentDoc.data(), await loadStudentPrivate(studentDoc.id)) } as Student);
            } else {
                setLoading(false);
                return;
            }

            // 2. Fetch Courses
            const courseSnap = await getDocs(collection(db, "course"));
            const courses = courseSnap.docs.map(d => ({ id: d.id, ...d.data() } as any));
            const courseMap: Record<string, any> = {};
            courses.forEach(c => { courseMap[c.id] = c; });
            setRunningCourses(courses.filter(c => isRunning(c)).map(c => ({ id: c.id, name: c.name || "Unknown Course", code: c.code || "" })));

            // 3. Enrolment (roster) and every register of this student (no limit)
            const rosterSnap = await getDocs(query(collection(db, "courseRoster"), where("studentId", "==", id)));
            const rosterRows = rosterSnap.docs.map(d => d.data());
            setOnRosterNow([...new Set(rosterRows.map(r => r.courseId).filter(Boolean))] as string[]);
            const mySnap = await getDocs(query(collection(db, "attendanceRecords"), where("studentId", "==", id)));

            // Courses: on the roster now, or attended in the past. Deleted courses are left out.
            const courseIds = [...new Set([...rosterRows.map(r => r.courseId), ...mySnap.docs.map(d => d.data().courseId)].filter(cid => cid && courseMap[cid]))] as string[];

            // "Attended X of Y classes" uses the fair method of src/lib/stats.ts: Y counts only the
            // classes held while the student belonged to the course, so it needs each course's registers.
            const courseRecords = await Promise.all(courseIds.map(cid => getDocs(query(collection(db, "attendanceRecords"), where("courseId", "==", cid)))));
            const statsData: StatsData = {
                courses,
                students: [{ id, ...studentDoc.data() }],
                roster: rosterRows,
                attendance: courseRecords.flatMap(snap => snap.docs.map(d => d.data())),
            };
            const rows: CourseRow[] = courseIds.map(cid => ({
                id: cid,
                name: courseMap[cid].name || "Unknown Course",
                code: courseMap[cid].code || "",
                status: courseMap[cid].status || "",
                onRoster: rosterRows.some(r => r.courseId === cid),
                att: studentCourseAttendance(id, cid, statsData),
            }));
            rows.sort((a, b) => (a.code || a.name).localeCompare(b.code || b.name));
            setEnrolledCourses(rows);

            // 4. Attendance log: one line per course per day, newest first
            const seen = new Set<string>();
            const attList: any[] = [];
            mySnap.forEach(doc => {
                const att = doc.data();
                const courseInfo = courseMap[att.courseId];
                if (!courseInfo || !att.date) return; // register of a deleted course
                const key = `${att.courseId}|${att.date}`;
                if (seen.has(key)) return;
                seen.add(key);
                attList.push({
                    id: doc.id,
                    date: att.date,
                    courseName: courseInfo.name || "Unknown Course",
                    courseCode: courseInfo.code || "",
                    status: 'Present'
                });
            });
            attList.sort((a, b) => String(b.date).localeCompare(String(a.date)));
            setAttendance(attList);

        } catch (error) {
            console.error("Error fetching student details:", error);
        } finally {
            setLoading(false);
        }
    };

    // Keep history (30 Sep 2026): archive instead of delete, from the student's own page too.
    const handleArchive = async () => {
        if (!student) return;
        if (!confirm(`Archive ${student.name || "this student"}?\n\nThey are taken off courses that are still running or planned. Their past attendance is kept for reports. You can restore them later.`)) return;
        setBusy(true);
        try {
            const ended = await archiveStudent(student.id, user?.uid || "");
            if (ended) alert(`${student.name || "The student"} is archived and was taken off ${ended} current course${ended === 1 ? "" : "s"}.`);
            await fetchData();
        } catch (error) {
            console.error("Error archiving student:", error);
            alert("The student could not be archived. You need the Students and Courses permissions.");
        } finally { setBusy(false); }
    };

    const handleRestore = async () => {
        if (!student) return;
        setBusy(true);
        try {
            await restoreStudent(student.id);
            await fetchData();
        } catch (error) {
            console.error("Error restoring student:", error);
            alert("The student could not be restored.");
        } finally { setBusy(false); }
    };

    if (loading) {
        return (
            <DashboardLayout>
                <div className="flex justify-center items-center h-64"><Loader2 className="animate-spin text-slate-400 w-8 h-8" /></div>
            </DashboardLayout>
        );
    }

    if (!student) {
        return (
            <DashboardLayout>
                <div className="p-8 text-center text-red-500">Student not found</div>
            </DashboardLayout>
        );
    }

    return (
        <DashboardLayout>
            <div className="mb-6">
                <Link href="/admin/students" className="inline-flex items-center gap-2 text-slate-500 hover:text-slate-800 mb-4 transition-colors">
                    <ArrowLeft size={16} /> Back to Students
                </Link>
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                        <div className="w-16 h-16 rounded-full flex items-center justify-center text-2xl font-bold text-white shadow-sm" style={{ backgroundColor: '#2c4a00' }}>
                            {String(student.name || "").charAt(0).toUpperCase() || 'S'}
                        </div>
                        <div>
                            <h1 className="text-2xl font-bold text-slate-800">{student.name || "No name"}</h1>
                            <span className="px-3 py-1 bg-slate-100 text-slate-600 rounded-full text-xs font-semibold uppercase mt-1 inline-block">Student</span>
                            {student.archived === true && <span className="ml-2 px-3 py-1 bg-amber-100 text-amber-800 rounded-full text-xs font-semibold uppercase mt-1 inline-block">Archived</span>}
                        </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <button onClick={() => setEditOpen(true)} disabled={busy} className="bg-white border border-slate-300 text-slate-700 px-4 py-2 rounded-lg font-semibold hover:bg-slate-50 transition shadow-sm text-sm flex items-center gap-2 disabled:opacity-50">
                            <Pencil size={16} /> Edit
                        </button>
                        {student.archived !== true && (
                            <button onClick={() => setEnrolOpen(true)} disabled={busy} className="bg-blue-600 text-white px-4 py-2 rounded-lg font-semibold hover:bg-blue-700 transition shadow-sm text-sm flex items-center gap-2 disabled:opacity-50">
                                <Plus size={16} /> Enrol
                            </button>
                        )}
                        {student.archived === true ? (
                            <button onClick={handleRestore} disabled={busy} className="bg-white border border-green-300 text-green-700 px-4 py-2 rounded-lg font-semibold hover:bg-green-50 transition shadow-sm text-sm flex items-center gap-2 disabled:opacity-50">
                                <ArchiveRestore size={16} /> Restore
                            </button>
                        ) : (
                            <button onClick={handleArchive} disabled={busy} className="bg-white border border-red-200 text-red-600 px-4 py-2 rounded-lg font-semibold hover:bg-red-50 transition shadow-sm text-sm flex items-center gap-2 disabled:opacity-50" title="Archive student (keeps their history)">
                                <Archive size={16} /> Archive
                            </button>
                        )}
                    </div>
                </div>
            </div>

            <div className="grid md:grid-cols-3 gap-6">
                {/* Left Column: Personal & Contact Info */}
                <div className="space-y-6">
                    <div className="p-6 rounded-xl shadow-sm border" style={{ backgroundColor: 'white', borderColor: '#e2e8f0' }}>
                        <h3 className="font-bold text-slate-800 mb-4 uppercase text-xs tracking-wider flex items-center gap-2">
                            <User size={16} className="text-blue-500" /> Personal Details
                        </h3>
                        <div className="space-y-4">
                            <div className="flex flex-col">
                                <span className="text-xs text-slate-400 uppercase">Age / DOB</span>
                                <span className="text-sm font-medium text-slate-800">{student.age ? `${student.age} yrs` : 'Age not given'} {student.dob ? `(${student.dob})` : ''}</span>
                            </div>
                            <div className="flex flex-col">
                                <span className="text-xs text-slate-400 uppercase">Ethnicity</span>
                                <span className="text-sm font-medium text-slate-800">{student.ethnicity || 'Not provided'}</span>
                            </div>
                            <div className="flex flex-col">
                                <span className="text-xs text-slate-400 uppercase">Nationality</span>
                                <span className="text-sm font-medium text-slate-800">{student.nationality || 'Not provided'}</span>
                                {isOldNationality(student.nationality) && <span className="text-xs text-amber-700">Saved before the country list. Use Edit to choose the country.</span>}
                            </div>
                            <div className="flex flex-col">
                                <span className="text-xs text-slate-400 uppercase">Reason for Joining</span>
                                <span className="text-sm font-medium text-slate-800">{student.reason || 'Not provided'}</span>
                            </div>
                        </div>
                    </div>

                    {/* New Additional Details Box */}
                    <div className="p-6 rounded-xl shadow-sm border" style={{ backgroundColor: 'white', borderColor: '#e2e8f0' }}>
                        <h3 className="font-bold text-slate-800 mb-4 uppercase text-xs tracking-wider flex items-center gap-2">
                            <FileText size={16} className="text-purple-500" /> Additional Details
                        </h3>
                        <div className="space-y-4">
                            <div className="flex flex-col">
                                <span className="text-xs text-slate-400 uppercase">IT Level</span>
                                <span className="text-sm font-medium text-slate-800">{student.itLevel || 'Not provided'}</span>
                            </div>
                            <div className="flex flex-col">
                                <span className="text-xs text-slate-400 uppercase">Language Used</span>
                                <span className="text-sm font-medium text-slate-800">{student.languageUsed || 'Not provided'}</span>
                            </div>
                            <div className="flex flex-col border-t border-slate-100 pt-2">
                                <span className="text-xs text-slate-400 uppercase">Refugee Number</span>
                                <span className="text-sm font-medium text-blue-700">{student.refugeeNumber || 'Not provided'}</span>
                            </div>
                            <div className="flex flex-col">
                                <span className="text-xs text-slate-400 uppercase">Sovereign House Reference</span>
                                <span className="text-sm font-medium text-blue-700">{student.sovereignReference || 'Not provided'}</span>
                            </div>

                            
                            {/* Extra fields (applicationAnswers is shown below as the application's answers) */}
                            {extraFieldRows(student).map(r => (
                                <div className="flex flex-col border-t border-slate-100 pt-2" key={r.key}>
                                    <span className="text-xs text-slate-400 uppercase">{r.label}</span>
                                    <span className="text-sm font-medium text-slate-800 break-words">{r.value}</span>
                                </div>
                            ))}
                            {student.applicationAnswers && typeof student.applicationAnswers === "object" && Object.keys(student.applicationAnswers).length > 0 && (
                                <div className="border-t border-slate-100 pt-2">
                                    <span className="text-xs text-slate-400 uppercase">Answers from the application</span>
                                    <div className="mt-1 space-y-1">
                                        {Object.entries(student.applicationAnswers as Record<string, unknown>).map(([q, a]) => (
                                            <div key={q} className="text-sm"><span className="text-slate-500">{q}:</span> <span className="font-medium text-slate-800">{Array.isArray(a) ? a.join(", ") : String(a ?? "")}</span></div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="p-6 rounded-xl shadow-sm border" style={{ backgroundColor: 'white', borderColor: '#e2e8f0' }}>
                        <h3 className="font-bold text-slate-800 mb-4 uppercase text-xs tracking-wider flex items-center gap-2">
                            <Phone size={16} className="text-green-500" /> Contact & Guardian
                        </h3>
                        <div className="space-y-4">
                            <div className="flex flex-col">
                                <span className="text-xs text-slate-400 uppercase">Guardian Name</span>
                                <span className="text-sm font-medium text-slate-800">{student.parentName || 'Not provided'}</span>
                            </div>
                            <div className="flex flex-col">
                                <span className="text-xs text-slate-400 uppercase">Guardian Phone</span>
                                <span className="text-sm font-medium text-slate-800">{student.parentPhone || 'Not provided'}</span>
                            </div>
                            <div className="flex flex-col">
                                <span className="text-xs text-slate-400 uppercase">Student Email / Phone</span>
                                <span className="text-sm font-medium text-slate-800">{student.email || 'N/A'} {student.mobile ? `/ ${student.mobile}` : ''}</span>
                            </div>
                            <div className="flex flex-col">
                                <span className="text-xs text-slate-400 uppercase">Address / Postcode</span>
                                <span className="text-sm font-medium text-slate-800">{student.postcode || 'Not provided'}</span>
                            </div>
                            <div className="flex flex-col">
                                <span className="text-xs text-slate-400 uppercase">Emergency Contact</span>
                                <span className="text-sm font-medium text-red-600">{student.emergencyContact || 'Not provided'}</span>
                            </div>
                        </div>
                    </div>
                    
                    <div className="p-6 rounded-xl shadow-sm border" style={{ backgroundColor: 'white', borderColor: '#e2e8f0' }}>
                        <h3 className="font-bold text-slate-800 mb-4 uppercase text-xs tracking-wider flex items-center gap-2">
                            <Info size={16} className="text-orange-500" /> Medical & Other
                        </h3>
                        <div className="space-y-4">
                            <div className="flex flex-col">
                                <span className="text-xs text-slate-400 uppercase">GP Name</span>
                                <span className="text-sm font-medium text-slate-800">{student.gpName || 'Not provided'}</span>
                            </div>
                            <div className="flex flex-col">
                                <span className="text-xs text-slate-400 uppercase">Allergies/Medical Conditions</span>
                                <span className="text-sm font-medium text-red-500">{student.allergies || 'None recorded'}</span>
                            </div>
                            <div className="flex flex-col mt-2 pt-2 border-t border-slate-100">
                                <span className="text-xs text-slate-400 uppercase">Photo Consent</span>
                                <span className="text-sm font-medium text-slate-800">
                                    {student.photoConsent ? <span className="text-green-600 font-bold">Yes</span> : <span className="text-red-500 font-bold">No</span>}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Right Column: Enrollment & Activity */}
                <div className="md:col-span-2 space-y-6">
                    {/* Enrolled Courses */}
                    <div className="p-6 rounded-xl shadow-sm border" style={{ backgroundColor: 'white', borderColor: '#e2e8f0' }}>
                        <h3 className="font-bold text-slate-800 mb-4 flex items-center gap-2">
                            <BookOpen className="text-indigo-500" size={20} /> Courses
                        </h3>
                        {enrolledCourses.length === 0 ? (
                            <p className="text-sm text-slate-400 italic">Not enrolled in any courses.</p>
                        ) : (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                {enrolledCourses.map((course) => (
                                    <Link href={`/admin/courses/detail?id=${course.id}`} key={course.id} className="p-4 border border-slate-200 rounded-lg flex items-center gap-3 bg-slate-50 hover:bg-slate-100 transition-colors">
                                        <div className="w-10 h-10 rounded bg-indigo-100 text-indigo-600 flex items-center justify-center font-bold">
                                            {course.code || 'C'}
                                        </div>
                                        <div>
                                            <div className="font-bold text-sm text-slate-800">{course.name}</div>
                                            <div className="text-xs text-slate-500">
                                                {isFinished(course)
                                                    ? (normStatus(course.status) === 'cancelled' ? 'Cancelled' : 'Completed')
                                                    : !course.onRoster ? 'No longer on the course'
                                                    : isRunning(course) ? 'Active enrolment' : (course.status || 'Planned')}
                                            </div>
                                            <div className="text-xs text-slate-600 mt-0.5">
                                                {course.att.of > 0
                                                    ? <>Attended {course.att.attended} of {course.att.of} classes <strong>({course.att.rate}%)</strong></>
                                                    : 'No classes held yet since joining'}
                                            </div>
                                        </div>
                                    </Link>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Attendance Log */}
                    <div className="p-6 rounded-xl shadow-sm border" style={{ backgroundColor: 'white', borderColor: '#e2e8f0' }}>
                        <h3 className="font-bold text-slate-800 mb-4 flex items-center gap-2">
                            <Clock className="text-slate-400" size={20} /> Recent Attendance <span className="text-xs font-normal text-slate-400">(newest first)</span>
                        </h3>
                        <div className="space-y-3">
                            {attendance.length === 0 ? (
                                <p className="text-sm text-slate-400 italic">No attendance records found.</p>
                            ) : (
                                <div className="max-h-96 overflow-y-auto pr-2 custom-scrollbar">
                                    {attendance.map(record => (
                                        <div key={record.id} className="flex items-center justify-between p-3 border-b border-slate-100 last:border-0 hover:bg-slate-50 rounded transition-colors">
                                            <div className="flex items-center gap-3">
                                                <div className="w-2 h-2 rounded-full bg-green-500"></div>
                                                <div>
                                                    <div className="text-sm font-medium text-slate-800">{record.courseCode ? `${record.courseCode} - ` : ''}{record.courseName}</div>
                                                    <div className="text-xs text-slate-500">{record.date}</div>
                                                </div>
                                            </div>
                                            <span className="px-2 py-1 bg-green-50 text-green-700 text-xs font-medium rounded">Present</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
            <StudentFormModal
                open={editOpen}
                student={student}
                withPrivate={withPrivate}
                onClose={() => setEditOpen(false)}
                onSaved={() => { setEditOpen(false); fetchData(); }}
            />
            <EnrolModal
                open={enrolOpen}
                studentId={student.id}
                studentName={String(student.name || "")}
                runningCourses={runningCourses}
                alreadyOn={onRosterNow}
                onClose={() => setEnrolOpen(false)}
                onEnrolled={course => { setEnrolOpen(false); alert(`${student.name || "The student"} is now enrolled on ${course.name}.`); fetchData(); }}
            />
        </DashboardLayout>
    );
}

export default function StudentDetailsPage() {
    return (
        <Suspense fallback={<DashboardLayout><div className="flex justify-center items-center h-64"><Loader2 className="animate-spin text-slate-400 w-8 h-8" /></div></DashboardLayout>}>
            <RequirePermission perm="students"><StudentDetailsContent /></RequirePermission>
        </Suspense>
    );
}
