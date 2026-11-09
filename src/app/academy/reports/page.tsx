"use client";

import { RequirePermission } from "@/components/auth/RequirePermission";
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/lib/firebase';
import { collection, getDocs, query, where, doc, getDoc, addDoc, updateDoc, deleteDoc, writeBatch, Timestamp } from 'firebase/firestore';
import {
    CheckSquare,
    FileText,
    Calendar,
    ChevronDown,
    Loader2,
    Send,
    RotateCcw,
    AlertCircle,
    Pencil,
    Trash2,
    X
} from 'lucide-react';
import { courseAttendance, sessionsByCourse, studentsOnCourse, teachersOfCourse, StatsData } from "@/lib/stats";
import { canEditRegister, canEditReport, canTakeRegister, londonToday, longUkDate, personName, ukWhatsAppNumber } from "@/lib/registers";

type Course = {
    id: string;
    code?: string;
    name: string;
    status?: string;
    schedule?: { day: string; start: string; end: string };
};

type Student = {
    id: string;
    name: string;
    archived?: boolean;
    parentPhone?: string;
    parentName?: string;
};

type Person = {
    id: string;
    name: string;
    role?: string;
    archived?: boolean;
};

type AttRecord = { id: string; courseId?: string; date?: string; studentId?: string; userId?: string; held?: boolean; [k: string]: any };
type ClassReport = { id: string; courseId?: string; volunteerId?: string; date?: string; topicsCovered?: string; studentProgress?: string; issues?: string; submittedAt?: any; [k: string]: any };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const sKey = (id: string) => `s:${id}`;
const tKey = (id: string) => `t:${id}`;
/** The person key of a record ('' for a "class held, nobody came" marker). */
const recKey = (r: AttRecord) => (r.studentId ? sKey(r.studentId) : r.userId ? tKey(r.userId) : '');
const millis = (v: any): number => (v && typeof v.toMillis === 'function' ? v.toMillis() : v && typeof v.seconds === 'number' ? v.seconds * 1000 : 0);

