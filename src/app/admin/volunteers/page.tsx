"use client";

// Active Volunteers (updated 30 Sep 2026): everyone with the volunteer role, plus every
// person who has ever taught (a class register, an assignment on a running course or a
// 1-2-1 session), whatever their role. Prince, for example, is staff but still teaches.
// The rule and the classes and hours come from src/lib/stats.ts (same as the badges).
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useEffect, useMemo, useState } from "react";
import { setPersonArchived } from "@/lib/archive";
import { isRunning, isVolunteerOrTeacher, round1, teachingPeople, volunteerHoursByPerson } from "@/lib/stats";
import { loadStatsData } from "@/lib/statsLoader";
import { UserProfile } from "@/lib/types";
import { Search, Archive, ArchiveRestore, Mail, Phone, BookOpen, CalendarDays } from "lucide-react";
import { RequirePermission } from "@/components/auth/RequirePermission";

type Person = UserProfile & Record<string, any> & {
    classes: number;          // distinct classes taught (registers + 1-2-1 sessions)
    hours: number;            // volunteer hours: classes + 1-2-1 + approved logged hours
    lastClass: string;        // date of the latest one
    courses: number;          // running courses they are assigned to now
    oneToOne: number;
    teaches: boolean;
};

const ROLE_LABEL: Record<string, string> = { volunteer: "Volunteer", staff: "Staff", admin: "Admin", super_admin: "Super admin", standard_user: "No access yet" };

