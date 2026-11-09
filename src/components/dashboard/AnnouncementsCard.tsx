"use client";

// Dashboard announcements card (30 Sep 2026). Self contained: it loads the live
// announcements the signed-in person may see (portal users: staff and everyone), shows the
// three newest, opens the full text in a modal, and lists every live one under "See all".
// Rules: src/lib/announcements.ts.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Announcement, loadLiveAnnouncementsFor, SEVERITY_STYLE, shortUkDate } from "@/lib/announcements";
import { AlertCircle, Megaphone, X } from "lucide-react";

const SHOWN = 3;

export default function AnnouncementsCard() {
    const { user } = useAuth();
    const role = user?.role;
    const { data, isLoading, isError, refetch } = useQuery({
        queryKey: ["announcements", "live", role],
        queryFn: () => loadLiveAnnouncementsFor(role),
        enabled: !!user,
    });
    const [open, setOpen] = useState<Announcement | null>(null);
    const [showAll, setShowAll] = useState(false);

    const all = data || [];
    const newest = all.slice(0, SHOWN);

    return (
        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
            <div className="flex items-center justify-between gap-2 mb-4">
                <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                    <Megaphone size={18} className="text-yellow-600" /> Announcements
                </h3>
                {all.length > 0 && (
                    <button onClick={() => setShowAll(true)} className="text-xs font-medium text-blue-600 hover:text-blue-800">
                        See all ({all.length})
                    </button>
                )}
            </div>

            {isLoading || !user ? (
                <div className="space-y-3" aria-label="Loading announcements">
                    {[0, 1].map(i => <div key={i} className="h-16 rounded-lg bg-slate-100 animate-pulse" />)}
                </div>
            ) : isError ? (
                <div className="p-4 bg-red-50 border border-red-100 rounded-lg text-sm text-red-700 flex items-center justify-between gap-3">
                    <span>Announcements could not be loaded.</span>
                    <button onClick={() => refetch()} className="text-xs font-semibold underline">Try again</button>
                </div>
            ) : newest.length === 0 ? (
                <div className="p-4 bg-slate-50 border border-slate-100 rounded-lg text-center text-slate-400 text-sm">
                    No new announcements.
                </div>
            ) : (
                <div className="space-y-3">
                    {newest.map(a => <AnnouncementRow key={a.id} a={a} onOpen={() => setOpen(a)} />)}
                </div>
            )}

            {showAll && !open && (
                <CardModal title="All announcements" onClose={() => setShowAll(false)}>
                    <div className="space-y-3">
                        {all.map(a => <AnnouncementRow key={a.id} a={a} onOpen={() => setOpen(a)} />)}
                    </div>
                </CardModal>
            )}

            {open && (
                <CardModal title={open.title} onClose={() => setOpen(null)}>
                    <div className="flex flex-wrap items-center gap-2 mb-4">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${SEVERITY_STYLE[open.severity].badge}`}>{SEVERITY_STYLE[open.severity].label}</span>
                        {open.createdDay && <span className="text-xs text-slate-400">Posted {shortUkDate(open.createdDay)}{open.createdBy ? ` by ${open.createdBy}` : ""}</span>}
                        {open.expiresAt && <span className="text-xs text-slate-400">Shown until {shortUkDate(open.expiresAt)}</span>}
                    </div>
                    <p className="text-sm text-slate-700 whitespace-pre-line break-words">{open.content}</p>
                    {showAll && (
                        <button onClick={() => setOpen(null)} className="mt-6 text-sm font-medium text-blue-600 hover:text-blue-800">Back to all announcements</button>
                    )}
                </CardModal>
            )}
        </div>
    );
}

function AnnouncementRow({ a, onOpen }: { a: Announcement; onOpen: () => void }) {
    const s = SEVERITY_STYLE[a.severity];
    return (
        <button onClick={onOpen} className={`w-full text-left p-4 border rounded-lg flex gap-3 transition-colors ${s.card}`}>
            <AlertCircle className={`flex-shrink-0 ${s.title}`} size={20} />
            <div className="overflow-hidden min-w-0">
                <div className="flex items-center gap-2">
                    <span className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${s.badge}`}>{s.label}</span>
                    {a.createdDay && <span className="text-xs text-slate-500">{shortUkDate(a.createdDay)}</span>}
                </div>
                <h4 className={`text-sm font-bold truncate mt-1 ${s.title}`}>{a.title}</h4>
                <p className={`text-xs mt-1 line-clamp-2 ${s.text}`}>{a.content}</p>
            </div>
        </button>
    );
}

function CardModal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
            <div role="dialog" aria-modal="true" className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
                <div className="flex items-start justify-between gap-4 mb-4">
                    <h2 className="text-lg font-bold text-slate-800 break-words">{title}</h2>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Close"><X size={20} /></button>
                </div>
                {children}
            </div>
        </div>
    );
}

export { AnnouncementsCard };
