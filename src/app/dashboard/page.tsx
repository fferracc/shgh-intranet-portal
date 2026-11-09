
"use client";

import { useState, useEffect, useRef } from "react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery } from '@tanstack/react-query';
import { fetchDashboardStats, fetchPlatformStats } from "@/lib/api/dashboard";
import { attendanceHeadline } from "@/lib/stats";
import { hasLeaveRole, leaveYearLabel } from "@/lib/leaveUtils";
import AnnouncementsCard from "@/components/dashboard/AnnouncementsCard";
import {
    Activity,
    Users,
    Calendar,
    CheckCircle,
    Clock,
    FileText
} from "lucide-react";
import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer
} from 'recharts';

export default function DashboardPage() {
    const { user, refreshProfile } = useAuth();
    const [inventoryGroupBy, setInventoryGroupBy] = useState<'location' | 'type' | 'activity'>('location');
    const [selectedCourseIds, setSelectedCourseIds] = useState<Set<string>>(new Set());
    const [isRefreshing, setIsRefreshing] = useState(false);

    const { data: statsRaw, isLoading: statsLoading, refetch: refetchStats } = useQuery({
        queryKey: ['dashboardStats', user?.uid],
        queryFn: () => fetchDashboardStats(user),
        enabled: !!user,
    });

    // "Refresh Data" asks for a fresh read, past the 10 minute cache in fetchPlatformStats.
    const freshNext = useRef(false);
    const { data: platformData, isError: platformFailed, refetch: refetchPlatform } = useQuery({
        queryKey: ['platformStats', user?.uid],
        queryFn: () => { const fresh = freshNext.current; freshNext.current = false; return fetchPlatformStats(user, { fresh }); },
        enabled: !!user && ['super_admin', 'admin'].includes(user.role?.toLowerCase()),
    });

    const stats = statsRaw || {
        pendingRequests: 0,
        policyCompliance: 0,
        totalPolicies: 0,
        readPolicies: 0,
        isApprover: false
    };

    const locationStats = platformData?.locationStats || [];
    const typeStats = platformData?.typeStats || [];
    const activityStats = platformData?.activityStats || [];
    const platformStats = platformData?.platformStats || {
        students: { total: 0, enrolled: 0, under18Avg: 0, over18Avg: 0 },
        courses: { total: 0, activeRolling: 0, activeDropIn: 0, finished: 0 },
        volunteers: { totalUsers: 0, activeVolunteers: 0, activeDays: 90, registeredVolunteers: 0, historicVolunteers: 0, admins: 0 },
        inventory: { total: 0 },
        attendance: { rate: 0, data: [] as any[] }
    };
    // A card whose reads failed shows "Could not load", never a silent 0 (30 Sep 2026).
    const failedCards: Record<string, boolean | undefined> = platformFailed ? { students: true, volunteers: true, courses: true, inventory: true, attendance: true } : (platformData?.errors || {});
    // Attendance Overview (29 Sep 2026, Franco): only enrolling (Rolling) courses that are
    // running now. Completed, cancelled and drop-in courses stay in the Funders Report.
    // Type and status are already normalised in src/lib/stats.ts ("running", "Rolling Course").
    // 30 Sep 2026: a running course with no registers yet is left out of the chart and the filter.
    const isOverviewCourse = (c: any) => c.type === 'Rolling' && c.running === true && (Number(c.sessions) || 0) > 0;
    const overviewCourses = platformStats.attendance.data.filter((c: any) => isOverviewCourse(c));
    // Tick every overview course once, when the figures first arrive (not again after "None").
    const ticksSet = useRef(false);
    useEffect(() => {
        if (!ticksSet.current && platformData) {
            ticksSet.current = true;
            setSelectedCourseIds(new Set(overviewCourses.map((c: any) => c.id)));
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [platformData]);

    const filteredAttendanceData = overviewCourses.filter((d: any) => selectedCourseIds.has(d.id));
    // Headline and "X present of Y expected, across N courses" = the TICKED courses only
    // (average of their course rates, src/lib/stats.ts).
    const headline = attendanceHeadline(
        Object.fromEntries(overviewCourses.map((d: any) => [d.id, { sessions: d.sessions, present: d.present, expected: d.possible, rate: d.rate ?? null, duplicatesIgnored: 0 }])),
        filteredAttendanceData.map((d: any) => d.id),
    );
    const figuresAt = platformData?.at ? new Date(platformData.at) : null;
    const figuresTime = figuresAt ? `${String(figuresAt.getHours()).padStart(2, '0')}:${String(figuresAt.getMinutes()).padStart(2, '0')}` : '';
    const la = user?.leaveAllowance;
    const CouldNotLoad = () => <span className="text-base font-semibold text-red-600">Could not load</span>;

    if (!user || statsLoading) return (
        <div className="flex items-center justify-center h-screen bg-slate-50">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
        </div>
    );

    const isManager = !!stats.isApprover; // Approve Leave, or line manager of someone

    const handleRefresh = async () => {
        setIsRefreshing(true);
        freshNext.current = true;
        await Promise.all([refetchStats(), refetchPlatform(), refreshProfile()]);
        setTimeout(() => setIsRefreshing(false), 500); // UI feedback delay
    };

    return (
        <DashboardLayout>
            <div className="mb-8 flex justify-between items-start">
                <div>
                    <h1 className="text-2xl font-bold text-slate-800">Welcome back, {user.displayName}</h1>
                    <p className="text-slate-500">Here&apos;s what&apos;s happening today.</p>
                </div>
                <button 
                    onClick={handleRefresh} 
                    disabled={isRefreshing}
                    className="flex items-center gap-2 bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-900 px-4 py-2 rounded-lg text-sm font-medium shadow-sm transition-all disabled:opacity-50"
                >
                    <div className={isRefreshing ? "animate-spin" : ""}>
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                    </div>
                    {isRefreshing ? 'Refreshing...' : 'Refresh Data'}
                </button>
            </div>

            <div className="grid md:grid-cols-3 gap-6 mb-8">
                {/* Leave Balance Card: only staff, admins and super admins have annual leave. Live (AuthContext). */}
                {hasLeaveRole(user.role) && (
                <div className="p-6 rounded-xl shadow-lg border-l-4" style={{ backgroundColor: 'white', borderLeftColor: '#7f4c12' }}>
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wider">Annual Leave</h3>
                        <Calendar style={{ color: '#7f4c12' }} size={20} />
                    </div>
                    {la ? (
                        <div className="flex items-end gap-2">
                            <span className="text-3xl font-bold" style={{ color: '#2c4a00' }}>{la.remaining}</span>
                            <span className="text-sm text-slate-400 mb-1">of {la.total} days left</span>
                        </div>
                    ) : (
                        <div className="flex items-end gap-2">
                            <span className="text-3xl font-bold text-slate-400">Not set</span>
                        </div>
                    )}
                    <div className="mt-4 w-full bg-slate-100 rounded-full h-1.5">
                        <div
                            className="h-1.5 rounded-full shadow-sm"
                            style={{ backgroundColor: '#7f4c12', width: `${la?.total ? Math.max(0, Math.min(100, (la.remaining / la.total) * 100)) : 0}%` }}
                        ></div>
                    </div>
                    <p className="mt-2 text-xs text-slate-400">{leaveYearLabel()}</p>
                </div>
                )}

                {/* Pending Requests (Manager Only) */}
                {isManager && (
                    <div className="p-6 rounded-xl shadow-lg border-l-4 border-orange-500" style={{ backgroundColor: 'white', borderLeftColor: '#f97316' }}>
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wider">Pending Approvals</h3>
                            <Clock className="text-orange-500" size={20} />
                        </div>
                        <div className="flex items-end gap-2">
                            <span className="text-3xl font-bold" style={{ color: '#2c4a00' }}>{stats.pendingRequests}</span>
                            <span className="text-sm text-slate-400 mb-1">requests waiting</span>
                        </div>
                        <a href="/leave?tab=team" className="inline-flex items-center gap-1 mt-4 text-sm font-bold hover:opacity-80" style={{ color: '#7f4c12' }}>
                            Review Requests <Clock size={14} />
                        </a>
                    </div>
                )}

                {/* Policy Compliance */}
                <div className="p-6 rounded-xl border-l-4 border-teal-500 shadow-lg" style={{ backgroundColor: 'white' }}>
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wider">Policy Status</h3>
                        <CheckCircle className="text-teal-500" size={20} />
                    </div>
                    <div className="flex items-end gap-2">
                        <span className="text-3xl font-bold" style={{ color: '#2c4a00' }}>{stats.policyCompliance}%</span>
                        <span className="text-sm text-slate-400 mb-1">read</span>
                    </div>
                    <p className="mt-4 text-xs text-slate-400 font-medium">
                        <span className="text-slate-600 font-bold">{stats.readPolicies}</span> of <span className="text-slate-600 font-bold">{stats.totalPolicies}</span> policies read.
                    </p>
                </div>
            </div>

            <div className="grid md:grid-cols-3 gap-6">
                {/* Quick Actions & Announcements */}
                <div className="md:col-span-2 space-y-6">
                    <div className="grid md:grid-cols-2 gap-6">
                        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100 relative overflow-hidden">
                            <div className="absolute top-0 right-0 w-24 h-24 bg-blue-50 rounded-bl-full -mr-4 -mt-4 z-0"></div>
                            <h3 className="font-semibold text-slate-800 mb-4 relative z-10">Quick Actions</h3>
                            <div className="grid grid-cols-2 gap-4 relative z-10">
                                <a href="/leave" className="p-4 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors flex flex-col items-center justify-center gap-2 border border-blue-100">
                                    <Calendar size={24} />
                                    <span className="text-sm font-medium">Book Leave</span>
                                </a>
                                <a href="/policies" className="p-4 rounded-lg bg-teal-50 text-teal-700 hover:bg-teal-100 transition-colors flex flex-col items-center justify-center gap-2 border border-teal-100">
                                    <FileText size={24} />
                                    <span className="text-sm font-medium">Read Policies</span>
                                </a>
                            </div>
                        </div>

                        <AnnouncementsCard />
                    </div>

                    {/* Company Portals & Apps */}
                    <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
                        <h3 className="font-semibold text-slate-800 mb-4">Company Portals & Apps</h3>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <a
                                href="https://shgh-lms1.web.app/"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="p-4 rounded-lg border border-slate-100 hover:border-blue-200 hover:bg-blue-50 transition flex items-center gap-3 group"
                            >
                                <div className="w-10 h-10 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center group-hover:bg-blue-200 transition">
                                    <span className="font-bold text-xs">UK</span>
                                </div>
                                <div>
                                    <h4 className="font-medium text-slate-800 text-sm group-hover:text-blue-700">UK App</h4>
                                    <p className="text-xs text-slate-500">Main LMS Portal</p>
                                </div>
                            </a>

                            <a
                                href="https://shgh-attendance-redesign.web.app/"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="p-4 rounded-lg border border-slate-100 hover:border-green-200 hover:bg-green-50 transition flex items-center gap-3 group"
                            >
                                <div className="w-10 h-10 bg-green-100 text-green-600 rounded-full flex items-center justify-center group-hover:bg-green-200 transition">
                                    <span className="font-bold text-xs">GH</span>
                                </div>
                                <div>
                                    <h4 className="font-medium text-slate-800 text-sm group-hover:text-green-700">Ghana App</h4>
                                    <p className="text-xs text-slate-500">Attendance Redesign</p>
                                </div>
                            </a>

                            <a
                                href="https://fidos-quest-game.web.app/"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="p-4 rounded-lg border border-slate-100 hover:border-orange-200 hover:bg-orange-50 transition flex items-center gap-3 group"
                            >
                                <div className="w-10 h-10 bg-orange-100 text-orange-600 rounded-full flex items-center justify-center group-hover:bg-orange-200 transition">
                                    <span className="font-bold text-lg">🐾</span>
                                </div>
                                <div>
                                    <h4 className="font-medium text-slate-800 text-sm group-hover:text-orange-700">Fido Game</h4>
                                    <p className="text-xs text-slate-500">Interactive Game</p>
                                </div>
                            </a>

                            <a
                                href="https://kids-learning-app-12ebc.web.app"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="p-4 rounded-lg border border-slate-100 hover:border-purple-200 hover:bg-purple-50 transition flex items-center gap-3 group"
                            >
                                <div className="w-10 h-10 bg-purple-100 text-purple-600 rounded-full flex items-center justify-center group-hover:bg-purple-200 transition">
                                    <span className="font-bold text-lg">🎓</span>
                                </div>
                                <div>
                                    <h4 className="font-medium text-slate-800 text-sm group-hover:text-purple-700">Kids App</h4>
                                    <p className="text-xs text-slate-500">Learning Platform</p>
                                </div>
                            </a>

                            <a
                                href="https://sovereignhousegh.com/"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="p-4 rounded-lg border border-slate-100 hover:border-teal-200 hover:bg-teal-50 transition flex items-center gap-3 group"
                            >
                                <div className="w-10 h-10 bg-teal-100 text-teal-600 rounded-full flex items-center justify-center group-hover:bg-teal-200 transition">
                                    <span className="font-bold text-lg">🌍</span>
                                </div>
                                <div>
                                    <h4 className="font-medium text-slate-800 text-sm group-hover:text-teal-700">Main Website</h4>
                                    <p className="text-xs text-slate-500">sovereignhousegh.com</p>
                                </div>
                            </a>

                            <a
                                href="https://sites.google.com/sovereignhousegh.education/robolandcourse/roboland"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="p-4 rounded-lg border border-slate-100 hover:border-indigo-200 hover:bg-indigo-50 transition flex items-center gap-3 group"
                            >
                                <div className="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center group-hover:bg-indigo-200 transition">
                                    <span className="font-bold text-lg">🤖</span>
                                </div>
                                <div>
                                    <h4 className="font-medium text-slate-800 text-sm group-hover:text-indigo-700">Nana in Roboland</h4>
                                    <p className="text-xs text-slate-500">Learning experience</p>
                                </div>
                            </a>
                        </div>
                    </div>
                </div>

                {/* Platform Analytics (Admin Only) */}
                {user && ['super_admin', 'admin'].includes(user.role?.toLowerCase()) && (
                    <div className="md:col-span-3 mt-8">
                        <div className="flex items-center gap-2 mb-6">
                            <h2 className="text-xl font-bold text-slate-800">Platform Analytics</h2>
                            <span className="px-2 py-0.5 rounded text-xs font-bold bg-slate-100 text-slate-500 uppercase">Admin Only</span>
                            {figuresTime && <span className="ml-auto text-xs text-slate-400" title="Figures are kept for 10 minutes. Refresh Data reads them again.">Figures from {figuresTime}</span>}
                        </div>

                        <div className="grid md:grid-cols-4 gap-6">
                            {/* Students */}
                            <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
                                <div className="flex justify-between items-start mb-2">
                                    <p className="text-sm font-medium text-slate-500 uppercase tracking-wide">Students</p>
                                    <Users size={20} className="text-blue-500" />
                                </div>
                                {failedCards.students ? <div className="mb-4"><CouldNotLoad /></div> : <>
                                <div className="flex items-end gap-2 mb-4">
                                    <h3 className="text-3xl font-bold text-slate-900">{platformStats.students.total}</h3>
                                    <span className="text-sm text-slate-500 mb-1">Historical</span>
                                </div>
                                <div className="space-y-1 text-xs text-slate-500">
                                    <div className="flex justify-between">
                                        <span title="Students on a running course now (archived students left out)">Enrolled now:</span>
                                        <span className="font-semibold text-blue-600 bg-blue-50 px-2 py-0.5 rounded">{platformStats.students.enrolled}</span>
                                    </div>
                                    <div className="flex justify-between mt-2 pt-2 border-t border-slate-100">
                                        <span>Avg Age (&lt;18):</span>
                                        <span className="font-semibold text-slate-800">{platformStats.students.under18Avg} yrs</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span>Avg Age (18+):</span>
                                        <span className="font-semibold text-slate-800">{platformStats.students.over18Avg} yrs</span>
                                    </div>
                                </div>
                                </>}
                            </div>

                            {/* Volunteers */}
                            <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
                                <div className="flex justify-between items-start mb-2">
                                    <p className="text-sm font-medium text-slate-500 uppercase tracking-wide">Volunteers</p>
                                    <Users size={20} className="text-purple-500" />
                                </div>
                                {failedCards.volunteers ? <div className="mb-4"><CouldNotLoad /></div> : <>
                                <div className="flex items-end gap-2 mb-4">
                                    <h3 className="text-3xl font-bold text-slate-900">{platformStats.volunteers.activeVolunteers}</h3>
                                    <span className="text-sm text-slate-500 mb-1" title="Anyone of any role who taught a class or a 1-2-1 session, or had hours approved, in the last 90 days (archived people left out)">Active volunteers, last {platformStats.volunteers.activeDays ?? 90} days</span>
                                </div>
                                <div className="space-y-1 text-xs text-slate-500">
                                    <div className="flex justify-between">
                                        <span title="People with the volunteer role (archived people left out)">Registered volunteers:</span>
                                        <span className="font-semibold text-purple-600 bg-purple-50 px-2 py-0.5 rounded">{platformStats.volunteers.registeredVolunteers ?? 0}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span title="Anyone who has ever taught a class or a 1-2-1 session">Historic (ever taught):</span>
                                        <span className="font-semibold text-slate-800">{platformStats.volunteers.historicVolunteers ?? 0}</span>
                                    </div>
                                    <div className="flex justify-between mt-2 pt-2 border-t border-slate-100">
                                        <span>Platform users:</span>
                                        <span className="font-semibold text-slate-800">{platformStats.volunteers.totalUsers}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span>Admins:</span>
                                        <span className="font-semibold text-slate-800">{platformStats.volunteers.admins}</span>
                                    </div>
                                </div>
                                </>}
                            </div>

                            {/* Courses */}
                            <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
                                <div className="flex justify-between items-start mb-2">
                                    <p className="text-sm font-medium text-slate-500 uppercase tracking-wide">Courses Overview</p>
                                    <Clock size={20} className="text-emerald-500" />
                                </div>
                                {failedCards.courses ? <div className="mb-4"><CouldNotLoad /></div> : <>
                                <div className="flex items-end gap-2 mb-4">
                                    <h3 className="text-3xl font-bold text-slate-900">{platformStats.courses.total}</h3>
                                    <span className="text-sm text-slate-500 mb-1">Total</span>
                                </div>
                                <div className="space-y-1 text-xs text-slate-500">
                                    <div className="flex justify-between">
                                        <span>Active Rolling:</span>
                                        <span className="font-semibold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded">{platformStats.courses.activeRolling}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span>Active Drop-in:</span>
                                        <span className="font-semibold text-orange-600 bg-orange-50 px-2 py-0.5 rounded">{platformStats.courses.activeDropIn}</span>
                                    </div>
                                    <div className="flex justify-between mt-2 pt-2 border-t border-slate-100">
                                        <span>Finished Courses:</span>
                                        <span className="font-semibold text-slate-800">{platformStats.courses.finished}</span>
                                    </div>
                                </div>
                                </>}
                            </div>

                            {/* Inventory */}
                            <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
                                <div className="flex justify-between items-start mb-2">
                                    <p className="text-sm font-medium text-slate-500 uppercase tracking-wide">Total Inventory</p>
                                    <CheckCircle size={20} className="text-orange-500" />
                                </div>
                                <h3 className="text-3xl font-bold text-slate-900 mb-4">{failedCards.inventory ? <CouldNotLoad /> : platformStats.inventory.total}</h3>
                                <div className="text-xs text-slate-500">
                                    Tracked Items
                                </div>
                            </div>
                            {/* Attendance Rate (New) */}
                            <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
                                <div className="flex justify-between items-start mb-2">
                                    <p className="text-sm font-medium text-slate-500 uppercase tracking-wide">Student Attendance</p>
                                    <Activity size={20} className="text-pink-500" />
                                </div>
                                {failedCards.attendance ? <div className="mb-4"><CouldNotLoad /></div> : <>
                                <h3 className="text-3xl font-bold text-slate-900 mb-2">{headline.rate === null ? 'No data' : `${headline.rate}%`}</h3>
                                <div className="text-xs text-slate-500">
                                    Average of the ticked courses&apos; rates
                                </div>
                                <div className="text-xs text-slate-500 mt-1">
                                    {headline.present} present of {headline.expected} expected, across {headline.courses} course{headline.courses === 1 ? '' : 's'}
                                </div>
                                </>}
                            </div>
                        </div>

                        {/* Attendance Chart (New) */}
                        <div className="mt-6 bg-white rounded-xl shadow-sm border border-slate-100 p-6">
                            <h3 className="font-semibold leading-none tracking-tight text-lg text-slate-900 mb-1">Attendance Overview</h3>
                            <p className="text-sm text-slate-500 mb-6">Attendance for enrolling courses that are running now and have registers. Drop-in, completed and cancelled courses are in the Funders Report.</p>
                            
                            <div className="flex flex-col md:flex-row gap-6">
                                {/* Chart Area */}
                                <div className="w-full md:w-3/4 h-[350px]">
                                    {filteredAttendanceData.every((d: any) => d.value === 0) ? (
                                        <div className="h-full flex items-center justify-center text-slate-400">No data for selected courses</div>
                                    ) : (
                                        <ResponsiveContainer width="100%" height="100%">
                                            <BarChart data={filteredAttendanceData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                                                <XAxis dataKey="name" stroke="#6b7280" fontSize={12} tickLine={false} axisLine={false} />
                                                <YAxis stroke="#6b7280" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(value) => `${value}%`} domain={[0, 100]} />
                                                <Tooltip
                                                    cursor={{ fill: '#f3f4f6' }}
                                                    contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                                                    formatter={(value: number | undefined) => [`${value || 0}%`, 'Percentage']}
                                                />
                                                <Bar dataKey="value" fill="#2c4a00" radius={[4, 4, 0, 0]} name="Percentage" barSize={60} stroke="none" />
                                            </BarChart>
                                        </ResponsiveContainer>
                                    )}
                                </div>

                                {/* Filters Area */}
                                <div className="w-full md:w-1/4 max-h-[350px] flex flex-col bg-slate-50/50 p-4 rounded-lg border border-slate-100">
                                    <div className="flex justify-between items-center mb-3">
                                        <span className="text-sm font-semibold text-slate-700">Filter Courses</span>
                                        <div className="flex gap-2">
                                            <button 
                                                onClick={() => setSelectedCourseIds(new Set(overviewCourses.map((c: any) => c.id)))}
                                                className="text-[10px] px-2 py-1 bg-white hover:bg-slate-100 border border-slate-200 shadow-sm rounded text-slate-700 font-medium transition-colors"
                                            >
                                                All
                                            </button>
                                            <button 
                                                onClick={() => setSelectedCourseIds(new Set())} 
                                                className="text-[10px] px-2 py-1 bg-white hover:bg-slate-100 border border-slate-200 shadow-sm rounded text-slate-700 font-medium transition-colors"
                                            >
                                                None
                                            </button>
                                        </div>
                                    </div>
                                    <div className="overflow-y-auto pr-2 space-y-1.5 flex-grow custom-scrollbar">
                                        {overviewCourses.map((course: any) => (
                                            <label key={course.id} className="flex items-start space-x-2 cursor-pointer group hover:bg-white p-1.5 rounded transition-all border border-transparent hover:border-slate-200 hover:shadow-sm">
                                                <input
                                                    type="checkbox"
                                                    checked={selectedCourseIds.has(course.id)}
                                                    onChange={(e) => {
                                                        const newSet = new Set(selectedCourseIds);
                                                        if (e.target.checked) newSet.add(course.id);
                                                        else newSet.delete(course.id);
                                                        setSelectedCourseIds(newSet);
                                                    }}
                                                    className="rounded border-gray-300 text-slate-800 focus:ring-slate-800 h-3.5 w-3.5 mt-0.5 shrink-0"
                                                />
                                                <span className="text-xs font-medium text-slate-600 group-hover:text-slate-900 leading-tight block">{course.code ? `${course.code}: ` : ''}{course.fullName || course.name}</span>
                                            </label>
                                        ))}
                                        {overviewCourses.length === 0 && (
                                            <p className="text-xs text-slate-400 italic text-center py-4">No running enrolling courses with registers yet.</p>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Inventory Breakdown */}
                        <div className="mt-6 bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden h-fit">
                            <div className="p-4 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
                                <h3 className="font-semibold text-slate-700">Inventory Distribution</h3>
                                <select
                                    value={inventoryGroupBy}
                                    onChange={(e) => setInventoryGroupBy(e.target.value as any)}
                                    className="text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none p-1.5 bg-white text-slate-600 font-medium cursor-pointer"
                                >
                                    <option value="location">By Location</option>
                                    <option value="type">By Type</option>
                                    <option value="activity">By Activity</option>
                                </select>
                            </div>
                            <div className="p-0">
                                <table className="w-full text-sm text-left">
                                    <thead className="bg-slate-50 text-xs uppercase text-slate-500 font-semibold">
                                        <tr>
                                            <th className="px-4 py-3">
                                                {inventoryGroupBy === 'location' ? 'Location' : inventoryGroupBy === 'type' ? 'Type' : 'Activity'}
                                            </th>
                                            <th className="px-4 py-3 text-right">Count</th>
                                            <th className="px-4 py-3 w-1/2">Visualize</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-100">
                                        {(() => {
                                            const displayData = inventoryGroupBy === 'location'
                                                ? locationStats.map((s: any) => ({ label: s.location, count: s.count }))
                                                : inventoryGroupBy === 'type'
                                                    ? typeStats.map((s: any) => ({ label: s.type, count: s.count }))
                                                    : activityStats.map((s: any) => ({ label: s.activity, count: s.count }));

                                            if (displayData.length === 0) {
                                                return <tr><td colSpan={3} className="px-4 py-4 text-center text-slate-400">No data</td></tr>;
                                            }

                                            const totalForView = displayData.reduce((sum: number, item: any) => sum + item.count, 0);

                                            return displayData.map((stat: any, i: number) => (
                                                <tr key={i} className="hover:bg-slate-50 text-slate-700">
                                                    <td className="px-4 py-3 font-medium">{stat.label}</td>
                                                    <td className="px-4 py-3 text-right font-bold text-blue-600">{stat.count}</td>
                                                    <td className="px-4 py-3">
                                                        <div className="w-full bg-slate-100 rounded-full h-1.5">
                                                            <div className="bg-blue-500 h-1.5 rounded-full" style={{ width: `${totalForView > 0 ? (stat.count / totalForView) * 100 : 0}%` }}></div>
                                                        </div>
                                                    </td>
                                                </tr>
                                            ));
                                        })()}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </DashboardLayout>
    );
}