function VolunteersPage() {
    const [people, setPeople] = useState<Person[]>([]);
    const [partial, setPartial] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState("");
    const [show, setShow] = useState<"all" | "volunteers" | "others" | "archived">("all");

    useEffect(() => { fetchPeople(); }, []);

    const fetchPeople = async () => {
        try {
            const { data, failed } = await loadStatsData(['users', 'courses', 'assignments', 'attendance', 'oneToOne', 'activities']);
            if (failed.includes('users')) throw new Error("People could not be read");
            if (failed.length) console.warn("Some figures could not be read:", failed);
            setPartial(failed);

            const teaching = teachingPeople(data);
            const hours = volunteerHoursByPerson(data);
            const courseById = new Map(data.courses.map(c => [c.id, c]));
            const courses: Record<string, Set<string>> = {};
            (data.assignments || []).forEach(a => {
                if (a.volunteerId && a.courseId && isRunning(courseById.get(a.courseId))) (courses[a.volunteerId] ||= new Set()).add(a.courseId);
            });

            const list: Person[] = [];
            (data.users || []).forEach(u => {
                if (!isVolunteerOrTeacher(u, teaching)) return;
                const h = hours[u.id];
                list.push({ ...(u as any), uid: u.id, classes: h?.classes || 0, hours: round1(h?.total || 0), lastClass: h?.lastClass || "", courses: courses[u.id]?.size || 0, oneToOne: h?.oneToOneSessions || 0, teaches: teaching.has(u.id) });
            });
            list.sort((a, b) => String(a.name || a.displayName || "").localeCompare(String(b.name || b.displayName || "")));
            setPeople(list);
        } catch (error) {
            console.error("Error fetching volunteers:", error);
        } finally {
            setLoading(false);
        }
    };

    // Keep history (30 Sep 2026): a volunteer is archived on the server, never deleted.
    // Their login is suspended (not deleted), they come off running courses, and their
    // classes and hours stay in every report. Restore undoes it.
    const handleArchive = async (p: Person, archived: boolean) => {
        const name = p.name || p.displayName || "this person";
        const msg = archived
            ? `Archive ${name}?\n\nTheir login is suspended (not deleted) so they cannot sign in to the portal or the app, and they are taken off courses that are still running or planned. Their classes and hours stay in every report. You can restore them later.`
            : `Restore ${name}? Their login works again. Add them back to courses from the course page.`;
        if (!confirm(msg)) return;
        try {
            const res = await setPersonArchived(p.uid, archived);
            setPeople(prev => prev.map(v => v.uid === p.uid ? { ...v, archived, courses: archived ? 0 : v.courses } : v));
            if (archived && res.assignmentsEnded) alert(`${name} is archived and was taken off ${res.assignmentsEnded} current course${res.assignmentsEnded === 1 ? "" : "s"}.`);
        } catch (error: any) {
            console.error("Error archiving volunteer:", error);
            alert(error?.message || "That did not work. You need the Volunteers permission.");
        }
    };

    const filtered = useMemo(() => {
        const q = searchTerm.trim().toLowerCase();
        return people.filter(p =>
            (show === "archived" ? p.archived === true
                : p.archived !== true && (show === "all" || (show === "volunteers" ? p.role === "volunteer" : p.role !== "volunteer"))) &&
            (!q || String(p.name || p.displayName || "").toLowerCase().includes(q) || String(p.email || "").toLowerCase().includes(q) || String(p.volunteerRole || "").toLowerCase().includes(q)));
    }, [people, searchTerm, show]);

    const current = people.filter(p => p.archived !== true);
    const counts = { all: current.length, volunteers: current.filter(p => p.role === "volunteer").length, others: current.filter(p => p.role !== "volunteer").length, archived: people.length - current.length };
    const fmt = (d: string) => { const x = new Date(d); return isNaN(x.getTime()) ? d : x.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); };

    return (
        <DashboardLayout>
            <div className="flex justify-between items-center mb-6">
                <div>
                    <h1 className="text-2xl font-bold text-slate-800">Active Volunteers</h1>
                    <p className="text-slate-500">Everyone with the volunteer role, and everyone else who teaches or has taught a class.</p>
                </div>
            </div>

            <div className="p-4 rounded-xl shadow-sm border mb-6 bg-white border-slate-200 space-y-3">
                <div className="relative">
                    <Search className="absolute left-3 top-2.5 text-slate-400" size={20} />
                    <input type="text" placeholder="Search by name, email or role..." className="pl-10 pr-4 py-2 border border-slate-200 rounded-lg w-full outline-none focus:ring-2 focus:ring-[#7f4c12]"
                        value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
                </div>
                <div className="flex flex-wrap gap-2" role="tablist">
                    {([["all", "Everyone"], ["volunteers", "Volunteers"], ["others", "Staff and admins who teach"], ["archived", "Archived"]] as const).map(([k, label]) => (
                        <button key={k} role="tab" aria-selected={show === k} onClick={() => setShow(k)}
                            className={`px-3 py-1.5 rounded-full text-sm border ${show === k ? "bg-[#7f4c12] text-white border-[#7f4c12]" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"}`}>
                            {label} <span className="opacity-75">({counts[k]})</span>
                        </button>
                    ))}
                </div>
            </div>

            {partial.length > 0 && (
                <div className="mb-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
                    Some figures could not be loaded ({partial.join(", ")}), so the numbers below may be too low.
                </div>
            )}
            {loading && <div className="p-8 text-slate-500">Loading…</div>}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filtered.map(p => {
                    const name = p.name || p.displayName || "No Name";
                    const pic = p.profilePicUrl || p.photoURL;
                    return (
                        <div key={p.uid} className="p-6 rounded-xl shadow-sm border flex flex-col items-center text-center bg-white border-slate-200">
                            <div className="relative w-20 h-20 mb-4">
                                {pic
                                    // eslint-disable-next-line @next/next/no-img-element
                                    ? <img src={pic} alt="" className="w-full h-full rounded-full object-cover border-4 border-blue-50" />
                                    : <div className="w-full h-full rounded-full flex items-center justify-center font-bold text-2xl border-4 border-white shadow-sm text-white" style={{ backgroundColor: '#2c4a00' }}>{String(name).charAt(0).toUpperCase()}</div>}
                            </div>

                            <h3 className="font-bold text-slate-800 text-lg mb-1">{name}</h3>
                            <div className="flex flex-wrap justify-center gap-1.5 mb-4">
                                <span className="text-xs px-3 py-1 rounded-full font-medium" style={{ backgroundColor: '#fdf4ff', color: '#7f4c12' }}>{ROLE_LABEL[p.role] || String(p.role || "No role").replace(/_/g, " ")}</span>
                                {p.volunteerRole && <span className="text-xs px-3 py-1 rounded-full font-medium bg-emerald-50 text-emerald-700">{p.volunteerRole}</span>}
                                {p.teaches && <span className="text-xs px-3 py-1 rounded-full font-medium bg-blue-50 text-blue-700">Teaches</span>}
                            </div>

                            <div className="w-full space-y-2 text-sm text-slate-600">
                                <div className="flex items-center justify-center gap-2 bg-slate-50 py-2 rounded-lg"><Mail size={16} className="text-slate-400" /><span className="truncate max-w-[200px]">{p.email}</span></div>
                                {p.phone && <div className="flex items-center justify-center gap-2 bg-slate-50 py-2 rounded-lg"><Phone size={16} className="text-slate-400" /><span>{p.phone}</span></div>}
                                <div className="grid grid-cols-4 gap-2 pt-1">
                                    <div className="bg-slate-50 rounded-lg py-2" title="Distinct classes taught, 1-2-1 sessions included"><div className="font-bold text-slate-800">{p.classes}</div><div className="text-[11px] text-slate-500">classes</div></div>
                                    <div className="bg-slate-50 rounded-lg py-2" title="Class hours, 1-2-1 hours and approved logged hours"><div className="font-bold text-slate-800">{p.hours}</div><div className="text-[11px] text-slate-500">hours</div></div>
                                    <div className="bg-slate-50 rounded-lg py-2"><div className="font-bold text-slate-800 flex items-center justify-center gap-1"><BookOpen size={12} />{p.courses}</div><div className="text-[11px] text-slate-500">courses now</div></div>
                                    <div className="bg-slate-50 rounded-lg py-2"><div className="font-bold text-slate-800">{p.oneToOne}</div><div className="text-[11px] text-slate-500">1-2-1</div></div>
                                </div>
                                <p className="text-xs text-slate-500 flex items-center justify-center gap-1"><CalendarDays size={12} /> {p.lastClass ? `Last class ${fmt(p.lastClass)}` : "No classes yet"}</p>
                            </div>

                            <div className="flex gap-2 w-full mt-5">
                                <a href={`/admin/volunteers/detail?id=${p.uid}`} className="flex-1 py-2 text-center text-sm font-bold text-white rounded-lg transition" style={{ backgroundColor: '#7f4c12' }}>View Details</a>
                                {p.archived === true ? (
                                    <button onClick={() => handleArchive(p, false)} className="px-3 py-2 text-green-700 text-sm font-medium hover:bg-green-50 rounded-lg transition" title="Restore" aria-label="Restore"><ArchiveRestore size={18} /></button>
                                ) : (p.role === "volunteer" || p.role === "staff") && (
                                    <button onClick={() => handleArchive(p, true)} className="px-3 py-2 text-red-600 text-sm font-medium hover:bg-red-50 rounded-lg transition" title="Archive (keeps their history)" aria-label="Archive"><Archive size={18} /></button>
                                )}
                            </div>
                        </div>
                    );
                })}

                {filtered.length === 0 && !loading && (
                    <div className="col-span-full text-center py-12 text-slate-400 bg-slate-50 rounded-xl border border-dashed border-slate-200">No one found.</div>
                )}
            </div>
        </DashboardLayout>
    );
}

export default function GuardedVolunteersPage() {
    return (
        <RequirePermission perm="volunteers">
            <VolunteersPage />
        </RequirePermission>
    );
}