function ClassReportsPageContent() {
    const { user } = useAuth();
    const params = useSearchParams();
    const [loading, setLoading] = useState(true);
    const [courses, setCourses] = useState<Course[]>([]);
    // Course and date can be preselected from the course page: ?course=<id>&date=<YYYY-MM-DD>
    const [selectedCourseId, setSelectedCourseId] = useState<string>(() => params.get('course') || '');
    const [activeTab, setActiveTab] = useState<'attendance' | 'report' | 'history'>('attendance');

    const [attRecords, setAttRecords] = useState<AttRecord[]>([]);
    const [studentsById, setStudentsById] = useState<Record<string, Student>>({});
    const [rosterIds, setRosterIds] = useState<string[]>([]);
    const [teachers, setTeachers] = useState<Person[]>([]);
    const [peopleById, setPeopleById] = useState<Record<string, Person>>({});
    const [reports, setReports] = useState<ClassReport[]>([]);
    const [loadingData, setLoadingData] = useState(false);
    const [loadError, setLoadError] = useState('');
    // Course figures from src/lib/stats.ts (30 Sep 2026): the same numbers as the course pages.
    const [figures, setFigures] = useState<{ sessions: number; rate: number | null; present: number; expected: number; enrolled: number; teachers: number }>({ sessions: 0, rate: null, present: 0, expected: 0, enrolled: 0, teachers: 0 });

    // Register of the selected date
    const [ticks, setTicks] = useState<Set<string>>(new Set());
    const [editing, setEditing] = useState(false);
    const [saving, setSaving] = useState(false);

    // Report form (the date is the class date, UK time, unless chosen)
    const [reportDate, setReportDate] = useState(() => { const d = params.get('date') || ''; return DAY_RE.test(d) ? d : londonToday(); });
    const [topics, setTopics] = useState('');
    const [progress, setProgress] = useState('');
    const [issues, setIssues] = useState('');
    const [submittingReport, setSubmittingReport] = useState(false);

    // Editing an existing report
    const [editReportId, setEditReportId] = useState<string | null>(null);
    const [editTopics, setEditTopics] = useState('');
    const [editProgress, setEditProgress] = useState('');
    const [editIssues, setEditIssues] = useState('');

    useEffect(() => {
        if (user) { fetchCourses(); fetchPeople(); }
    }, [user]);

    useEffect(() => {
        setEditing(false);
        if (selectedCourseId) {
            fetchCourseData(selectedCourseId);
            fetchReports(selectedCourseId);
        } else {
            setAttRecords([]);
            setRosterIds([]);
            setTeachers([]);
            setReports([]);
        }
    }, [selectedCourseId, reportDate]); // refetch on a new date too: someone may have added a late tick

    const course = courses.find(c => c.id === selectedCourseId);
    const dayRecords = useMemo(() => attRecords.filter(r => r.date === reportDate), [attRecords, reportDate]);
    const dayKeys = useMemo(() => new Set(dayRecords.map(recKey).filter(Boolean)), [dayRecords]);
    const registerExists = dayRecords.length > 0;
    const nobodyCame = registerExists && dayKeys.size === 0;
    const mayEdit = canEditRegister(user, reportDate);
    const mayTake = canTakeRegister(user);
    const isSuper = user?.role === 'super_admin';

    // The ticks shown start from what is saved for this date.
    useEffect(() => { setTicks(new Set(dayKeys)); }, [dayKeys]);

    // People on the register of this date: the roster and the assigned teachers, plus anyone
    // already ticked that day (so a tick can be removed even if they have left the course).
    const dayStudents: Student[] = useMemo(() => {
        const ids = new Set<string>(rosterIds.filter(id => studentsById[id] && studentsById[id].archived !== true));
        dayRecords.forEach(r => { if (r.studentId && studentsById[r.studentId]) ids.add(r.studentId); });
        return [...ids].map(id => studentsById[id]).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'en-GB'));
    }, [rosterIds, studentsById, dayRecords]);
    const dayTeachers: Person[] = useMemo(() => {
        const list = [...teachers];
        dayRecords.forEach(r => {
            if (r.userId && !list.find(t => t.id === r.userId)) list.push(peopleById[r.userId] || { id: r.userId, name: 'Unknown person' });
        });
        return list.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'en-GB'));
    }, [teachers, dayRecords, peopleById]);

    const fetchPeople = async () => {
        try {
            const snap = await getDocs(collection(db, "users"));
            const map: Record<string, Person> = {};
            snap.docs.forEach(d => { const u = d.data(); map[d.id] = { id: d.id, name: personName(u) || 'Unknown person', role: u.role, archived: u.archived === true }; });
            setPeopleById(map);
        } catch (e) {
            console.warn("Could not read the list of people (names of report authors)", e);
        }
    };

    const fetchReports = async (courseId: string) => {
        try {
            // Every report is kept, several per day allowed. Sorted here (newest first), so no index is needed.
            const snap = await getDocs(query(collection(db, "classRecords"), where("courseId", "==", courseId)));
            const list = snap.docs.map(d => ({ id: d.id, ...d.data() } as ClassReport));
            list.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || millis(b.submittedAt) - millis(a.submittedAt));
            setReports(list);
        } catch (e) {
            console.error("Error fetching reports:", e);
            setReports([]);
        }
    };

    const fetchCourses = async () => {
        try {
            const coursesSnap = await getDocs(collection(db, "course"));
            const allCourses = coursesSnap.docs.map(d => ({ id: d.id, ...d.data() } as Course));

            // Sort locally to ensure courses without a 'code' field aren't dropped from the UI.
            allCourses.sort((a, b) => {
                const codeA = a.code || '';
                const codeB = b.code || '';
                if (codeA !== codeB) {
                    return codeA.localeCompare(codeB);
                }
                return (a.name || '').localeCompare(b.name || '');
            });

            setCourses(allCourses);
        } catch (e) {
            console.error("Error loading courses:", e);
        } finally {
            setLoading(false);
        }
    };

    const fetchCourseData = async (courseId: string) => {
        setLoadingData(true);
        setLoadError('');
        try {
            // 1. Registers of the course (every date)
            const attSnap = await getDocs(query(collection(db, "attendanceRecords"), where("courseId", "==", courseId)));
            const records = attSnap.docs.map(d => ({ id: d.id, ...d.data() } as AttRecord));

            // 2. Roster. A student with two roster rows is listed once.
            const rosterSnap = await getDocs(query(collection(db, "courseRoster"), where("courseId", "==", courseId)));
            const rosterStudentIds = [...new Set(rosterSnap.docs.map(d => d.data().studentId).filter(Boolean))] as string[];

            // Student records: the roster plus anyone ticked on this course.
            const allIds = new Set<string>(rosterStudentIds);
            records.forEach(r => { if (r.studentId) allIds.add(r.studentId); });
            const byId: Record<string, Student> = {};
            const sDocs = await Promise.all([...allIds].map(id => getDoc(doc(db, "students", id)).catch(() => null)));
            sDocs.forEach(d => { if (d && d.exists()) byId[d.id] = { id: d.id, ...d.data() } as Student; });

            // 3. Teachers: everyone assigned, any role (admins too); archived people are left out.
            const assignSnap = await getDocs(query(collection(db, "courseAssignments"), where("courseId", "==", courseId)));
            const volIds = [...new Set(assignSnap.docs.map(d => d.data().volunteerId).filter(Boolean))] as string[];
            const users: any[] = [];
            const assigned: Person[] = [];
            const vDocs = await Promise.all(volIds.map(id => getDoc(doc(db, "users", id)).catch(() => null)));
            vDocs.forEach(d => {
                if (d && d.exists()) {
                    const data = d.data();
                    users.push({ id: d.id, ...data });
                    if (data.archived !== true) assigned.push({ id: d.id, name: personName(data) || 'Unknown person', role: data.role });
                }
            });

            setAttRecords(records);
            setStudentsById(byId);
            setRosterIds(rosterStudentIds.filter(id => !!byId[id]));
            setTeachers(assigned);

            const rosterStudents = rosterStudentIds.map(id => byId[id]).filter(Boolean);
            const statsData: StatsData = {
                courses: [{ id: courseId, ...(courses.find(c => c.id === courseId) || {}) }],
                students: rosterStudents, users,
                roster: rosterSnap.docs.map(d => d.data()),
                assignments: assignSnap.docs.map(d => d.data()),
                attendance: records,
            };
            const fair = courseAttendance(statsData)[courseId];
            setFigures({
                sessions: sessionsByCourse(statsData)[courseId] || 0,
                rate: fair ? fair.rate : null,
                present: fair ? fair.present : 0,
                expected: fair ? fair.expected : 0,
                enrolled: studentsOnCourse(courseId, statsData).length,
                teachers: teachersOfCourse(courseId, statsData).length,
            });
        } catch (e) {
            console.error("Error fetching course data:", e);
            setLoadError('Could not load the register of this course. Please try again.');
        } finally {
            setLoadingData(false);
        }
    };

    const toggle = (key: string) => setTicks(prev => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
    });

    /**
     * Saves the register of the selected date as ticked. New ticks become records; an
     * unticked person loses ALL their records of that day (duplicates included). Nobody
     * ticked means "class held, nobody came": one marker record.
     */
    const handleSaveRegister = async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (!selectedCourseId || !user) return;
        const final = new Set(ticks);
        const toAdd = [...final].filter(k => !dayKeys.has(k));
        const toRemove = [...dayKeys].filter(k => !final.has(k));
        const markers = dayRecords.filter(r => !recKey(r));
        if (registerExists && !mayEdit && (toRemove.length > 0 || final.size === 0)) {
            alert("Registers can be changed only on the day of the class. After that, ask Franco (super admin).");
            return;
        }

        const batch = writeBatch(db);
        let changes = 0;
        if (final.size === 0) {
            if (!confirm("Nobody came to this class?")) return;
            if (nobodyCame) { setEditing(false); return; } // already recorded
            dayRecords.forEach(r => { batch.delete(doc(db, "attendanceRecords", r.id)); changes++; });
            batch.set(doc(collection(db, "attendanceRecords")), {
                courseId: selectedCourseId, date: reportDate, held: true, markedBy: user.uid, timestamp: Timestamp.now(),
            });
            changes++;
        } else {
            toRemove.forEach(k => dayRecords.filter(r => recKey(r) === k).forEach(r => { batch.delete(doc(db, "attendanceRecords", r.id)); changes++; }));
            // Someone came after all: the "nobody came" marker no longer applies.
            if (toAdd.length > 0 && mayEdit) markers.forEach(r => { batch.delete(doc(db, "attendanceRecords", r.id)); changes++; });
            toAdd.forEach(k => {
                const data: Record<string, any> = { courseId: selectedCourseId, date: reportDate, timestamp: Timestamp.now() };
                if (k.startsWith('s:')) data.studentId = k.slice(2); else data.userId = k.slice(2);
                batch.set(doc(collection(db, "attendanceRecords")), data);
                changes++;
            });
        }
        if (changes === 0) { setEditing(false); return; }

        setSaving(true);
        try {
            await batch.commit();
            setEditing(false);
            await fetchCourseData(selectedCourseId);
            alert(registerExists ? "Register updated." : "Register saved.");
        } catch (err) {
            console.error("Error saving register:", err);
            alert("The register could not be saved. Registers can be changed only on the day of the class; after that, ask Franco (super admin).");
        } finally {
            setSaving(false);
        }
    };

    // Super admin only: deletes every record of the day (ticks and marker).
    const handleResetDay = async () => {
        if (!isSuper || !registerExists) return;
        const label = `${course?.code ? course.code + ' ' : ''}${course?.name || 'this course'}`;
        const n = dayRecords.length;
        if (!confirm(`Delete the whole register of ${label} for ${longUkDate(reportDate, true)}?\n\n${n} record${n === 1 ? '' : 's'} will be deleted. This cannot be undone.`)) return;
        if (prompt(`To confirm, type DELETE`) !== 'DELETE') return;
        setSaving(true);
        try {
            const batch = writeBatch(db);
            dayRecords.forEach(r => batch.delete(doc(db, "attendanceRecords", r.id)));
            await batch.commit();
            setEditing(false);
            await fetchCourseData(selectedCourseId);
            alert("The register of this day was deleted.");
        } catch (err) {
            console.error("Reset failed:", err);
            alert("The register could not be deleted.");
        } finally {
            setSaving(false);
        }
    };

    const handleSubmitReport = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedCourseId) return;
        setSubmittingReport(true);
        try {
            await addDoc(collection(db, "classRecords"), {
                courseId: selectedCourseId,
                volunteerId: user?.uid,
                date: reportDate,
                topicsCovered: topics,
                studentProgress: progress,
                issues: issues,
                submittedAt: Timestamp.now()
            });
            alert("Class report submitted successfully!");
            setTopics('');
            setProgress('');
            setIssues('');
            await fetchReports(selectedCourseId);
        } catch (e) {
            console.error("Report submission failed:", e);
            alert("Failed to submit report.");
        } finally {
            setSubmittingReport(false);
        }
    };

    const startEditReport = (r: ClassReport) => {
        setEditReportId(r.id);
        setEditTopics(r.topicsCovered || '');
        setEditProgress(r.studentProgress || '');
        setEditIssues(r.issues || '');
    };

    const handleSaveReportEdit = async (r: ClassReport) => {
        if (!canEditReport(user, r)) return;
        setSubmittingReport(true);
        try {
            // volunteerId and date stay as they are (the rules check this).
            await updateDoc(doc(db, "classRecords", r.id), {
                topicsCovered: editTopics, studentProgress: editProgress, issues: editIssues,
                editedAt: Timestamp.now(), editedBy: user?.uid || '',
            });
            setEditReportId(null);
            await fetchReports(selectedCourseId);
        } catch (e) {
            console.error("Report edit failed:", e);
            alert("The report could not be changed. The author can change a report only on the day of the class.");
        } finally {
            setSubmittingReport(false);
        }
    };

    const handleDeleteReport = async (r: ClassReport) => {
        if (!isSuper) return;
        const author = peopleById[r.volunteerId || '']?.name || 'unknown author';
        if (!confirm(`Delete this class report by ${author} for ${r.date ? longUkDate(r.date, true) : 'an unknown date'}?\n\nThis cannot be undone.`)) return;
        try {
            await deleteDoc(doc(db, "classRecords", r.id));
            await fetchReports(selectedCourseId);
        } catch (e) {
            console.error("Report delete failed:", e);
            alert("The report could not be deleted.");
        }
    };

    const handleNotifyParent = (student: Student, number: string) => {
        const text = `Hello ${student.parentName || 'Parent'}, we noticed ${student.name} missed the ${course?.name || ''} class on ${longUkDate(reportDate)}. Please let us know if everything is okay.`;
        window.open(`https://wa.me/${number}?text=${encodeURIComponent(text)}`, '_blank');
    };

    // History: every date with a register or a report, newest first, reports newest first within a day.
    const history = useMemo(() => {
        const dates = new Set<string>();
        attRecords.forEach(r => { if (r.date) dates.add(r.date); });
        reports.forEach(r => { if (r.date) dates.add(r.date); });
        return [...dates].sort().reverse().map(date => {
            const recs = attRecords.filter(r => r.date === date);
            const studentsPresent = new Set(recs.filter(r => r.studentId).map(r => r.studentId)).size;
            return { date, hasRegister: recs.length > 0, nobodyCame: recs.length > 0 && recs.every(r => !recKey(r)), studentsPresent, reports: reports.filter(r => r.date === date) };
        });
    }, [attRecords, reports]);

    if (loading) return <div className="p-8 flex justify-center"><Loader2 className="animate-spin" /></div>;

    const readOnlyNote = "Registers can be changed only on the day of the class. After that, ask Franco (super admin).";

    const checklist = (
        <div className="space-y-6">
            <div>
                <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-2">Teachers</h3>
                {dayTeachers.length > 0 ? (
                    <div className="grid gap-2">
                        {dayTeachers.map(v => (
                            <label key={v.id} className="flex items-center p-3 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer transition-colors">
                                <input type="checkbox" checked={ticks.has(tKey(v.id))} onChange={() => toggle(tKey(v.id))} className="h-4 w-4 text-[#2c4a00] rounded focus:ring-[#2c4a00]" />
                                <span className="ml-3 font-medium text-slate-700">{v.name}</span>
                            </label>
                        ))}
                    </div>
                ) : (
                    <p className="text-sm text-slate-400 italic">No teachers assigned to this course.</p>
                )}
            </div>
            <div>
                <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-2">Students</h3>
                {dayStudents.length > 0 ? (
                    <div className="grid gap-2">
                        {dayStudents.map(s => (
                            <label key={s.id} className="flex items-center p-3 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer transition-colors">
                                <input type="checkbox" checked={ticks.has(sKey(s.id))} onChange={() => toggle(sKey(s.id))} className="h-4 w-4 text-[#2c4a00] rounded focus:ring-[#2c4a00]" />
                                <span className="ml-3 font-medium text-slate-700">{s.name}</span>
                                {!rosterIds.includes(s.id) && <span className="ml-2 text-xs text-slate-400">(no longer on the course)</span>}
                            </label>
                        ))}
                    </div>
                ) : (
                    <p className="text-sm text-slate-400 italic">No students enrolled in this course.</p>
                )}
            </div>
        </div>
    );

    return (
        <div className="p-6 max-w-5xl mx-auto">
            <h1 className="text-3xl font-bold mb-6 text-slate-900">Class Reports</h1>

            {/* Controls */}
            <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 mb-6 flex flex-col md:flex-row gap-4 items-end">
                <div className="flex-1 w-full">
                    <label className="block text-sm font-medium text-slate-700 mb-1">Select Course</label>
                    <div className="relative">
                        <select
                            className="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-lg appearance-none"
                            value={selectedCourseId}
                            onChange={(e) => setSelectedCourseId(e.target.value)}
                        >
                            <option value="">Choose a course</option>
                            {courses.map(c => {
                                let label = c.code ? `${c.code}: ${c.name}` : c.name;
                                if (c.schedule?.day && c.schedule?.start && c.schedule?.end) {
                                    const formatTime = (t: string) => t.replace(':', '.');
                                    const shortDay = c.schedule.day.substring(0, 3);
                                    label += ` (${shortDay} ${formatTime(c.schedule.start)} to ${formatTime(c.schedule.end)} hrs)`;
                                }
                                return (
                                    <option key={c.id} value={c.id}>{label}</option>
                                );
                            })}
                        </select>
                        <ChevronDown className="absolute right-3 top-3 h-4 w-4 text-slate-400 pointer-events-none" />
                    </div>
                </div>
                <div className="w-full md:w-auto">
                    <label className="block text-sm font-medium text-slate-700 mb-1">Date</label>
                    <input
                        type="date"
                        value={reportDate}
                        onChange={(e) => { if (DAY_RE.test(e.target.value)) setReportDate(e.target.value); }}
                        className="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-lg"
                    />
                </div>
            </div>

            {selectedCourseId ? (
                <>
                    {/* Course Stats Summary */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200">
                            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Total Sessions</h3>
                            <p className="text-2xl font-bold text-slate-900">{figures.sessions}</p>
                            <span className="text-xs text-slate-500">days a register was taken</span>
                        </div>
                        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200">
                            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Avg Attendance</h3>
                            <p className="text-2xl font-bold text-slate-900">
                                {figures.rate === null ? 'No data' : `${figures.rate}%`}
                            </p>
                            <span className="text-xs text-slate-500">{figures.rate === null ? 'no registers yet' : `${figures.present} present of ${figures.expected} expected`}</span>
                        </div>
                        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200">
                            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Enrolled</h3>
                            <p className="text-2xl font-bold text-slate-900">{figures.enrolled}</p>
                        </div>
                        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200">
                            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Teachers</h3>
                            <p className="text-2xl font-bold text-slate-900">{figures.teachers}</p>
                        </div>
                    </div>

                    {/* Tabs */}
                    <div className="flex border-b border-slate-200 mb-6">
                        <button
                            onClick={() => setActiveTab('attendance')}
                            className={`px-6 py-3 text-sm font-medium flex items-center gap-2 border-b-2 transition-colors ${activeTab === 'attendance' ? 'border-[#2c4a00] text-[#2c4a00]' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
                        >
                            <CheckSquare size={16} />
                            Attendance
                        </button>
                        <button
                            onClick={() => setActiveTab('report')}
                            className={`px-6 py-3 text-sm font-medium flex items-center gap-2 border-b-2 transition-colors ${activeTab === 'report' ? 'border-[#2c4a00] text-[#2c4a00]' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
                        >
                            <FileText size={16} />
                            Class Report
                        </button>
                        <button
                            onClick={() => setActiveTab('history')}
                            className={`px-6 py-3 text-sm font-medium flex items-center gap-2 border-b-2 transition-colors ${activeTab === 'history' ? 'border-[#2c4a00] text-[#2c4a00]' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
                        >
                            <Calendar size={16} />
                            History
                        </button>
                    </div>

                    {loadingData ? (
                        <div className="py-12 flex justify-center text-slate-400"><Loader2 className="animate-spin mr-2" /> Loading data...</div>
                    ) : loadError ? (
                        <div className="p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2"><AlertCircle size={16} /> {loadError}</div>
                    ) : (
                        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">

                            {/* Attendance Tab */}
                            {activeTab === 'attendance' && (
                                <div>
                                    <div className="flex justify-between items-center mb-4">
                                        <div>
                                            <h2 className="text-lg font-bold">Register</h2>
                                            <p className="text-sm text-slate-500">{longUkDate(reportDate, true)}</p>
                                        </div>
                                        {registerExists && !editing && (
                                            <span className="bg-green-100 text-green-800 text-xs font-bold px-3 py-1 rounded-full">Submitted</span>
                                        )}
                                        {editing && (
                                            <span className="bg-amber-100 text-amber-800 text-xs font-bold px-3 py-1 rounded-full">Editing</span>
                                        )}
                                    </div>

                                    {!registerExists ? (
                                        mayTake ? (
                                            <form onSubmit={handleSaveRegister}>
                                                {reportDate !== londonToday() && (
                                                    <div className="mb-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
                                                        This register is for a date other than today. Once it is saved, only Franco (super admin) can change it.
                                                    </div>
                                                )}
                                                {checklist}
                                                <button
                                                    type="submit"
                                                    disabled={saving}
                                                    className="mt-6 w-full bg-[#2c4a00] hover:bg-[#1e3300] text-white font-bold py-3 px-4 rounded-lg shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                                >
                                                    {saving ? 'Submitting...' : 'Submit Attendance'}
                                                </button>
                                            </form>
                                        ) : (
                                            <p className="text-sm text-slate-500 italic">No register has been taken for this date. Your role cannot take registers.</p>
                                        )
                                    ) : editing ? (
                                        <form onSubmit={handleSaveRegister}>
                                            <p className="mb-4 text-sm text-slate-600">Tick everyone who came. Unticking someone removes their attendance for this date.</p>
                                            {checklist}
                                            <div className="mt-6 flex gap-3">
                                                <button
                                                    type="submit"
                                                    disabled={saving}
                                                    className="flex-1 bg-[#2c4a00] hover:bg-[#1e3300] text-white font-bold py-3 px-4 rounded-lg shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                                >
                                                    {saving ? 'Saving...' : 'Save register'}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => { setTicks(new Set(dayKeys)); setEditing(false); }}
                                                    disabled={saving}
                                                    className="px-4 py-3 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 font-medium flex items-center gap-2"
                                                >
                                                    <X size={16} /> Cancel
                                                </button>
                                            </div>
                                        </form>
                                    ) : (
                                        <div className="space-y-6">
                                            {nobodyCame && (
                                                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-sm text-slate-700">
                                                    The class was held and nobody came.
                                                </div>
                                            )}
                                            {/* Read-only View */}
                                            <div>
                                                <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-2">Teachers</h3>
                                                <div className="space-y-2">
                                                    {dayTeachers.map(v => (
                                                        <div key={v.id} className="flex justify-between items-center py-2 border-b border-slate-50 last:border-0">
                                                            <span className="font-medium">{v.name}</span>
                                                            <span className={`text-sm font-bold ${dayKeys.has(tKey(v.id)) ? 'text-green-600' : 'text-slate-400'}`}>
                                                                {dayKeys.has(tKey(v.id)) ? 'Present' : 'Absent'}
                                                            </span>
                                                        </div>
                                                    ))}
                                                    {dayTeachers.length === 0 && <p className="text-sm text-slate-400 italic">No volunteers assigned.</p>}
                                                </div>
                                            </div>

                                            <div>
                                                <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-2">Students</h3>
                                                <div className="space-y-2">
                                                    {dayStudents.map(s => {
                                                        const isPresent = dayKeys.has(sKey(s.id));
                                                        const number = isPresent ? '' : ukWhatsAppNumber(s.parentPhone);
                                                        return (
                                                            <div key={s.id} className="flex justify-between items-center py-2 border-b border-slate-50 last:border-0">
                                                                <div>
                                                                    <span className="font-medium block">{s.name}</span>
                                                                    {isPresent
                                                                        ? <span className="text-xs text-green-600 font-medium">Present</span>
                                                                        : <span className="text-xs text-red-500 font-medium">Absent</span>}
                                                                </div>
                                                                {number && (
                                                                    <button
                                                                        onClick={() => handleNotifyParent(s, number)}
                                                                        className="text-xs bg-green-50 text-green-700 hover:bg-green-100 px-3 py-1.5 rounded-md flex items-center gap-1 transition-colors"
                                                                    >
                                                                        <Send size={12} /> Notify Parent
                                                                    </button>
                                                                )}
                                                            </div>
                                                        );
                                                    })}
                                                    {dayStudents.length === 0 && <p className="text-sm text-slate-400 italic">No students enrolled.</p>}
                                                </div>
                                            </div>

                                            <div className="pt-4 border-t border-slate-100 flex flex-wrap items-center gap-4">
                                                {mayEdit ? (
                                                    <button
                                                        onClick={() => { setTicks(new Set(dayKeys)); setEditing(true); }}
                                                        disabled={saving}
                                                        className="text-sm bg-[#2c4a00] hover:bg-[#1e3300] text-white px-4 py-2 rounded-lg flex items-center gap-2 font-medium disabled:opacity-50"
                                                    >
                                                        <Pencil size={14} /> Edit register
                                                    </button>
                                                ) : (
                                                    <p className="text-sm text-slate-500 flex items-center gap-2"><AlertCircle size={14} /> {readOnlyNote}</p>
                                                )}
                                                {isSuper && ( /* Super admin only: deletes every record of the day */
                                                    <button
                                                        onClick={handleResetDay}
                                                        disabled={saving}
                                                        className="text-sm text-red-600 hover:text-red-700 flex items-center gap-2 font-medium ml-auto"
                                                    >
                                                        <RotateCcw size={14} /> Reset whole day
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Reports Tab */}
                            {activeTab === 'report' && (
                                <div>
                                    <h2 className="text-lg font-bold mb-1">Submit Class Report</h2>
                                    <p className="text-sm text-slate-500 mb-4">
                                        For {longUkDate(reportDate, true)}.
                                        {reports.filter(r => r.date === reportDate).length > 0 && ` ${reports.filter(r => r.date === reportDate).length} report(s) already submitted for this date (see History).`}
                                    </p>
                                    <form onSubmit={handleSubmitReport} className="space-y-4">
                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-1">Topics Covered</label>
                                            <textarea
                                                required
                                                value={topics}
                                                onChange={e => setTopics(e.target.value)}
                                                placeholder="What did you teach in this class?"
                                                className="w-full p-3 border border-slate-300 rounded-lg h-32 focus:ring-2 focus:ring-[#2c4a00] focus:border-transparent"
                                            ></textarea>
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-1">Student Progress</label>
                                            <textarea
                                                required
                                                value={progress}
                                                onChange={e => setProgress(e.target.value)}
                                                placeholder="How are the students progressing?"
                                                className="w-full p-3 border border-slate-300 rounded-lg h-32 focus:ring-2 focus:ring-[#2c4a00] focus:border-transparent"
                                            ></textarea>
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-1">Issues or Notes</label>
                                            <textarea
                                                value={issues}
                                                onChange={e => setIssues(e.target.value)}
                                                placeholder="Any issues, concerns, or notes for the admins?"
                                                className="w-full p-3 border border-slate-300 rounded-lg h-32 focus:ring-2 focus:ring-[#2c4a00] focus:border-transparent"
                                            ></textarea>
                                        </div>

                                        <button
                                            type="submit"
                                            disabled={submittingReport}
                                            className="w-full bg-[#2c4a00] hover:bg-[#1e3300] text-white font-bold py-3 px-4 rounded-lg shadow-sm transition-all disabled:opacity-50"
                                        >
                                            {submittingReport ? 'Submitting...' : 'Submit Report'}
                                        </button>
                                    </form>
                                </div>
                            )}

                            {/* History Tab */}
                            {activeTab === 'history' && (
                                <div>
                                    <h2 className="text-lg font-bold mb-4">Class Report & Attendance History</h2>
                                    <div className="space-y-4">
                                        {history.length === 0 ? (
                                            <p className="text-slate-500 italic">No history available for this course.</p>
                                        ) : (
                                            history.map(item => (
                                                <div key={item.date} className="border border-slate-200 rounded-lg p-4 bg-slate-50">
                                                    <div className="flex justify-between items-start mb-2">
                                                        <div className="flex items-center gap-2 flex-wrap">
                                                            <button onClick={() => { setReportDate(item.date); setActiveTab('attendance'); }} className="font-bold text-slate-900 hover:underline" title="Open the register of this date">
                                                                {longUkDate(item.date, true)}
                                                            </button>
                                                            {item.reports.length === 0 && <span className="bg-blue-100 text-blue-800 text-xs px-2 py-0.5 rounded-full">Attendance Only</span>}
                                                            {item.reports.length > 0 && <span className="bg-green-100 text-green-800 text-xs px-2 py-0.5 rounded-full">{item.reports.length === 1 ? 'Report Submitted' : `${item.reports.length} Reports`}</span>}
                                                            {item.nobodyCame && <span className="bg-slate-200 text-slate-700 text-xs px-2 py-0.5 rounded-full">Nobody came</span>}
                                                            {!item.hasRegister && <span className="bg-amber-100 text-amber-800 text-xs px-2 py-0.5 rounded-full">No register</span>}
                                                        </div>
                                                        <span className="text-xs text-slate-500">
                                                            Attendance: <strong className="text-slate-900">{item.studentsPresent}</strong> Students
                                                        </span>
                                                    </div>

                                                    {item.reports.map(r => (
                                                        <div key={r.id} className="space-y-2 text-sm text-slate-700 mt-2 border-t border-slate-200 pt-2">
                                                            <div className="flex justify-between items-center">
                                                                <span className="text-xs text-slate-500">By <strong className="text-slate-800">{peopleById[r.volunteerId || '']?.name || 'Unknown author'}</strong>{r.editedAt ? ' (edited)' : ''}</span>
                                                                {editReportId !== r.id && (
                                                                    <div className="flex gap-3">
                                                                        {canEditReport(user, r) && (
                                                                            <button onClick={() => startEditReport(r)} className="text-xs text-slate-500 hover:text-[#2c4a00] flex items-center gap-1"><Pencil size={12} /> Edit</button>
                                                                        )}
                                                                        {isSuper && (
                                                                            <button onClick={() => handleDeleteReport(r)} className="text-xs text-slate-400 hover:text-red-600 flex items-center gap-1"><Trash2 size={12} /> Delete</button>
                                                                        )}
                                                                    </div>
                                                                )}
                                                            </div>
                                                            {editReportId === r.id ? (
                                                                <div className="space-y-2">
                                                                    <label className="block text-xs text-slate-500 uppercase">Topics</label>
                                                                    <textarea value={editTopics} onChange={e => setEditTopics(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg h-20 bg-white" />
                                                                    <label className="block text-xs text-slate-500 uppercase">Progress</label>
                                                                    <textarea value={editProgress} onChange={e => setEditProgress(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg h-20 bg-white" />
                                                                    <label className="block text-xs text-slate-500 uppercase">Issues</label>
                                                                    <textarea value={editIssues} onChange={e => setEditIssues(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg h-20 bg-white" />
                                                                    <div className="flex gap-2">
                                                                        <button onClick={() => handleSaveReportEdit(r)} disabled={submittingReport || !editTopics.trim() || !editProgress.trim()} className="bg-[#2c4a00] hover:bg-[#1e3300] text-white text-sm font-medium px-4 py-2 rounded-lg disabled:opacity-50">Save</button>
                                                                        <button onClick={() => setEditReportId(null)} className="text-sm px-4 py-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-white">Cancel</button>
                                                                    </div>
                                                                </div>
                                                            ) : (
                                                                <>
                                                                    <div>
                                                                        <strong className="block text-xs text-slate-500 uppercase">Topics</strong>
                                                                        <p className="whitespace-pre-line">{r.topicsCovered}</p>
                                                                    </div>
                                                                    <div>
                                                                        <strong className="block text-xs text-slate-500 uppercase">Progress</strong>
                                                                        <p className="whitespace-pre-line">{r.studentProgress}</p>
                                                                    </div>
                                                                    {r.issues && (
                                                                        <div>
                                                                            <strong className="block text-xs text-red-500 uppercase">Issues</strong>
                                                                            <p className="text-red-700 whitespace-pre-line">{r.issues}</p>
                                                                        </div>
                                                                    )}
                                                                </>
                                                            )}
                                                        </div>
                                                    ))}
                                                </div>
                                            ))
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </>
            ) : (
                <div className="flex flex-col items-center justify-center p-12 bg-white rounded-xl border border-dashed border-slate-300 text-slate-500">
                    <Calendar className="h-12 w-12 text-slate-300 mb-3" />
                    <p className="text-lg font-medium">Please select a course to begin</p>
                    <p className="text-sm">Choose a course from the list above to view attendance and reports.</p>
                </div>
            )}
        </div>
    );
}

// The menu hid this page without the permission, but the page itself had no check (30 Sep 2026).
// Suspense: the page reads ?course= and ?date= (static export needs the boundary).
export default function ClassReportsPage() {
    return (
        <Suspense fallback={<div className="p-8 flex justify-center"><Loader2 className="animate-spin" /></div>}>
            <RequirePermission perm="class_reports"><ClassReportsPageContent /></RequirePermission>
        </Suspense>
    );
}
