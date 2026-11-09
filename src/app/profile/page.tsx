"use client";

import DashboardLayout from "@/components/layout/DashboardLayout";
import { useAuth } from "@/contexts/AuthContext";
import { useEffect, useState } from "react";
import { doc, getDoc, updateDoc, collection, query, where, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { User, Mail, Phone, Award, Clock, BookOpen, Save } from "lucide-react";
import { volunteerHours, VolunteerHours } from "@/lib/stats";
import { Badge, EarnedBadge } from "@/lib/types";
import { awardedByLabel, badgeEvents, earnedDay, nextBadge, progressText, ukDate, BadgeCheck } from "@/lib/badges";

type EarnedView = Badge & { earned: EarnedBadge; day: string };

export default function ProfilePage() {
    const { user } = useAuth();
    const [loading, setLoading] = useState(true);
    const [profileData, setProfileData] = useState<any>(null);
    const [earnedBadges, setEarnedBadges] = useState<EarnedView[]>([]);
    // Next badge (30 Sep 2026): the nearest automatic badge, counted as the server does (src/lib/badges.ts).
    const [next, setNext] = useState<{ badge: Badge; check: BadgeCheck } | null>(null);
    // My hours (30 Sep 2026): the shared volunteer hours of src/lib/stats.ts, the same rule as the badges.
    const [stats, setStats] = useState<VolunteerHours>({ classes: 0, classSessions: 0, oneToOneSessions: 0, classHours: 0, oneToOneHours: 0, otherHours: 0, total: 0, lastClass: "" });
    const [hoursNote, setHoursNote] = useState("");
    const [loadFailed, setLoadFailed] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [formData, setFormData] = useState({
        displayName: "",
        phone: ""
    });

    useEffect(() => {
        const fetchData = async () => {
            if (!user || !user.uid) return;
            try {
                // 1. User Profile
                const userDoc = await getDoc(doc(db, "users", user.uid));
                if (userDoc.exists()) {
                    const data = userDoc.data();
                    setProfileData(data);
                    setFormData({ displayName: data.name || user.displayName || "", phone: data.phone || "" });
                }

                // 2. Earned Badges: name, icon, the day it was earned, who awarded it by hand.
                let allBadges: Badge[] = [];
                const earnedIds = new Set<string>();
                if (user.uid) {
                    const [earnedSnap, allBadgesSnap] = await Promise.all([
                        getDocs(query(collection(db, "earnedAchievements"), where("volunteerId", "==", user.uid))),
                        getDocs(collection(db, "achievementsBadges")),
                    ]);
                    allBadges = allBadgesSnap.docs.map(d => ({ id: d.id, ...d.data() } as Badge));
                    const byId = new Map(allBadges.map(b => [b.id, b]));
                    const list: EarnedView[] = [];
                    earnedSnap.docs.forEach(d => {
                        const e = { id: d.id, ...d.data() } as EarnedBadge;
                        const b = byId.get(e.badgeId);
                        if (!b || earnedIds.has(e.badgeId)) return;   // archived badges are kept, a badge is shown once
                        earnedIds.add(e.badgeId);
                        list.push({ ...b, earned: e, day: earnedDay(e) });
                    });
                    list.sort((a, b) => b.day.localeCompare(a.day));
                    setEarnedBadges(list);

                    // 3. Volunteer hours: classes taught + 1-2-1 sessions + approved logged hours.
                    try {
                        const [attSnap, coursesSnap, activitiesSnap] = await Promise.all([
                            getDocs(query(collection(db, "attendanceRecords"), where("userId", "==", user.uid))),
                            getDocs(collection(db, "course")),
                            getDocs(query(collection(db, "volunteerActivities"), where("volunteerId", "==", user.uid))),
                        ]);
                        let oneToOne: any[] = [];
                        let partial = false;
                        try {
                            oneToOne = (await getDocs(query(collection(db, "oneToOneSessions"), where("volunteerId", "==", user.uid)))).docs.map(d => d.data());
                        } catch { partial = true; /* 1-2-1 sessions not readable */ }
                        const rows = {
                            courses: coursesSnap.docs.map(d => ({ id: d.id, ...d.data() })),
                            attendance: attSnap.docs.map(d => d.data()),
                            oneToOne,
                            activities: activitiesSnap.docs.map(d => d.data()),
                        };
                        setStats(volunteerHours(user.uid, rows));
                        setNext(nextBadge(allBadges, earnedIds, badgeEvents(user.uid, rows)));
                        setHoursNote(partial ? "1-2-1 sessions could not be read, so they are not included." : "");
                    } catch (e) {
                        console.error("Error loading hours:", e);
                        setHoursNote("Your hours could not be loaded. Please refresh the page.");
                    }
                }

            } catch (error) {
                console.error("Error fetching profile:", error);
                setLoadFailed(true);
            } finally {
                setLoading(false);
            }
        };
        fetchData();
        // Once per person: the live profile changes `user` on every save, which must not reload everything.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user?.uid]);

    const [nameError, setNameError] = useState("");
    const [saving, setSaving] = useState(false);
    const [savedNote, setSavedNote] = useState("");

    const handleSave = async () => {
        if (!user) return;
        const name = formData.displayName.trim().replace(/\s+/g, " ");
        if (!name) { setNameError("Please enter your name. It cannot be empty."); return; }
        setNameError("");
        setSaving(true);
        try {
            // Both fields: older profiles read `name`, the portal reads `displayName`.
            // The sidebar updates by itself (the live profile in AuthContext).
            await updateDoc(doc(db, "users", user.uid), {
                name,
                displayName: name,
                phone: formData.phone.trim()
            });
            setIsEditing(false);
            setProfileData({ ...profileData, name, displayName: name, phone: formData.phone.trim() });
            setFormData({ displayName: name, phone: formData.phone.trim() });
            setSavedNote("Profile saved.");
            setTimeout(() => setSavedNote(""), 5000);
        } catch (error) {
            console.error("Error updating profile:", error);
            alert("Your profile was not saved. Please try again.");
        } finally {
            setSaving(false);
        }
    };

    if (!user) return null;

    return (
        <DashboardLayout>
            <div className="mb-8">
                <h1 className="text-2xl font-bold text-slate-800">My Profile</h1>
                <p className="text-slate-500">Manage your personal information and view your achievements.</p>
            </div>

            <div className="grid md:grid-cols-3 gap-8">
                {/* Left Column: Personal Info */}
                <div className="md:col-span-1 space-y-6">
                    <div className="p-6 rounded-xl shadow-sm border flex flex-col items-center text-center" style={{ backgroundColor: 'white', borderColor: '#e2e8f0' }}>
                        {profileData?.profilePic ? (
                            <img src={profileData.profilePic} alt="Profile" className="w-24 h-24 rounded-full mb-4 shadow-sm object-cover border-4 border-white" />
                        ) : (
                            <div className="w-24 h-24 rounded-full flex items-center justify-center text-3xl font-bold text-white mb-4 shadow-sm" style={{ backgroundColor: '#2c4a00' }}>
                                {(profileData?.name || user.displayName || 'U').charAt(0).toUpperCase()}
                            </div>
                        )}
                        <h2 className="text-xl font-bold text-slate-800">{profileData?.name || user.displayName}</h2>
                        <span className="px-3 py-1 bg-slate-100 text-slate-600 rounded-full text-xs font-semibold mt-2 uppercase">{user.role?.replace('_', ' ')}</span>
                    </div>

                    <div className="p-6 rounded-xl shadow-sm border" style={{ backgroundColor: 'white', borderColor: '#e2e8f0' }}>
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="font-bold text-slate-800">Details{savedNote && <span role="status" className="ml-2 text-xs font-semibold text-green-700">{savedNote}</span>}</h3>
                            {!isEditing && <button onClick={() => setIsEditing(true)} className="text-sm hover:underline" style={{ color: '#7f4c12' }}>Edit</button>}
                        </div>

                        <div className="space-y-4">
                            <div>
                                <label className="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase mb-1">
                                    <Mail size={14} /> Email
                                </label>
                                <p className="text-sm text-slate-700">{user.email}</p>
                            </div>
                            <div>
                                <label className="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase mb-1">
                                    <User size={14} /> Full Name
                                </label>
                                {isEditing ? (
                                    <>
                                        <input aria-invalid={!!nameError} className={`w-full p-2 border rounded text-sm ${nameError ? "border-red-400" : ""}`} value={formData.displayName} onChange={e => { setFormData({ ...formData, displayName: e.target.value }); if (nameError) setNameError(""); }} />
                                        {nameError && <p role="alert" className="text-xs text-red-600 mt-1">{nameError}</p>}
                                    </>
                                ) : (
                                    <p className="text-sm text-slate-700">{profileData?.name || user.displayName}</p>
                                )}
                            </div>
                            <div>
                                <label className="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase mb-1">
                                    <Phone size={14} /> Phone
                                </label>
                                {isEditing ? (
                                    <input className="w-full p-2 border rounded text-sm" value={formData.phone} onChange={e => setFormData({ ...formData, phone: e.target.value })} />
                                ) : (
                                    <p className="text-sm text-slate-700">{profileData?.phone || "Not set"}</p>
                                )}
                            </div>

                            {isEditing && (
                                <div className="flex gap-2 pt-2">
                                    <button onClick={handleSave} disabled={saving} className="flex-1 text-white py-2 rounded text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-50" style={{ backgroundColor: '#7f4c12' }}><Save size={16} /> {saving ? "Saving..." : "Save"}</button>
                                    <button onClick={() => { setIsEditing(false); setNameError(""); setFormData({ displayName: profileData?.name || user.displayName || "", phone: profileData?.phone || "" }); }} className="flex-1 bg-slate-100 text-slate-600 py-2 rounded text-sm font-bold">Cancel</button>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* Right Column: Stats & Badges */}
                <div className="md:col-span-2 space-y-6">
                    {/* Stats Cards */}
                    <div className="grid grid-cols-2 gap-4">
                        <div className="p-6 rounded-xl shadow-sm border flex items-center gap-4" style={{ backgroundColor: 'white', borderColor: '#e2e8f0' }}>
                            <div className="p-3 bg-purple-50 text-purple-600 rounded-lg"><Clock size={24} /></div>
                            <div>
                                <p className="text-2xl font-bold text-slate-800">{loading ? <span className="text-base text-slate-400">Loading…</span> : loadFailed ? <span className="text-base text-red-600">Could not load</span> : stats.total.toFixed(1)}</p>
                                <p className="text-sm text-slate-500">Volunteer Hours</p>
                                {!loading && !loadFailed && <p className="text-xs text-slate-400 mt-1">
                                    {stats.classHours.toFixed(1)} class + {stats.oneToOneHours.toFixed(1)} 1-2-1 + {stats.otherHours.toFixed(1)} logged
                                </p>}
                                {hoursNote && <p className="text-xs text-orange-600 mt-1">{hoursNote}</p>}
                            </div>
                        </div>
                        <div className="p-6 rounded-xl shadow-sm border flex items-center gap-4" style={{ backgroundColor: 'white', borderColor: '#e2e8f0' }}>
                            <div className="p-3 bg-emerald-50 text-emerald-600 rounded-lg"><BookOpen size={24} /></div>
                            <div>
                                <p className="text-2xl font-bold text-slate-800">{loading ? <span className="text-base text-slate-400">Loading…</span> : loadFailed ? <span className="text-base text-red-600">Could not load</span> : stats.classes}</p>
                                <p className="text-sm text-slate-500">Classes Taught</p>
                                {!loading && !loadFailed && <p className="text-xs text-slate-400 mt-1">{stats.classSessions} classes + {stats.oneToOneSessions} 1-2-1 sessions</p>}
                            </div>
                        </div>
                    </div>

                    {/* Badges */}
                    <div className="p-6 rounded-xl shadow-sm border" style={{ backgroundColor: 'white', borderColor: '#e2e8f0' }}>
                        <h3 className="font-bold text-slate-800 mb-4 flex items-center gap-2"><Award className="text-yellow-500" /> Earned Badges</h3>
                        {!loading && !loadFailed && next && (
                            <div className="mb-4 p-4 rounded-lg border border-purple-100 bg-purple-50">
                                <p className="text-xs font-bold text-purple-700 uppercase mb-1">Next badge</p>
                                <p className="text-sm font-semibold text-slate-800">{next.badge.name}</p>
                                <div className="w-full bg-white rounded-full h-2.5 mt-2" role="progressbar" aria-valuemin={0} aria-valuemax={next.check.goal} aria-valuenow={Math.min(next.check.current, next.check.goal)}>
                                    <div className="bg-purple-600 h-2.5 rounded-full" style={{ width: `${Math.min(100, Math.floor((next.check.current / next.check.goal) * 100))}%` }} />
                                </div>
                                <p className="text-xs text-slate-600 mt-1">{next.check.reached ? "Target reached. The badge will be added at the next check." : progressText(next.check)}</p>
                            </div>
                        )}
                        {loading ? (
                            <div className="text-center py-8 text-slate-400">Loading badges…</div>
                        ) : loadFailed ? (
                            <div role="alert" className="text-center py-8 text-red-600">Your badges could not be loaded. Please refresh the page.</div>
                        ) : earnedBadges.length === 0 ? (
                            <div className="text-center py-8 text-slate-400 bg-slate-50 rounded-lg border border-dashed border-slate-200">
                                <Award size={48} className="mx-auto mb-2 opacity-50" />
                                <p>No badges earned yet. Keep contributing!</p>
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                                {earnedBadges.map(badge => (
                                    <div key={badge.id} className="flex flex-col items-center text-center p-4 bg-slate-50 rounded-lg border border-slate-100">
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img src={badge.iconUrl || "https://placehold.co/100x100?text=B"} alt="" className="w-16 h-16 rounded-full mb-3 bg-white shadow-sm object-cover" />
                                        <h4 className="font-bold text-slate-800 text-sm">{badge.name}</h4>
                                        <p className="text-xs text-slate-500 line-clamp-2">{badge.description}</p>
                                        {badge.day && <p className="text-xs text-slate-600 mt-2">Earned {ukDate(badge.day)}</p>}
                                        {awardedByLabel(badge.earned) && <p className="text-xs text-slate-500">{awardedByLabel(badge.earned)}</p>}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </DashboardLayout>
    );
}
