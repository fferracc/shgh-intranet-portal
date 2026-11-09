"use client";

// 30 Sep 2026: the Funders Report is replaced by the master Statistics page
// (/academy/statistics), which has every figure and builds print, Excel and Word reports.
// Old links and bookmarks land here and are sent on.
import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BarChart3 } from "lucide-react";

export default function ReportsPage() {
    const router = useRouter();
    useEffect(() => {
        const t = setTimeout(() => router.replace("/academy/statistics"), 1500);
        return () => clearTimeout(t);
    }, [router]);

    return (
        <div className="p-8">
            <div className="max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="flex items-center gap-2 font-semibold text-slate-900">
                    <BarChart3 size={18} className="text-[#2c4a00]" />
                    The Funders Report has moved
                </div>
                <p className="mt-2 text-sm text-slate-600">
                    Funder reports are now built on the Statistics page in Academy. Tick the figures you need and save them as a PDF, Excel or Word document. Taking you there now.
                </p>
                <Link href="/academy/statistics" className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[#2c4a00] px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
                    Open Statistics
                </Link>
            </div>
        </div>
    );
}
