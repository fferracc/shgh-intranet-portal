"use client";

import { useAuth } from "@/contexts/AuthContext";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Sidebar } from "./Sidebar";
import { signInUrl } from "@/components/auth/RequirePermission";
import { AppOnlyNotice, isPortalRole } from "@/components/auth/AppOnlyNotice";

export default function DashboardLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const { user, loading } = useAuth();
    const router = useRouter();

    useEffect(() => {
        if (!loading && !user) {
            router.push(signInUrl());
        }
    }, [user, loading, router]);

    if (loading) {
        return (
            <div className="flex items-center justify-center h-screen bg-slate-50">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
            </div>
        );
    }

    if (!user) return null;
    if (!isPortalRole(user.role)) return <AppOnlyNotice />;

    return (
        <div className="flex h-screen bg-slate-100 print:block print:h-auto print:bg-white">
            <Sidebar />
            <main className="flex-1 overflow-y-auto px-8 pb-8 pt-24 relative print:overflow-visible print:p-0 print:block">
                {/* Brand Logo - Top Right */}
                <div className="absolute top-4 right-8 z-10 w-16 h-16 pointer-events-none opacity-90">
                    <img
                        src="/assets/logo.png"
                        alt="Sovereign House GH Logo"
                        className="w-full h-full object-contain"
                    />
                </div>
                {children}
            </main>
        </div>
    );
}
