"use client";

import { useAuth } from "@/contexts/AuthContext";
import { can, PermissionKey, PERMISSION_CATALOG } from "@/lib/permissions";
import { ShieldAlert } from "lucide-react";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { AppOnlyNotice, isPortalRole } from "./AppOnlyNotice";

/** The sign-in page, remembering where to come back to (29 Sep 2026). */
export function signInUrl(): string {
    if (typeof window === "undefined") return "/";
    return `/?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
}

/**
 * Page level guard. Hiding a sidebar link does not stop someone typing the URL,
 * so every restricted page wraps its content in this.
 *
 * Firestore rules are still the real protection; this only stops the page rendering.
 */
export function RequirePermission({
    perm,
    children,
}: {
    perm: PermissionKey;
    children: React.ReactNode;
}) {
    const { user, loading } = useAuth();
    const router = useRouter();

    // Not signed in (for example after clicking a link in an email): go to the
    // sign-in page and come back here, instead of saying "no permission".
    useEffect(() => {
        if (!loading && !user) router.replace(signInUrl());
    }, [loading, user, router]);

    if (loading || !user) {
        return <div className="p-8 text-slate-400">Loading…</div>;
    }

    if (!isPortalRole(user.role)) return <AppOnlyNotice />;

    if (!can(user, perm)) {
        const label = PERMISSION_CATALOG.find(p => p.key === perm)?.label || perm;
        return (
            <div className="p-8">
                <div className="max-w-md rounded-xl border border-amber-200 bg-amber-50 p-6">
                    <div className="flex items-center gap-2 text-amber-700 font-semibold">
                        <ShieldAlert size={18} />
                        Access denied
                    </div>
                    <p className="mt-2 text-sm text-amber-800">
                        You do not have the <strong>{label}</strong> permission.
                        Ask a super admin to grant it from Users &amp; Permissions.
                    </p>
                </div>
            </div>
        );
    }

    return <>{children}</>;
}
