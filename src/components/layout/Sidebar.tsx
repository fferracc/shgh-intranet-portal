"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import {
    LayoutDashboard,
    CalendarDays,
    FileText,
    Users,
    ClipboardList,
    Box,
    LogOut,
    Menu,
    X,
    GraduationCap,
    ChevronDown,
    ChevronRight,
    Megaphone,
    Star,
    Share2,
    Target,
    ShieldCheck,
    BarChart3
} from "lucide-react";
import { cn } from "@/lib/utils";
import { can, PermissionKey } from "@/lib/permissions";
import { useEffect, useState } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { awaitingDecision } from "@/lib/volunteerForm";

export function Sidebar() {
    const { user, signOut } = useAuth();
    const pathname = usePathname();
    const [isOpen, setIsOpen] = useState(false);
    // State for collapsible sections
    const [openSections, setOpenSections] = useState({
        academy: true,
        hr: true,
        recruitment: true,
        funding: true,
        system: true
    });

    const toggleSection = (section: keyof typeof openSections) => {
        setOpenSections(prev => ({ ...prev, [section]: !prev[section] }));
    };

    const toggleSidebar = () => setIsOpen(!isOpen);

    // Portal notification: how many volunteer applications need someone (new ones, and
    // interviews that have happened with no decision yet).
    const [volunteerTodo, setVolunteerTodo] = useState(0);
    useEffect(() => {
        if (!user || !can(user, 'volunteer_applications')) return;
        getDocs(query(collection(db, "volunteer_applications"), where("status", "in", ["new", "interview"])))
            .then(snap => setVolunteerTodo(snap.docs.filter(d => d.data().status === "new" || awaitingDecision(d.data() as any)).length))
            .catch(() => setVolunteerTodo(0));
    }, [user, pathname]);

    if (!user) return null;

    // Define Links Structure.
    // `perm` is a feature permission key; a link with no `perm` is open to anyone signed in.
    type NavItem = { href: string; label: string; icon: any; perm?: PermissionKey; hideForRoles?: string[]; badge?: number };

    const mainLinks: NavItem[] = [
        { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
        { href: "/profile", label: "My Profile", icon: Users },
    ];

    const academyLinks: NavItem[] = [
        { href: "/admin/students", label: "Students", icon: Users, perm: 'students' },
        { href: "/admin/courses", label: "Courses", icon: Box, perm: 'courses' },
        { href: "/admin/volunteers", label: "Volunteers", icon: Users, perm: 'volunteers' },
        { href: "/admin/badges", label: "Badges", icon: Box, perm: 'badges' },
        { href: "/academy/reports", label: "Class Reports", icon: FileText, perm: 'class_reports' },
        { href: "/academy/registers", label: "Historic Registers", icon: ClipboardList, perm: 'class_reports' },
        { href: "/calendar", label: "Calendar", icon: CalendarDays, perm: 'calendar' },
        { href: "/academy/ghana", label: "Ghana Operations", icon: Star, perm: 'ghana_ops' },
        { href: "/academy/statistics", label: "Statistics", icon: BarChart3, perm: 'statistics' },
    ];

    const hrLinks: NavItem[] = [
        { href: "/leave", label: "Leave Management", icon: CalendarDays, hideForRoles: ['volunteer'] },
        // My Team: super admin and admins only (Franco, 29 Sep 2026).
        ...((user.role === 'super_admin' || user.role === 'admin') ? [{ href: "/team", label: "My Team", icon: Users } as NavItem] : []),
        { href: "/policies", label: "Policies", icon: FileText },
        { href: "/inventory", label: "Inventory", icon: Box, perm: 'inventory' },
    ];

    const recruitmentLinks: NavItem[] = [
        { href: "/recruitment", label: "Volunteer Applications", icon: Users, perm: 'volunteer_applications', badge: volunteerTodo },
        { href: "/recruitment/students", label: "Student Applications", icon: GraduationCap, perm: 'student_applications' },
    ];

    const sysLinks: NavItem[] = [
        { href: "/admin/announcements", label: "Announcements", icon: Megaphone, perm: 'announcements' },
        { href: "/social", label: "Social Media", icon: Share2, perm: 'social_media' },
        { href: "/social/plan", label: "Content Plan", icon: Target, perm: 'social_media' },
    ];

    // A link with no `perm` is always visible; otherwise the permission decides.
    const allow = (l: NavItem) =>
        !(l.hideForRoles && l.hideForRoles.includes(user.role)) && (!l.perm || can(user, l.perm));

    // Helper for Section Header
    const SectionHeader = ({ label, isOpen, onToggle, icon: Icon }: any) => (
        <button
            onClick={onToggle}
            className="w-full flex items-center justify-between px-3 py-2 text-xs font-bold text-slate-400 uppercase tracking-wider hover:text-white transition-colors mb-1 mt-2"
        >
            <div className="flex items-center gap-2">
                {Icon && <Icon size={16} />}
                {label}
            </div>
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
    );

    return (
        <>
            {/* Mobile Trigger */}
            <button
                onClick={toggleSidebar}
                className="md:hidden fixed top-4 left-4 z-50 p-2 bg-white rounded-md shadow-md"
            >
                {isOpen ? <X size={24} /> : <Menu size={24} />}
            </button>

            {/* Overlay */}
            {isOpen && (
                <div
                    className="fixed inset-0 bg-black/50 z-40 md:hidden"
                    onClick={() => setIsOpen(false)}
                />
            )}

            {/* Sidebar */}
            <aside
                style={{ backgroundColor: '#2c4a00' }}
                className={cn(
                    "fixed inset-y-0 left-0 z-40 w-64 text-white transform transition-transform duration-200 ease-in-out md:translate-x-0 md:static md:h-screen flex flex-col shadow-xl print:hidden",
                    isOpen ? "translate-x-0" : "-translate-x-full"
                )}>
                <div className="p-6 border-b border-white/10 flex-shrink-0">
                    <h1 className="text-xl font-bold text-white tracking-tight">
                        Sovereign House GH
                    </h1>
                    <p className="text-xs text-white/90 mt-1 font-medium bg-white/10 inline-block px-2 py-0.5 rounded border border-white/10">Intranet & Portal</p>
                </div>

                <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-2">

                    {/* Main Section */}
                    <ul className="space-y-1 mb-4">
                        {mainLinks.filter(allow).map(link => (
                            <li key={link.href}>
                                <NavLink link={link} pathname={pathname} closeMobile={() => setIsOpen(false)} />
                            </li>
                        ))}
                    </ul>

                    {/* Academy Section */}
                    {academyLinks.some(allow) && (
                        <div>
                            <SectionHeader
                                label="Academy"
                                icon={GraduationCap}
                                isOpen={openSections.academy}
                                onToggle={() => toggleSection('academy')}
                            />
                            {openSections.academy && (
                                <ul className="space-y-1 pl-2 border-l border-white/10 ml-2">
                                    {academyLinks.filter(allow).map(link => (
                                        <li key={link.href}>
                                            <NavLink link={link} pathname={pathname} closeMobile={() => setIsOpen(false)} />
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}

                    {/* HR Section */}
                    {hrLinks.some(allow) && (
                        <div>
                            <SectionHeader
                                label="HR & Operations"
                                icon={ClipboardList}
                                isOpen={openSections.hr}
                                onToggle={() => toggleSection('hr')}
                            />
                            {openSections.hr && (
                                <ul className="space-y-1 pl-2 border-l border-white/10 ml-2">
                                    {hrLinks.filter(allow).map(link => (
                                        <li key={link.href}>
                                            <NavLink link={link} pathname={pathname} closeMobile={() => setIsOpen(false)} />
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}

                    {/* Recruitment Section */}
                    {recruitmentLinks.some(allow) && (
                        <div>
                            <SectionHeader
                                label="Recruitment"
                                icon={Users}
                                isOpen={openSections.recruitment}
                                onToggle={() => toggleSection('recruitment')}
                            />
                            {openSections.recruitment && (
                                <ul className="space-y-1 pl-2 border-l border-white/10 ml-2">
                                    {recruitmentLinks.filter(allow).map(link => (
                                        <li key={link.href}>
                                            <NavLink link={link} pathname={pathname} closeMobile={() => setIsOpen(false)} />
                                        </li>
                                    ))}
                                    {user.role === 'super_admin' && (
                                        <li key="/recruitment/forms">
                                            <NavLink link={{ href: "/recruitment/forms", label: "Application Forms", icon: FileText }} pathname={pathname} closeMobile={() => setIsOpen(false)} />
                                        </li>
                                    )}
                                </ul>
                            )}
                        </div>
                    )}



                    {/* Funding Section - Admin Only */}
                    {can(user, 'grants') && (
                        <div>
                            <SectionHeader
                                label="Funding"
                                icon={ClipboardList}
                                isOpen={openSections.funding}
                                onToggle={() => toggleSection('funding')}
                            />
                            {openSections.funding && (
                                <ul className="space-y-1 pl-2 border-l border-white/10 ml-2">
                                    <li key="/funding/grants">
                                        <NavLink link={{ href: "/funding/grants", label: "Grants", icon: FileText }} pathname={pathname} closeMobile={() => setIsOpen(false)} />
                                    </li>
                                    {/* 30 Sep 2026: the Funders Report is now built on the Statistics page. */}
                                    {can(user, 'statistics') && (
                                        <li key="/funding/reports">
                                            <NavLink link={{ href: "/academy/statistics", label: "Funders Report", icon: BarChart3 }} pathname={pathname} closeMobile={() => setIsOpen(false)} />
                                        </li>
                                    )}
                                </ul>
                            )}
                        </div>
                    )}

                    {/* System Section */}
                    {(sysLinks.some(allow) || user.role === 'super_admin') && (
                        <div>
                            <SectionHeader
                                label="System"
                                icon={Box}
                                isOpen={openSections.system}
                                onToggle={() => toggleSection('system')}
                            />
                            {openSections.system && (
                                <ul className="space-y-1 pl-2 border-l border-white/10 ml-2">
                                    {sysLinks.filter(allow).map(link => (
                                        <li key={link.href}>
                                            <NavLink link={link} pathname={pathname} closeMobile={() => setIsOpen(false)} />
                                        </li>
                                    ))}
                                    {user.role === 'super_admin' && (
                                        <li key="/admin/users">
                                            <NavLink link={{ href: "/admin/users", label: "Users & Permissions", icon: ShieldCheck }} pathname={pathname} closeMobile={() => setIsOpen(false)} />
                                        </li>
                                    )}
                                    {user.role === 'super_admin' && (
                                        <li key="/admin/line-managers">
                                            <NavLink link={{ href: "/admin/line-managers", label: "Line Managers", icon: Users }} pathname={pathname} closeMobile={() => setIsOpen(false)} />
                                        </li>
                                    )}
                                </ul>
                            )}
                        </div>
                    )}

                </nav>

                <div className="p-4 border-t border-white/10 flex-shrink-0 bg-black/20">
                    <div className="flex items-center gap-3 px-2 mb-4">
                        <div className="w-8 h-8 rounded-lg bg-[#7f4c12] flex items-center justify-center text-xs font-bold text-white shadow-sm border border-white/10">
                            {(user.displayName || user.email || 'U').charAt(0).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate text-white">{user.displayName || user.email}</p>
                            <p className="text-xs text-white/60 truncate capitalize">{user.role?.replace('_', ' ')}</p>
                        </div>
                    </div>
                    <button
                        onClick={() => signOut()}
                        className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-200 hover:bg-red-500/20 hover:text-white rounded-lg transition-colors border border-transparent hover:border-red-500/30"
                    >
                        <LogOut size={18} />
                        Sign Out
                    </button>
                </div>
            </aside >
        </>
    );
}

function NavLink({ link, pathname, closeMobile }: { link: any, pathname: string, closeMobile: () => void }) {
    const Icon = link.icon;
    const isActive = pathname === link.href;

    return (
        <Link
            href={link.href}
            onClick={closeMobile}
            className={cn(
                "flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 group",
                isActive
                    ? "bg-[#7f4c12] text-white shadow-lg shadow-black/20"
                    : "text-slate-200 hover:bg-white/10 hover:text-white"
            )}
        >
            <Icon size={18} className={cn("transition-colors", isActive ? "text-white" : "text-slate-300 group-hover:text-white")} />
            {link.label}
            {link.badge ? <span className="ml-auto bg-red-500 text-white text-[11px] font-bold rounded-full min-w-[20px] h-5 px-1.5 flex items-center justify-center" aria-label={`${link.badge} need attention`}>{link.badge}</span> : null}
        </Link>
    );
}
