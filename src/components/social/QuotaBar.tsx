"use client";

import React, { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Linkedin, Music2, Gauge, AlertTriangle } from "lucide-react";

// Upload-Post is the only route we have to LinkedIn pages and to public TikTok
// posts, and its free tier allows ten uploads a month across the whole account.
// That allowance is shared, not one pool per platform, which is the thing people
// get wrong, so this strip says it in words rather than leaving it to be inferred.
//
// The number is written by the n8n workflow sm-uploadpost-quota, which reads
// Upload-Post's own upload history every hour. Nothing here writes, and nothing
// here counts on its own: if the portal and the provider ever disagree, the
// provider is right and this strip is stale.

type Quota = {
    month: string;
    limit: number;
    used: number;
    remaining: number;
    byPlatform?: Record<string, number>;
    updatedAt?: string;
};

const toNumber = (v: any): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};

export default function QuotaBar() {
    const [quota, setQuota] = useState<Quota | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const snap = await getDoc(doc(db, "socialQuota", "current"));
                if (cancelled) return;
                if (!snap.exists()) {
                    setFailed(true);
                    return;
                }
                const d = snap.data() as any;
                setQuota({
                    month: d.month ?? "",
                    limit: toNumber(d.limit),
                    used: toNumber(d.used),
                    remaining: toNumber(d.remaining),
                    byPlatform: d.byPlatform ?? {},
                    updatedAt: d.updatedAt ?? "",
                });
            } catch {
                if (!cancelled) setFailed(true);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    if (failed) {
        return (
            <div className="mb-5 p-3 bg-slate-50 border border-slate-200 rounded-xl flex items-center gap-2 text-sm text-slate-600">
                <AlertTriangle size={16} className="text-slate-500" />
                Upload-Post allowance unknown. The hourly check has not written a figure yet.
            </div>
        );
    }

    if (!quota) return null;

    const limit = quota.limit || 10;
    const used = Math.min(quota.used, limit);
    const remaining = Math.max(0, limit - used);
    const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;

    const linkedin = toNumber(quota.byPlatform?.linkedin);
    const tiktok = toNumber(quota.byPlatform?.tiktok);

    const tone =
        remaining === 0
            ? { bar: "bg-red-600", box: "bg-red-50 border-red-300", text: "text-red-900" }
            : remaining <= 3
              ? { bar: "bg-amber-500", box: "bg-amber-50 border-amber-300", text: "text-amber-900" }
              : { bar: "bg-emerald-600", box: "bg-white border-slate-200", text: "text-slate-800" };

    const monthLabel = quota.month
        ? new Date(quota.month + "-01T00:00:00Z").toLocaleDateString("en-GB", {
              month: "long",
              year: "numeric",
              timeZone: "UTC",
          })
        : "this month";

    return (
        <div className={"mb-5 p-4 border rounded-xl " + tone.box}>
            <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-2">
                    <Gauge size={18} className="text-slate-500" />
                    <div>
                        <p className={"font-medium " + tone.text}>
                            {remaining} of {limit} Upload-Post sends left in {monthLabel}
                        </p>
                        <p className="text-xs text-slate-600 mt-0.5">
                            Shared between LinkedIn and TikTok, not one allowance each. Facebook, Instagram
                            and Threads publish directly and do not touch this.
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-4 text-sm text-slate-700">
                    <span className="flex items-center gap-1.5">
                        <Linkedin size={15} className="text-slate-500" />
                        {linkedin} sent
                    </span>
                    <span className="flex items-center gap-1.5">
                        <Music2 size={15} className="text-slate-500" />
                        {tiktok} sent
                    </span>
                </div>
            </div>

            <div className="mt-3 h-2 w-full bg-slate-200 rounded-full overflow-hidden">
                <div className={"h-full " + tone.bar} style={{ width: pct + "%" }} />
            </div>

            {remaining === 0 && (
                <p className="text-xs text-red-800 mt-2">
                    The allowance is spent. LinkedIn and TikTok posts will be refused until the month
                    turns, or until the plan is upgraded.
                </p>
            )}

            {quota.updatedAt && (
                <p className="text-[11px] text-slate-500 mt-2">
                    Checked {new Date(quota.updatedAt).toLocaleString("en-GB")}. Refreshed hourly.
                </p>
            )}
        </div>
    );
}
