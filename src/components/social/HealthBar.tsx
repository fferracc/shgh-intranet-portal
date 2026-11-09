"use client";

import React, { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { CheckCircle2, AlertTriangle, Clock } from "lucide-react";
import { formatLondon } from "@/lib/social/londonTime";

// 7 Oct 2026: the result of the connection check that n8n (sm-health) runs at 07:00 and 13:00.
// Green when Facebook, Instagram, Threads and HeyGen all answer; red with what to do when one
// does not, so a broken connection is seen before a post fails rather than after.
export interface HealthCheck { key: string; label: string; ok: boolean; message: string; fix: string }
export interface Health { ok: boolean; checkedAt: string; summary: string; checks: HealthCheck[] }

const STALE_HOURS = 26;

export function healthProblemFor(health: Health | null, network: string, heygen: boolean): HealthCheck | null {
    if (!health || health.ok) return null;
    const keys = network === "facebook" ? ["facebook", "facebook_posts"] : network === "instagram" ? ["instagram"] : network === "threads" ? ["threads"] : [];
    if (heygen) keys.push("heygen");
    return health.checks.find((c) => keys.includes(c.key) && !c.ok) ?? null;
}

export default function HealthBar({ onLoaded, refreshKey }: { onLoaded?: (h: Health | null) => void; refreshKey?: number }) {
    const [health, setHealth] = useState<Health | null>(null);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        let alive = true;
        getDoc(doc(db, "socialHealth", "latest"))
            .then((snap) => {
                if (!alive) return;
                const h = snap.exists() ? (snap.data() as Health) : null;
                setHealth(h);
                onLoaded?.(h);
            })
            .catch(() => { if (alive) onLoaded?.(null); })
            .finally(() => { if (alive) setLoaded(true); });
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [refreshKey]);

    if (!loaded) return null;
    if (!health) {
        return (
            <div className="mb-4 p-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-600 flex items-center gap-2">
                <Clock size={16} /> The connection check has not run yet.
            </div>
        );
    }

    const when = health.checkedAt ? formatLondon(new Date(health.checkedAt), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
    const stale = !health.checkedAt || Date.now() - new Date(health.checkedAt).getTime() > STALE_HOURS * 3600 * 1000;

    if (health.ok && !stale) {
        return (
            <div className="mb-4 px-3 py-2 bg-green-50 border border-green-200 rounded-xl text-sm text-green-800 flex items-center gap-2">
                <CheckCircle2 size={16} />
                Facebook, Instagram, Threads and HeyGen are connected. Checked {when}.
            </div>
        );
    }

    if (health.ok && stale) {
        return (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-900 flex items-start gap-2">
                <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
                <span>The connection check has not run since {when}. Posts may still go out, but tell Franco so he can look at n8n (workflow sm-health).</span>
            </div>
        );
    }

    const bad = health.checks.filter((c) => !c.ok);
    return (
        <div className="mb-5 p-4 bg-red-50 border border-red-300 rounded-xl" role="alert">
            <div className="flex items-start gap-3">
                <AlertTriangle size={20} className="text-red-700 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                    <p className="font-medium text-red-900">Some posts cannot go out right now</p>
                    <p className="text-sm text-red-800 mt-0.5">Checked {when}. Posts to these networks will fail until this is fixed. Franco has been emailed.</p>
                    <ul className="mt-2 space-y-2">
                        {bad.map((c) => (
                            <li key={c.key} className="text-sm">
                                <span className="font-medium text-red-900">{c.label}:</span>{" "}
                                <span className="text-red-800">{c.message}</span>
                                <span className="block text-red-900 mt-0.5">What to do: {c.fix}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            </div>
        </div>
    );
}
