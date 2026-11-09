"use client";

import { RequirePermission } from "@/components/auth/RequirePermission";
import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { db } from '@/lib/firebase';
import { doc, getDoc, collection, query, where, getDocs, setDoc, deleteDoc } from 'firebase/firestore';
import { Course } from '@/lib/types';
import { loadStudentPrivateMap, overlayPrivate } from '@/lib/studentPrivate';
import { courseAttendance, isOneToOne, isRunning, sessionDatesByCourse, studentsOnCourse, teachersOfCourse, StatsData } from '@/lib/stats';
import { isFinishedCourse } from '@/lib/archive';
import { buildRegisterGrid, canEditRegister, cellText, londonToday, longUkDate, REGISTER_ROLES, ukDate } from '@/lib/registers';
import type { RegisterCell } from '@/lib/registers';
import { downloadRegistersExcel } from '@/lib/registerExcel';
import { useAuth } from '@/contexts/AuthContext';
import { ArrowLeft, Loader2, Users, Calendar, CheckSquare, Plus, Trash2, Download, History, Pencil } from 'lucide-react';
import Link from 'next/link';

type Student = { id: string; name: string; refugeeNumber?: string; sovereignReference?: string; [key: string]: any };
type Volunteer = { id: string; name: string; role: string };

function CourseDetailContent() {
    const searchParams = useSearchParams();
    const courseId = searchParams.get("id") as string;
    const { user } = useAuth();

    const [loading, setLoading] = useState(true);
    const [course, setCourse] = useState<Course | null>(null);
    const [students, setStudents] = useState<Student[]>([]);
    const [volunteers, setVolunteers] = useState<Volunteer[]>([]);
    const [attendance, setAttendance] = useState<any[]>([]);
    const [sessions, setSessions] = useState<any[]>([]);
    const [rosterRows, setRosterRows] = useState<any[]>([]);
    const [assignmentRows, setAssignmentRows] = useState<any[]>([]);
    // The register grid also lists students who have left the course (ticked, no longer on the roster)
    // and names teachers who ticked in but are no longer assigned.
    const [gridStudents, setGridStudents] = useState<Student[]>([]);
    const [allUsers, setAllUsers] = useState<any[]>([]);

    // Add User Mngmnt
    const [allStudents, setAllStudents] = useState<Student[]>([]);
    const [allVolunteers, setAllVolunteers] = useState<Volunteer[]>([]);
    const [isAddUserModalOpen, setIsAddUserModalOpen] = useState(false);
    const [userToAdd, setUserToAdd] = useState("");
    const [userTypeToAdd, setUserTypeToAdd] = useState<"student" | "volunteer">("student");

    useEffect(() => {
        if (courseId) {
            fetchCourseDetails();
            fetchAllUsers();
        }
    }, [courseId]);

    const fetchAllUsers = async () => {
        try {
            const sSnap = await getDocs(collection(db, "students"));
            // Archived students and people (30 Sep 2026) cannot be added to a course.
            setAllStudents(sSnap.docs.filter(d => d.data().archived !== true).map(d => ({ id: d.id, name: d.data().name })));

            const vSnap = await getDocs(collection(db, "users"));
            setAllUsers(vSnap.docs.map(d => ({ id: d.id, ...d.data() })));
            setAllVolunteers(vSnap.docs.filter(d => d.data().archived !== true).map(d => ({ id: d.id, name: d.data().name || d.data().displayName || d.data().email, role: d.data().role })));
        } catch (e) { console.error(e); }
    }

    const fetchCourseDetails = async () => {
        try {
            // 1. Fetch Course Info
            const courseDoc = await getDoc(doc(db, "course", courseId));
            if (!courseDoc.exists()) {
                setLoading(false);
                return;
            }
            setCourse({ id: courseDoc.id, ...courseDoc.data() } as Course);

            // 2. Fetch Students
            const rosterQ = query(collection(db, "courseRoster"), where("courseId", "==", courseId));
            const rosterSnap = await getDocs(rosterQ);
            setRosterRows(rosterSnap.docs.map(d => d.data()));
            // A student enrolled from the Students page and again here has two roster rows: list them once.
            const studentIds = [...new Set(rosterSnap.docs.map(d => d.data().studentId).filter(Boolean))] as string[];

            const fetchedStudents: Student[] = [];
            if (studentIds.length > 0) {
                const sDocs = await Promise.all(studentIds.map(id => getDoc(doc(db, "students", id))));
                const privateMap = await loadStudentPrivateMap();
                sDocs.forEach(d => {
                    if (d.exists()) fetchedStudents.push({ id: d.id, ...overlayPrivate(d.data(), privateMap?.get(d.id)) } as Student);
                });
            }
            setStudents(fetchedStudents);

            // 3. Fetch Volunteers
            const assignQ = query(collection(db, "courseAssignments"), where("courseId", "==", courseId));
            const assignSnap = await getDocs(assignQ);
            setAssignmentRows(assignSnap.docs.map(d => d.data()));
            const volIds = [...new Set(assignSnap.docs.map(d => d.data().volunteerId).filter(Boolean))] as string[];

            const fetchedVolunteers: Volunteer[] = [];
            if (volIds.length > 0) {
                const vDocs = await Promise.all(volIds.map(id => getDoc(doc(db, "users", id))));
                vDocs.forEach(d => {
                    if (d.exists()) fetchedVolunteers.push({ id: d.id, ...d.data() } as Volunteer);
                });
            }
            setVolunteers(fetchedVolunteers);

            // 4. Fetch Attendance
            const attQ = query(collection(db, "attendanceRecords"), where("courseId", "==", courseId));
            const attSnap = await getDocs(attQ);
            const attRows = attSnap.docs.map(d => d.data());
            setAttendance(attRows);

            // Students ticked on this course who are no longer on its roster (for the register grid).
            const leftIds = [...new Set(attRows.map(a => a.studentId).filter((id: any) => id && !studentIds.includes(id)))] as string[];
            const leftDocs = await Promise.all(leftIds.map(id => getDoc(doc(db, "students", id)).catch(() => null)));
            setGridStudents([...fetchedStudents, ...leftDocs.filter(d => d && d.exists()).map(d => ({ id: d!.id, ...d!.data() } as Student))]);

            // 5. 1-2-1 courses: the session log replaces attendance.
            if (courseDoc.exists() && isOneToOne(courseDoc.data())) {
                try {
                    const sSnap = await getDocs(query(collection(db, "oneToOneSessions"), where("courseId", "==", courseId)));
                    setSessions(sSnap.docs.map(d => ({ id: d.id, ...d.data() }))
                        .sort((a: any, b: any) => String(b.date).localeCompare(String(a.date))));
                } catch (e) { console.warn("Session log not readable", e); }
            }

        } catch (error) {
            console.error("Error fetching course details:", error);
        } finally {
            setLoading(false);
        }
    };

    const handleAddUser = async () => {
        if (!userToAdd) return;
        try {
            if (userTypeToAdd === "student") {
                const docId = `${courseId}_${userToAdd}`; // composite key
                // The enrolment date matters: attendance before it is not counted against the student.
                await setDoc(doc(db, "courseRoster", docId), { courseId, studentId: userToAdd, enrolledAt: new Date().toISOString() });
            } else {
                const docId = `${courseId}_${userToAdd}`;
                await setDoc(doc(db, "courseAssignments", docId), { courseId, volunteerId: userToAdd, assignedAt: new Date().toISOString() });
            }
            setIsAddUserModalOpen(false);
            setUserToAdd("");
            fetchCourseDetails(); // refresh
        } catch (e) {
            console.error("Error adding user:", e);
        }
    };

    const handleRemoveUser = async (userId: string, type: "student" | "volunteer") => {
        if (!confirm(`Remove this ${type} from the course?`)) return;
        try {
            if (type === "student") {
                const q = query(collection(db, "courseRoster"), where("courseId", "==", courseId), where("studentId", "==", userId));
                const snap = await getDocs(q);
                const deletePromises = snap.docs.map(d => deleteDoc(doc(db, "courseRoster", d.id)));
                await Promise.all(deletePromises);
            } else {
                const q = query(collection(db, "courseAssignments"), where("courseId", "==", courseId), where("volunteerId", "==", userId));
                const snap = await getDocs(q);
                const deletePromises = snap.docs.map(d => deleteDoc(doc(db, "courseAssignments", d.id)));
                await Promise.all(deletePromises);
            }
            fetchCourseDetails(); // refresh
        } catch (e) { console.error("Error removing user:", e); }
    }

    if (loading) {
        return (
            <DashboardLayout>
                <div className="flex justify-center items-center h-64"><Loader2 className="animate-spin text-slate-400 w-8 h-8" /></div>
            </DashboardLayout>
        );
    }

    if (!course) {
        return (
            <DashboardLayout>
                <div className="text-center py-12">
                    <h2 className="text-2xl font-bold text-slate-800">Course not found</h2>
                    <Link href="/admin/courses" className="mt-4 inline-block text-blue-600 hover:underline">Back to Courses</Link>
                </div>
            </DashboardLayout>
        );
    }

    // Shared statistics (src/lib/stats.ts): the same numbers as the course list, Class Reports,
    // the Dashboard and the Funders Report. Students and teachers are the ones that still exist.
    const statsData: StatsData = { courses: [course as any], students, users: volunteers.map(v => ({ ...v })), roster: rosterRows, assignments: assignmentRows, attendance };
    const uniqueDates = sessionDatesByCourse(statsData)[course.id] || [];   // classes held
    const fair = courseAttendance(statsData)[course.id];
    const studentsNow = studentsOnCourse(course.id, statsData).length;       // archived students left out
    const teachersNow = teachersOfCourse(course.id, statsData).length;
    // The full register (src/lib/registers.ts): students x class dates, same spans as the fair rate.
    const grid = buildRegisterGrid(course as any, rosterRows, gridStudents, attendance, allUsers.length ? allUsers : volunteers, assignmentRows);
    const finished = isFinishedCourse(course.status);
    const today = londonToday();
    const registerLink = (date: string) => `/academy/reports?course=${encodeURIComponent(course.id)}&date=${date}`;
    const dateEditable = (date: string) => !finished && canEditRegister(user, date);
    const handleDownload = () => {
        downloadRegistersExcel([{ course: course as any, grid }], `Register ${course.code || course.name || course.id} ${today}`);
    };

    const CELL_STYLE: Record<RegisterCell, string> = {
        present: 'bg-green-100 text-green-700',
        absent: 'bg-red-50 text-red-500 border border-red-100',
        not_enrolled: 'text-slate-300',
        left: 'text-slate-400 italic',
    };
    const CELL_TITLE: Record<RegisterCell, string> = {
        present: 'Present',
        absent: 'Absent',
        not_enrolled: 'Not on the course yet: not counted',
        left: 'No longer on the course: not counted',
    };
    const renderGridCell = (c: RegisterCell) => (
        <span className={`inline-flex min-w-6 h-6 px-1 rounded-full items-center justify-center font-bold text-xs mx-auto ${CELL_STYLE[c]}`} title={CELL_TITLE[c]}>
            {c === 'not_enrolled' ? '' : cellText(c)}
        </span>
    );

    return (
        <DashboardLayout>
            <div className="mb-6">
                <Link href="/admin/courses" className="inline-flex items-center text-slate-500 hover:text-slate-800 mb-4 transition-colors">
                    <ArrowLeft size={16} className="mr-1" /> Back to Courses
                </Link>
                <div className="flex justify-between items-start">
                    <div>
                        <h1 className="text-3xl font-bold text-slate-900">{course.code}: {course.name}</h1>
                        <p className="text-slate-500 mt-1">{course.description}</p>
                    </div>
                    <span className={`px-3 py-1 text-sm font-bold rounded-full ${isRunning(course) ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-600'}`}>{course.status}</span>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-200">
                    <div className="flex items-center gap-3 mb-2 text-slate-500">
                        <Calendar size={20} />
                        <h3 className="font-bold uppercase text-sm">Schedule</h3>
                    </div>
                    <div>
                        <span className="text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded text-xs font-medium mr-2">{course.schedule?.frequency || 'Weekly'}</span>
                        <span className="font-medium text-slate-900">{isOneToOne(course) ? 'Arranged with the person' : `${course.schedule?.day}, ${course.schedule?.start} to ${course.schedule?.end}`}</span>
                    </div>
                    {course.schedule?.frequency === 'Custom' && course.schedule?.customNotes && (
                        <p className="text-sm text-slate-600 mt-2 italic">{course.schedule.customNotes}</p>
                    )}
                    <p className="text-sm text-slate-500 mt-3 border-t border-slate-100 pt-3">{course.startDate} to {course.endDate}</p>
                </div>
                <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-200">
                    <div className="flex items-center gap-3 mb-2 text-slate-500">
                        <Users size={20} />
                        <h3 className="font-bold uppercase text-sm">Enrollment</h3>
                    </div>
                    <p className="font-medium text-slate-900">{studentsNow} Student{studentsNow === 1 ? '' : 's'} on the course now</p>
                    <p className="text-sm text-slate-500 mt-1">{teachersNow} Teacher{teachersNow === 1 ? '' : 's'}/Volunteers</p>
                    {students.length > studentsNow && <p className="text-xs text-slate-400 mt-1">{students.length - studentsNow} archived student{students.length - studentsNow === 1 ? '' : 's'} kept in the history</p>}
                </div>
                <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-200">
                    <div className="flex items-center gap-3 mb-2 text-slate-500">
                        <CheckSquare size={20} />
                        <h3 className="font-bold uppercase text-sm">Sessions</h3>
                    </div>
                    {isOneToOne(course)
                        ? <p className="font-medium text-slate-900">{sessions.length} Sessions, {(sessions.reduce((t, x) => t + (Number(x.durationMinutes) || 0), 0) / 60).toFixed(1)} h</p>
                        : <>
                            <p className="font-medium text-slate-900">{uniqueDates.length} Classes Completed</p>
                            <p className="text-sm text-slate-500 mt-1">
                                Attendance: <strong className="text-slate-800">{fair && fair.rate !== null ? `${fair.rate}%` : 'No data yet'}</strong>
                                {fair && fair.rate !== null && <span className="text-xs text-slate-400"> ({fair.present} present of {fair.expected} expected)</span>}
                            </p>
                        </>}
                </div>
            </div>

            {isOneToOne(course) && (
                <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden mb-8">
                    <div className="p-6 border-b border-slate-200 bg-slate-50">
                        <h2 className="text-xl font-bold text-slate-800">1-2-1 Session Log</h2>
                        <p className="text-sm text-slate-500">Logged by volunteers in the app after each session. There is no attendance for 1-2-1 courses.</p>
                    </div>
                    {sessions.length === 0 ? (
                        <p className="p-6 text-slate-500 text-sm">No sessions logged yet.</p>
                    ) : (
                        <table className="w-full text-sm">
                            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                                <tr><th className="px-4 py-3 text-left">Date</th><th className="px-4 py-3 text-left">Person</th><th className="px-4 py-3 text-left">Volunteer</th><th className="px-4 py-3 text-left">Length</th><th className="px-4 py-3 text-left">Help asked for</th><th className="px-4 py-3 text-left">Notes and next steps</th></tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {sessions.map((x: any) => (
                                    <tr key={x.id} className="align-top">
                                        <td className="px-4 py-3 whitespace-nowrap">{x.date}</td>
                                        <td className="px-4 py-3">{students.find(st => st.id === x.studentId)?.name || x.studentName}</td>
                                        <td className="px-4 py-3">{x.volunteerName}</td>
                                        <td className="px-4 py-3 whitespace-nowrap">{x.durationMinutes} min</td>
                                        <td className="px-4 py-3">{x.topic}</td>
                                        <td className="px-4 py-3">{x.notes}{x.followUp && <p className="text-amber-700 mt-1"><strong>Next steps:</strong> {x.followUp}</p>}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            )}

            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden mb-8">
                <div className="p-6 border-b border-slate-200 flex justify-between items-center bg-slate-50">
                    <h2 className="text-xl font-bold text-slate-800">Roster</h2>
                    <button
                        onClick={() => setIsAddUserModalOpen(true)}
                        className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
                    >
                        <Plus size={16} /> Enroll User
                    </button>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left">
                        <thead className="bg-slate-100 text-slate-600 uppercase text-xs">
                            <tr>
                                <th className="px-6 py-4 font-bold border-b border-slate-200">Name</th>
                                <th className="px-6 py-4 font-bold border-b border-slate-200">Role</th>
                                <th className="px-6 py-4 font-bold border-b border-slate-200">Refugee #</th>
                                <th className="px-6 py-4 font-bold border-b border-slate-200">SH Reference</th>
                                <th className="px-6 py-4 font-bold border-b border-slate-200 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {volunteers.map(v => (
                                <tr key={v.id} className="border-b border-slate-100 hover:bg-slate-50 bg-blue-50/10">
                                    <td className="px-6 py-3 font-medium text-slate-900 flex items-center gap-2">
                                        <Link href={`/admin/volunteers/detail?id=${v.id}`} className="text-blue-700 hover:text-blue-900 hover:underline transition-colors">
                                            {v.name}
                                        </Link>
                                        {(v as any).archived === true && <span className="ml-2 text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 uppercase">Archived</span>}
                                    </td>
                                    <td className="px-6 py-3 text-slate-500 capitalize">{v.role?.replace('_', ' ') || 'Volunteer'}</td>
                                    <td className="px-6 py-3 text-slate-500">—</td>
                                    <td className="px-6 py-3 text-slate-500">—</td>
                                    <td className="px-6 py-3 text-right">
                                        <button onClick={() => handleRemoveUser(v.id, "volunteer")} className="text-red-500 hover:text-red-700"><Trash2 size={16} className="inline" /></button>
                                    </td>
                                </tr>
                            ))}
                            {students.map(s => (
                                <tr key={s.id} className="border-b border-slate-50 hover:bg-slate-50">
                                    <td className="px-6 py-3 font-medium text-slate-900">
                                        <Link href={`/admin/students/detail?id=${s.id}`} className="text-blue-700 hover:text-blue-900 hover:underline transition-colors">
                                            {s.name}
                                        </Link>
                                        {s.archived === true && <span className="ml-2 text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 uppercase">Archived</span>}
                                    </td>
                                    <td className="px-6 py-3 text-slate-500">Student</td>
                                    <td className="px-6 py-3 text-slate-500 font-mono text-xs">{s.refugeeNumber || '—'}</td>
                                    <td className="px-6 py-3 text-slate-500 font-mono text-xs">{s.sovereignReference || '—'}</td>
                                    <td className="px-6 py-3 text-right">
                                        <button onClick={() => handleRemoveUser(s.id, "student")} className="text-red-500 hover:text-red-700"><Trash2 size={16} className="inline" /></button>
                                    </td>
                                </tr>
                            ))}
                            {students.length === 0 && volunteers.length === 0 && (
                                <tr>
                                    <td colSpan={5} className="px-6 py-8 text-center text-slate-400 italic">No students or volunteers enrolled.</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {(!isOneToOne(course) || grid.dates.length > 0) && (
                <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden mb-8">
                    <div className="p-6 border-b border-slate-200 flex flex-wrap gap-3 justify-between items-center bg-slate-50">
                        <div>
                            <h2 className="text-xl font-bold text-slate-800">Register</h2>
                            <p className="text-sm text-slate-500">
                                {grid.dates.length} class{grid.dates.length === 1 ? '' : 'es'} held. Attendance: <strong className="text-slate-800">{grid.fair && grid.fair.rate !== null ? `${grid.fair.rate}%` : 'no data yet'}</strong>
                                {grid.fair && grid.fair.rate !== null && <span className="text-xs text-slate-400"> ({grid.fair.present} present of {grid.fair.expected} expected)</span>}
                            </p>
                        </div>
                        <div className="flex gap-2">
                            {!finished && canEditRegister(user, today) && (
                                <Link href={registerLink(today)} className="bg-[#2c4a00] hover:bg-[#1e3300] text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors">
                                    <Pencil size={16} /> Today&apos;s register
                                </Link>
                            )}
                            <button
                                onClick={handleDownload}
                                disabled={grid.dates.length === 0 && grid.students.length === 0}
                                className="bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors disabled:opacity-50"
                            >
                                <Download size={16} /> Download Excel
                            </button>
                        </div>
                    </div>
                    {finished && (
                        <div className="px-6 py-3 bg-amber-50 border-b border-amber-200 text-sm text-amber-800 flex items-center gap-2">
                            <History size={16} /> Historic register (course {String(course.status || '').toLowerCase() === 'cancelled' ? 'cancelled' : 'completed'}). It can no longer be changed here.
                        </div>
                    )}
                    {grid.dates.length === 0 ? (
                        <p className="p-6 text-slate-400 italic text-sm">No attendance recorded yet.</p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm text-left">
                                <thead className="bg-slate-100 text-slate-600 uppercase text-xs">
                                    <tr>
                                        <th className="px-6 py-4 font-bold border-b border-slate-200 sticky left-0 bg-slate-100">Name</th>
                                        {grid.dates.map(date => (
                                            <th key={date} className="px-3 py-4 font-bold border-b border-slate-200 text-center whitespace-nowrap" title={longUkDate(date, true)}>
                                                {dateEditable(date)
                                                    ? <Link href={registerLink(date)} className="text-blue-700 hover:underline" title="Open this register in Class Reports">{ukDate(date).slice(0, 5)}</Link>
                                                    : <span>{ukDate(date).slice(0, 5)}</span>}
                                                <div className="text-[10px] font-normal text-slate-400">{date.slice(0, 4)}</div>
                                            </th>
                                        ))}
                                        <th className="px-4 py-4 font-bold border-b border-slate-200 text-center">Attended</th>
                                        <th className="px-4 py-4 font-bold border-b border-slate-200 text-center">Expected</th>
                                        <th className="px-4 py-4 font-bold border-b border-slate-200 text-center">%</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {grid.students.map(s => (
                                        <tr key={s.id} className="border-b border-slate-50 hover:bg-slate-50">
                                            <td className="px-6 py-3 font-medium text-slate-900 whitespace-nowrap sticky left-0 bg-white">
                                                {s.name}
                                                {s.archived && <span className="ml-2 text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 uppercase">Archived</span>}
                                                {!s.onRoster && <span className="ml-2 text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 uppercase">Left</span>}
                                            </td>
                                            {s.cells.map((c, i) => (
                                                <td key={grid.dates[i]} className="px-3 py-3 text-center">{renderGridCell(c)}</td>
                                            ))}
                                            <td className="px-4 py-3 text-center">{s.attended}</td>
                                            <td className="px-4 py-3 text-center">{s.expected}</td>
                                            <td className="px-4 py-3 text-center font-medium">{s.rate === null ? '' : `${s.rate}%`}</td>
                                        </tr>
                                    ))}
                                    <tr className="border-b border-slate-200 bg-slate-50 font-medium">
                                        <td className="px-6 py-3 text-slate-600 sticky left-0 bg-slate-50">Students present</td>
                                        {grid.presentByDate.map((n, i) => (
                                            <td key={grid.dates[i]} className="px-3 py-3 text-center text-slate-700" title={grid.heldOnlyDates.includes(grid.dates[i]) ? 'Class held, nobody came' : undefined}>
                                                {n}{grid.heldOnlyDates.includes(grid.dates[i]) && n === 0 ? '*' : ''}
                                            </td>
                                        ))}
                                        <td colSpan={3}></td>
                                    </tr>
                                    {grid.teachers.map(t => (
                                        <tr key={t.id} className="border-b border-slate-100 bg-blue-50/10">
                                            <td className="px-6 py-3 text-slate-700 whitespace-nowrap sticky left-0 bg-white">
                                                {t.name} <span className="text-xs text-slate-400">(teacher)</span>
                                            </td>
                                            {t.present.map((p, i) => (
                                                <td key={grid.dates[i]} className="px-3 py-3 text-center">{p ? renderGridCell('present') : ''}</td>
                                            ))}
                                            <td className="px-4 py-3 text-center">{t.classes}</td>
                                            <td colSpan={2}></td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            <p className="px-6 py-3 text-xs text-slate-500">
                                P present, A absent, blank not on the course yet, left no longer on the course. Blank and left are not counted.
                                {grid.heldOnlyDates.length > 0 && ' * class held, nobody came.'}
                                {grid.unlistedStudents > 0 && ` ${grid.unlistedStudents} ticked student${grid.unlistedStudents === 1 ? '' : 's'} whose record was deleted ${grid.unlistedStudents === 1 ? 'is' : 'are'} counted in the rate but not listed.`}
                                {!finished && ' Registers can be changed only on the day of the class, in Class Reports. After that, ask Franco (super admin).'}
                            </p>
                        </div>
                    )}
                </div>
            )}

            {/* Add User Modal */}
            {isAddUserModalOpen && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
                        <h2 className="text-xl font-bold mb-4">Enroll User</h2>
                        <div className="mb-4">
                            <label className="block text-sm font-medium mb-1">Role</label>
                            <select
                                className="w-full p-2 border rounded"
                                value={userTypeToAdd}
                                onChange={(e) => { setUserTypeToAdd(e.target.value as "student" | "volunteer"); setUserToAdd(""); }}
                            >
                                <option value="student">Student</option>
                                <option value="volunteer">Volunteer/Teacher</option>
                            </select>
                        </div>
                        <div className="mb-6">
                            <label className="block text-sm font-medium mb-1">Select Person</label>
                            <select
                                className="w-full p-2 border rounded"
                                value={userToAdd}
                                onChange={(e) => setUserToAdd(e.target.value)}
                            >
                                <option value="">Select</option>
                                {userTypeToAdd === "student" ? (
                                    allStudents.filter(s => !students.find(es => es.id === s.id)).map(s => (
                                        <option key={s.id} value={s.id}>{s.name}</option>
                                    ))
                                ) : (
                                    // Anyone who can take a register can teach (30 Sep 2026): volunteers, staff, admins and the super admin. Archived people are already left out.
                                    allVolunteers.filter(v => REGISTER_ROLES.includes(String(v.role || '')) && !volunteers.find(ev => ev.id === v.id)).map(v => (
                                        <option key={v.id} value={v.id}>{v.name}{v.role && v.role !== 'volunteer' ? ` (${v.role.replace('_', ' ')})` : ''}</option>
                                    ))
                                )}
                            </select>
                        </div>
                        <div className="flex justify-end gap-2">
                            <button onClick={() => setIsAddUserModalOpen(false)} className="px-4 py-2 font-medium text-slate-600 hover:bg-slate-100 rounded">Cancel</button>
                            <button onClick={handleAddUser} disabled={!userToAdd} className="px-4 py-2 bg-blue-600 text-white rounded font-medium disabled:opacity-50">Enroll</button>
                        </div>
                    </div>
                </div>
            )}
        </DashboardLayout>
    );
}

export default function CourseDetailPage() {
    return (
        <Suspense fallback={<DashboardLayout><div className="flex justify-center items-center h-64"><Loader2 className="animate-spin text-slate-400 w-8 h-8" /></div></DashboardLayout>}>
            <RequirePermission perm="courses"><CourseDetailContent /></RequirePermission>
        </Suspense>
    );
}
