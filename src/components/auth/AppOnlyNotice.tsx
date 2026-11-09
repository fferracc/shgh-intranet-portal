"use client";

// The portal is for super admins, admins and staff only (Franco, 29 Sep 2026).
// Volunteers use the SHGH app; accounts with no role yet see the same notice.
// This is the portal door only: Firestore rules still decide what data anyone can read,
// so the mobile app keeps working exactly as before for volunteers.
import { useAuth } from "@/contexts/AuthContext";
import { Smartphone } from "lucide-react";

export const PORTAL_ROLES = ["super_admin", "admin", "staff"];
export const isPortalRole = (role?: string | null) => PORTAL_ROLES.includes(String(role || ""));

export function AppOnlyNotice() {
    const { user, signOut } = useAuth();
    const volunteer = user?.role === "volunteer";
    return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
            <div className="max-w-md w-full bg-white rounded-2xl border shadow-sm p-6 text-center">
                <img src="/assets/logo.png" alt="Sovereign House GH" className="h-14 mx-auto mb-4" />
                <div className="mx-auto mb-3 w-12 h-12 rounded-full bg-blue-50 flex items-center justify-center text-blue-600"><Smartphone size={24} /></div>
                <h1 className="text-xl font-bold text-slate-800">{volunteer ? "Please use the SHGH app" : "Your account is not set up yet"}</h1>
                <p className="mt-2 text-sm text-slate-600">
                    {volunteer
                        ? "The portal is for Sovereign House GH staff. Everything you need as a volunteer is in the SHGH app: your classes, registers, hours, policies and chat."
                        : "Your account does not have access to the portal. If you think this is a mistake, please contact the Sovereign House GH team."}
                </p>
                {volunteer && (
                    <div className="mt-5 space-y-2">
                        <a href="https://shgh-lms1.web.app/" className="block w-full px-4 py-2.5 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700">Open the app in your browser</a>
                        <a href="https://shgh-lms1.web.app/app-updates/uk/uk-app.apk" className="block w-full px-4 py-2.5 rounded-lg border border-slate-300 font-semibold text-slate-700 hover:bg-slate-50">Download the Android app</a>
                    </div>
                )}
                <button onClick={() => signOut()} className="mt-4 text-sm text-slate-500 hover:text-slate-800 underline">Sign out</button>
            </div>
        </div>
    );
}
