"use client";

import DashboardLayout from "@/components/layout/DashboardLayout";
import React, { useState, useEffect } from "react";
import {
    collection,
    query,
    orderBy,
    getDocs,
    addDoc,
    updateDoc,
    doc,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { SocialPost, SocialPostStatus, SocialNetwork } from "@/lib/types";
import AssistantModal from "@/components/social/AssistantModal";
import CalendarView from "@/components/social/CalendarView";
import QuotaBar from "@/components/social/QuotaBar";
import FixHelpModal from "@/components/social/FixHelpModal";
import { FixHelp, checkMediaLink as checkPictureLink, diagnosePost, pictureProblem, mediaFields } from "@/lib/social/mediaCheck";
import MediaPreview from "@/components/social/MediaPreview";
import HealthBar, { Health, healthProblemFor } from "@/components/social/HealthBar";
import {
    Facebook,
    Instagram,
    Linkedin,
    Youtube,
    AtSign,
    Music2,
    ShieldAlert,
    ShieldCheck,
    Clock,
    CheckCircle2,
    XCircle,
    AlertTriangle,
    Trash2,
    Inbox,
    RefreshCw,
    Plus,
    X,
    Pencil,
    Send,
    Sparkles,
    List,
    CalendarDays,
    Copy,
    Archive,
    ArchiveRestore,
    Undo2,
    Eye,
    Wrench,
} from "lucide-react";
import { can } from "@/lib/permissions";
import { formatLondon, isoToLondon, londonToIso } from "@/lib/social/londonTime";
import { CONNECTED_NETWORKS_NOTE, NOT_CONNECTED_BADGE, SOCIAL_NETWORKS } from "@/lib/social/networks";

// 1 Oct 2026: anyone with the Social Media permission has total control. Failed, blocked,
// refused and rejected posts can be edited and sent back to draft; approved and scheduled
// posts can be edited (text, time, network) until they go out and stay approved; any post can
// be duplicated as a new draft or archived. Times are UK time (Europe/London) everywhere.
const ICONS: Record<SocialNetwork, any> = { facebook: Facebook, instagram: Instagram, threads: AtSign, linkedin: Linkedin, youtube: Youtube, tiktok: Music2 };
const NETWORK_META = Object.fromEntries(SOCIAL_NETWORKS.map(n => [n.key, { label: n.label, icon: ICONS[n.key], needsImage: n.needsImage, connected: n.connected }])) as Record<SocialNetwork, { label: string; icon: any; needsImage?: boolean; connected: boolean }>;

// Posts that went wrong or were turned down: edit them, or send them back to draft.
const BACK_TO_DRAFT: SocialPostStatus[] = ["failed", "blockedSafeguarding", "rejected", "refused"];
type ArchivablePost = SocialPost & { archived?: boolean; archivedAt?: string; archivedByName?: string; editedByName?: string; editedAt?: string; duplicatedFrom?: string };

// Conservative working limits. The platforms don't publish these in their APIs,
// so we enforce them here rather than letting a post fail on send.
const CHAR_LIMITS: Partial<Record<SocialNetwork, number>> = {
    facebook: 5000,
    instagram: 2200,
    threads: 500,
    linkedin: 3000,
};

const STATUS_META: Record<SocialPostStatus, { label: string; className: string; icon: any }> = {
    draft: { label: "Draft", className: "bg-slate-100 text-slate-700 border-slate-200", icon: Clock },
    approved: { label: "Approved, ready to publish", className: "bg-blue-50 text-blue-800 border-blue-200", icon: CheckCircle2 },
    published: { label: "Published", className: "bg-green-50 text-green-800 border-green-200", icon: CheckCircle2 },
    rejected: { label: "Rejected", className: "bg-slate-100 text-slate-600 border-slate-200", icon: XCircle },
    refused: { label: "Refused: no named approver", className: "bg-amber-50 text-amber-900 border-amber-200", icon: ShieldAlert },
    blockedSafeguarding: { label: "Blocked: consent not recorded", className: "bg-amber-50 text-amber-900 border-amber-300", icon: ShieldAlert },
    failed: { label: "Failed", className: "bg-red-50 text-red-800 border-red-200", icon: AlertTriangle },
    removed: { label: "Removed", className: "bg-slate-100 text-slate-500 border-slate-200", icon: Trash2 },
};

const EMPTY_DRAFT = {
    network: "facebook" as SocialNetwork,
    copy: "",
    mediaUrl: "",
    scheduledFor: "",
    containsPerson: false,
};

function formatWhen(value?: string | null) {
    if (!value) return "not set";
    const d = new Date(value);
    if (isNaN(d.getTime())) return value;
    return formatLondon(d, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** A stored instant as the value of a datetime-local input, in UK time (no one hour shift in summer). */
function toLocalInput(value?: string | null) {
    if (!value) return "";
    const t = isoToLondon(String(value));
    return t.date ? `${t.date}T${t.time}` : "";
}
/** A datetime-local value read as UK time, as an ISO instant. */
function fromLocalInput(value: string) {
    if (!value) return null;
    const [d, t] = value.split("T");
    return londonToIso(d, (t || "").slice(0, 5)) || null;
}

export default function SocialQueuePage() {
    const { user } = useAuth();
    const [posts, setPosts] = useState<ArchivablePost[]>([]);
    const [showArchived, setShowArchived] = useState(false);
    const [detailsPost, setDetailsPost] = useState<ArchivablePost | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState<"all" | "attention" | "published">("attention");
    const [view, setView] = useState<"list" | "calendar">("list");
    const [busyId, setBusyId] = useState<string | null>(null);

    // 6 Oct 2026: a pop-up that says in plain words what went wrong with a post and how to put
    // it back to work, and the picture links that did not load in this browser.
    const [help, setHelp] = useState<{ help: FixHelp; post?: SocialPost } | null>(null);
    const [brokenPics, setBrokenPics] = useState<Record<string, boolean>>({});
    const [checking, setChecking] = useState(false);
    // 7 Oct 2026: the latest connection check (n8n sm-health), to warn before a post would fail.
    const [health, setHealth] = useState<Health | null>(null);
    const [healthKey, setHealthKey] = useState(0);
    const connectionHelp = (post: SocialPost): FixHelp | null => {
        const c = healthProblemFor(health, post.network, (post as any).mediaSource === "heygen");
        return c ? {
            title: `${c.label} is not connected right now`,
            what: `${c.message} Posts to this network will fail until it is fixed.`,
            steps: [c.fix, "When Franco confirms it is fixed, come back here and press Publish now again (or leave the post for its scheduled time)."],
            canFixHere: false,
        } : null;
    };
    const markBroken = (url: string) => setBrokenPics((b) => (b[url] ? b : { ...b, [url]: true }));

    // Compose / edit
    const [composeOpen, setComposeOpen] = useState(false);
    const [assistantOpen, setAssistantOpen] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    // What kind of edit the compose window is doing.
    const [editMode, setEditMode] = useState<"new" | "draft" | "approved" | "backToDraft">("new");
    const [form, setForm] = useState({ ...EMPTY_DRAFT });
    const [formError, setFormError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    // Approval
    const [approvingPost, setApprovingPost] = useState<SocialPost | null>(null);
    const [consentName, setConsentName] = useState("");
    const [consentNote, setConsentNote] = useState("");
    const [approveError, setApproveError] = useState<string | null>(null);

    // Takedown
    const [takedownPost, setTakedownPost] = useState<SocialPost | null>(null);
    const [takedownReason, setTakedownReason] = useState("");
    const [takedownError, setTakedownError] = useState<string | null>(null);

    const canView = can(user, 'social_media');

    const load = async () => {
        setLoading(true);
        setError(null);
        try {
            const q = query(collection(db, "socialPosts"), orderBy("createdAt", "desc"));
            const snap = await getDocs(q);
            setPosts(snap.docs.map((d) => ({ id: d.id, ...d.data() })) as ArchivablePost[]);
        } catch (err: any) {
            setError(err?.message ?? "Could not load social posts.");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (canView) load();
        else setLoading(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canView]);
    useEffect(() => { if (notice) { const t = setTimeout(() => setNotice(null), 8000); return () => clearTimeout(t); } }, [notice]);

    // A failed or held back post opens the fix pop-up by itself, once per browser session for
    // each post, so nobody has to spot a red card halfway down the list to know what to do.
    useEffect(() => {
        if (loading || help) return;
        const stuck = posts.filter((p) => !p.archived && ["failed", "blockedSafeguarding", "refused"].includes(p.status));
        for (const p of stuck) {
            const key = `socialFixShown:${p.id}:${p.updatedAt ?? ""}`;
            let seen = false;
            try { seen = sessionStorage.getItem(key) === "1"; } catch { /* storage unavailable: show it */ }
            if (seen) continue;
            const h = diagnosePost(p, !!(p.mediaUrl && brokenPics[p.mediaUrl]));
            if (!h) continue;
            try { sessionStorage.setItem(key, "1"); } catch { /* ignore */ }
            setHelp({ help: h, post: p });
            break;
        }
    }, [loading, posts, help, brokenPics]);

    if (user && !canView) {
        return (
            <DashboardLayout>
                <div className="max-w-2xl">
                    <h1 className="text-2xl font-bold text-slate-800 mb-2">Social Media</h1>
                    <p className="text-slate-600">This section is restricted to administrators.</p>
                </div>
            </DashboardLayout>
        );
    }

    const openCompose = () => {
        setEditingId(null);
        setEditMode("new");
        setForm({ ...EMPTY_DRAFT });
        setFormError(null);
        setComposeOpen(true);
    };

    const openEdit = (post: SocialPost) => {
        setEditingId(post.id);
        setEditMode(post.status === "approved" ? "approved" : BACK_TO_DRAFT.includes(post.status) ? "backToDraft" : "draft");
        setForm({
            network: post.network,
            copy: post.copy ?? "",
            mediaUrl: post.mediaUrl ?? "",
            // UK time, so editing a scheduled time in summer no longer moves it by an hour.
            scheduledFor: toLocalInput(post.scheduledFor),
            containsPerson: !!post.containsPerson,
        });
        setFormError(null);
        setComposeOpen(true);
    };

    // A post clicked in the calendar opens the view that fits its status.
    const openFromCalendar = (post: SocialPost) => {
        if (post.status === "draft" || post.status === "approved" || BACK_TO_DRAFT.includes(post.status)) openEdit(post);
        else setDetailsPost(post as ArchivablePost);
    };

    const actor = () => ({ uid: user!.uid, name: user!.displayName || user!.email || "" });

    // Failed, blocked, refused and rejected posts go back to draft and need approving again.
    const backToDraft = async (post: SocialPost) => {
        setBusyId(post.id);
        try {
            await updateDoc(doc(db, "socialPosts", post.id), {
                status: "draft",
                approvedByUid: "",
                approvedByName: "",
                personConsentByUid: "",
                personConsentByName: "",
                publishNow: false,
                lastError: "",
                backToDraftByUid: actor().uid,
                backToDraftByName: actor().name,
                backToDraftAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            });
            setNotice("Back to draft. It needs approving again before it goes out.");
            await load();
        } catch (err: any) {
            setError(err?.message ?? "Could not move it back to draft.");
        } finally {
            setBusyId(null);
        }
    };

    // Any post as a new draft (a copy for another day or another network).
    const duplicate = async (post: SocialPost) => {
        setBusyId(post.id);
        try {
            const ref = await addDoc(collection(db, "socialPosts"), {
                network: post.network,
                copy: post.copy ?? "",
                ...mediaFields(post.mediaUrl ?? ""),
                scheduledFor: null,
                containsPerson: post.mediaUrl ? true : !!post.containsPerson,
                status: "draft",
                approvedByUid: "",
                approvedByName: "",
                personConsentByUid: "",
                personConsentByName: "",
                duplicatedFrom: post.id,
                createdByUid: actor().uid,
                createdByName: actor().name,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            });
            await load();
            // Open the copy straight away so it can be reworded or given a date.
            openEdit({ ...post, id: ref.id, status: "draft", scheduledFor: null, approvedByUid: "", approvedByName: "", personConsentByUid: "", personConsentByName: "" });
            setNotice("Copied as a new draft.");
        } catch (err: any) {
            setError(err?.message ?? "Could not duplicate the post.");
        } finally {
            setBusyId(null);
        }
    };

    // Archive hides an old post behind "Show archived". It changes nothing else.
    const setArchived = async (post: ArchivablePost, archived: boolean) => {
        if (archived && post.status === "approved") {
            setError("An approved post is still published even when archived. Reject it first if it should not go out, then archive it.");
            return;
        }
        setBusyId(post.id);
        try {
            await updateDoc(doc(db, "socialPosts", post.id), archived
                ? { archived: true, archivedAt: new Date().toISOString(), archivedByUid: actor().uid, archivedByName: actor().name }
                : { archived: false });
            setNotice(archived ? "Archived. Find it under Show archived." : "Restored from the archive.");
            await load();
        } catch (err: any) {
            setError(err?.message ?? "Could not change the archive.");
        } finally {
            setBusyId(null);
        }
    };

    const limit = CHAR_LIMITS[form.network];
    const overLimit = !!limit && form.copy.length > limit;
    const networkNeedsImage = !!NETWORK_META[form.network]?.needsImage;

    const saveDraft = async () => {
        setFormError(null);

        if (!form.copy.trim()) {
            setFormError("Write the post text first.");
            return;
        }
        if (overLimit) {
            setFormError(`Too long for ${NETWORK_META[form.network].label}: ${form.copy.length} of ${limit} characters.`);
            return;
        }
        if (networkNeedsImage && !form.mediaUrl.trim()) {
            setFormError(`${NETWORK_META[form.network].label} cannot post text on its own. Add a picture or video link.`);
            return;
        }
        if (form.mediaUrl.trim() && !/^https:\/\//i.test(form.mediaUrl.trim())) {
            setFormError("The picture or video link must start with https:// and be publicly reachable.");
            return;
        }

        const scheduledIso = fromLocalInput(form.scheduledFor);
        if (form.scheduledFor && !scheduledIso) {
            setFormError("That date or time is not valid.");
            return;
        }

        // 6 Oct 2026: a link to a web page (a HeyGen video, Canva, Google Drive...) or a picture
        // that does not open is caught here, not later at the network.
        if (form.mediaUrl.trim()) {
            setChecking(true);
            const problem = await checkPictureLink(form.mediaUrl.trim(), form.network);
            setChecking(false);
            if (problem) {
                setFormError(`${problem.title}. Not saved.`);
                setHelp({ help: problem });
                return;
            }
        }

        setSaving(true);
        try {
            const payload = {
                network: form.network,
                copy: form.copy.trim(),
                // Picture or video: a JPG, an MP4 or a HeyGen video link (6 Oct 2026).
                ...mediaFields(form.mediaUrl),
                // Read as UK time (Europe/London), whatever zone the computer is in.
                scheduledFor: scheduledIso,
                containsPerson: form.containsPerson,
                updatedAt: new Date().toISOString(),
            };

            if (editingId && editMode === "approved") {
                // An approved post stays approved: only the text, time and network change, and
                // who changed it is recorded. The picture and photo consent cannot change here.
                await updateDoc(doc(db, "socialPosts", editingId), {
                    network: payload.network,
                    copy: payload.copy,
                    scheduledFor: payload.scheduledFor,
                    editedByUid: actor().uid,
                    editedBy: actor().uid,
                    editedByName: actor().name,
                    editedAt: new Date().toISOString(),
                    updatedAt: payload.updatedAt,
                });
            } else if (editingId && editMode === "backToDraft") {
                await updateDoc(doc(db, "socialPosts", editingId), {
                    ...payload, status: "draft",
                    approvedByUid: "", approvedByName: "", personConsentByUid: "", personConsentByName: "",
                    publishNow: false, lastError: "",
                    backToDraftByUid: actor().uid, backToDraftByName: actor().name, backToDraftAt: new Date().toISOString(),
                });
            } else if (editingId) {
                await updateDoc(doc(db, "socialPosts", editingId), { ...payload, status: "draft" });
            } else {
                await addDoc(collection(db, "socialPosts"), {
                    ...payload,
                    status: "draft",
                    // The rules require these to be empty on create. Approval
                    // identity is only ever written by the approve action.
                    approvedByUid: "",
                    approvedByName: "",
                    personConsentByUid: "",
                    personConsentByName: "",
                    createdByUid: user!.uid,
                    createdByName: user!.displayName || user!.email,
                    createdAt: new Date().toISOString(),
                });
            }
            setComposeOpen(false);
            if (editMode === "approved") setNotice("Saved. The post is still approved and goes out as changed.");
            if (editMode === "backToDraft") setNotice("Saved as a draft. It needs approving again before it goes out.");
            await load();
        } catch (err: any) {
            setFormError(err?.code === "permission-denied"
                ? "The database refused the change. The post may have been published or changed by someone else in the meantime: refresh and try again."
                : err?.message ?? "Could not save.");
        } finally {
            setSaving(false);
        }
    };

    const beginApprove = (post: SocialPost) => {
        setApprovingPost(post);
        setConsentName("");
        setConsentNote("");
        setApproveError(null);
    };

    const confirmApprove = async () => {
        if (!approvingPost || !user) return;
        setApproveError(null);

        if (approvingPost.containsPerson && !consentName.trim()) {
            setApproveError("This post shows an identifiable person. Record who confirmed photo consent before approving.");
            return;
        }

        setBusyId(approvingPost.id);
        if (approvingPost.mediaUrl) {
            const problem = await checkPictureLink(approvingPost.mediaUrl, approvingPost.network);
            if (problem) {
                setBusyId(null);
                setApproveError(`${problem.title}. Not approved: it would fail when sent.`);
                setHelp({ help: problem, post: approvingPost });
                return;
            }
        }
        try {
            await updateDoc(doc(db, "socialPosts", approvingPost.id), {
                status: "approved",
                // Taken from the signed-in session, never typed. The Firestore
                // rules also require this to equal the caller's uid.
                approvedByUid: user.uid,
                approvedByName: user.displayName || user.email,
                approvedAt: new Date().toISOString(),
                personConsentByUid: approvingPost.containsPerson ? user.uid : "",
                personConsentByName: approvingPost.containsPerson ? consentName.trim() : "",
                consentNote: approvingPost.containsPerson ? consentNote.trim() : "",
                updatedAt: new Date().toISOString(),
            });
            setApprovingPost(null);
            await load();
            const down = connectionHelp(approvingPost);
            if (down) setHelp({ help: { ...down, what: `It is approved. ${down.what}` }, post: approvingPost });
        } catch (err: any) {
            setApproveError(err?.message ?? "Could not approve.");
        } finally {
            setBusyId(null);
        }
    };

    const reject = async (post: SocialPost) => {
        setBusyId(post.id);
        try {
            await updateDoc(doc(db, "socialPosts", post.id), {
                status: "rejected",
                approvedByUid: "",
                approvedByName: "",
                updatedAt: new Date().toISOString(),
            });
            await load();
        } catch (err: any) {
            setError(err?.message ?? "Could not reject.");
        } finally {
            setBusyId(null);
        }
    };

    const requestTakedown = async () => {
        if (!takedownPost || !user) return;
        setTakedownError(null);

        if (!takedownReason.trim()) {
            setTakedownError("Say why it's being removed. A takedown with no reason is unauditable.");
            return;
        }

        setBusyId(takedownPost.id);
        try {
            await updateDoc(doc(db, "socialPosts", takedownPost.id), {
                takedownRequested: true,
                takedownReason: takedownReason.trim(),
                takedownByUid: user.uid,
                takedownByName: user.displayName || user.email,
                takedownRequestedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            });
            setTakedownPost(null);
            setTakedownReason("");
            await load();
        } catch (err: any) {
            setTakedownError(err?.message ?? "Could not request the takedown.");
        } finally {
            setBusyId(null);
        }
    };

    const publishNow = async (post: SocialPost) => {
        const down = connectionHelp(post);
        if (down) { setHelp({ help: down, post }); return; }
        setBusyId(post.id);
        if (post.mediaUrl) {
            const problem = await checkPictureLink(post.mediaUrl, post.network);
            if (problem) {
                setBusyId(null);
                setHelp({ help: problem, post });
                return;
            }
        }
        try {
            await updateDoc(doc(db, "socialPosts", post.id), {
                publishNow: true,
                scheduledFor: null,
                updatedAt: new Date().toISOString(),
            });
            await load();
        } catch (err: any) {
            setError(err?.message ?? "Could not flag for publishing.");
        } finally {
            setBusyId(null);
        }
    };

    const needsAttention = (p: SocialPost) =>
        ["draft", "approved", "refused", "blockedSafeguarding", "failed"].includes(p.status);

    const live = posts.filter((p) => !p.archived);
    const archivedCount = posts.length - live.length;
    const visible = (showArchived ? posts.filter((p) => p.archived) : live).filter((p) => {
        if (showArchived) return true;
        if (filter === "attention") return needsAttention(p);
        if (filter === "published") return p.status === "published";
        return true;
    });

    // Things that actively went wrong, as opposed to things merely waiting on a
    // decision. These drive the banner, so a draft sitting patiently doesn't cry wolf.
    const needsFixing = live.filter((p) => ["failed", "blockedSafeguarding"].includes(p.status));
    const failedCount = live.filter((p) => p.status === "failed").length;
    const blockedCount = live.filter((p) => p.status === "blockedSafeguarding").length;

    const counts = {
        attention: live.filter(needsAttention).length,
        published: live.filter((p) => p.status === "published").length,
        all: live.length,
    };

    return (
        <DashboardLayout>
            <div className="max-w-6xl">
                <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
                    <div>
                        <h1 className="text-2xl font-bold text-slate-800">Social Media</h1>
                        <p className="text-slate-600 mt-1">Everything queued, published or blocked, across all networks.</p>
                    </div>
                    <div className="flex gap-2">
                        <button
                            onClick={() => { load(); setHealthKey((k) => k + 1); }}
                            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                        >
                            <RefreshCw size={16} />
                            Refresh
                        </button>
                        <button
                            onClick={() => setAssistantOpen(true)}
                            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-purple-700 rounded-lg hover:bg-purple-800"
                        >
                            <Sparkles size={16} />
                            Write with AI
                        </button>
                        <button
                            onClick={openCompose}
                            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-slate-800 rounded-lg hover:bg-slate-900"
                        >
                            <Plus size={16} />
                            New post
                        </button>
                    </div>
                </div>

                <QuotaBar />

                <HealthBar onLoaded={setHealth} refreshKey={healthKey} />

                <p className="mb-4 text-xs text-slate-500">{CONNECTED_NETWORKS_NOTE}</p>

                {notice && (
                    <div role="status" className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800 flex items-start gap-2">
                        <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0" />
                        <span className="flex-1">{notice}</span>
                        <button onClick={() => setNotice(null)} className="text-green-700 hover:text-green-900" aria-label="Close"><X size={16} /></button>
                    </div>
                )}

                {/* There are no email alerts by design — the Microsoft tenant blocks
                    SMTP, and enabling it would weaken mail security for one notification.
                    So this page has to be the thing that tells you something broke, which
                    means a failure cannot be a quiet red card halfway down a list. */}
                {!loading && needsFixing.length > 0 && (
                    <div className="mb-5 p-4 bg-red-50 border border-red-300 rounded-xl flex items-start gap-3">
                        <AlertTriangle size={20} className="text-red-700 flex-shrink-0 mt-0.5" />
                        <div className="flex-1">
                            <p className="font-medium text-red-900">
                                {needsFixing.length} post{needsFixing.length === 1 ? "" : "s"} need
                                {needsFixing.length === 1 ? "s" : ""} your attention
                            </p>
                            <p className="text-sm text-red-800 mt-0.5">
                                {failedCount > 0 && (
                                    <>
                                        {failedCount} failed to publish
                                        {blockedCount > 0 ? ". " : "."}
                                    </>
                                )}
                                {blockedCount > 0 && (
                                    <>{blockedCount} blocked because photo consent is not recorded.</>
                                )}
                            </p>
                        </div>
                        <button
                            onClick={() => {
                                setView("list");
                                setFilter("attention");
                                const first = needsFixing[0];
                                const h = first && diagnosePost(first, !!(first.mediaUrl && brokenPics[first.mediaUrl]));
                                if (h) setHelp({ help: h, post: first });
                            }}
                            className="px-3 py-1.5 text-sm font-medium text-white bg-red-700 rounded-lg hover:bg-red-800 flex-shrink-0"
                        >
                            Show me
                        </button>
                    </div>
                )}

                <div className="flex gap-2 mb-4 flex-wrap">
                    <button
                        onClick={() => setView("list")}
                        className={
                            "inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border " +
                            (view === "list"
                                ? "bg-slate-800 text-white border-slate-800"
                                : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50")
                        }
                    >
                        <List size={15} />
                        List
                    </button>
                    <button
                        onClick={() => setView("calendar")}
                        className={
                            "inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border " +
                            (view === "calendar"
                                ? "bg-slate-800 text-white border-slate-800"
                                : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50")
                        }
                    >
                        <CalendarDays size={15} />
                        Calendar
                    </button>
                </div>

                {view === "calendar" && !loading && !error && (
                    <CalendarView posts={live} onChanged={load} onOpen={openFromCalendar} />
                )}

                {view === "list" && (
                <div className="flex gap-2 mb-6 flex-wrap">
                    {([
                        ["attention", `Needs attention (${counts.attention})`],
                        ["published", `Published (${counts.published})`],
                        ["all", `Everything (${counts.all})`],
                    ] as const).map(([key, label]) => (
                        <button
                            key={key}
                            onClick={() => { setFilter(key); setShowArchived(false); }}
                            className={
                                "px-4 py-2 text-sm font-medium rounded-lg border " +
                                (filter === key && !showArchived
                                    ? "bg-slate-800 text-white border-slate-800"
                                    : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50")
                            }
                        >
                            {label}
                        </button>
                    ))}
                    <button
                        onClick={() => setShowArchived((v) => !v)}
                        className={
                            "inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg border " +
                            (showArchived ? "bg-amber-100 text-amber-900 border-amber-300" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50")
                        }
                    >
                        <Archive size={14} />
                        {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
                    </button>
                </div>
                )}

                {loading && (
                    <div className="flex items-center gap-3 text-slate-500 py-12">
                        <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-slate-400" />
                        Loading…
                    </div>
                )}

                {error && (
                    <div className="p-4 mb-4 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm">
                        <p className="font-medium mb-1">Something went wrong</p>
                        <p className="text-red-700">{error}</p>
                    </div>
                )}

                {view === "list" && !loading && !error && visible.length === 0 && (
                    <div className="text-center py-16 bg-white rounded-xl border border-slate-200">
                        <Inbox size={40} className="mx-auto text-slate-300 mb-3" />
                        <p className="text-slate-700 font-medium">Nothing here yet</p>
                        <p className="text-slate-500 text-sm mt-1">
                            {showArchived ? "Nothing is archived." : filter === "attention" ? "No posts are waiting on you." : "Nothing to show for this filter."}
                        </p>
                    </div>
                )}

                <div className="space-y-4">
                    {view === "list" && visible.map((post) => {
                        const net = NETWORK_META[post.network] ?? { label: post.network, icon: AtSign };
                        const st = STATUS_META[post.status] ?? STATUS_META.draft;
                        const NetIcon = net.icon;
                        const StatusIcon = st.icon;
                        const busy = busyId === post.id;
                        const broken = !!(post.mediaUrl && brokenPics[post.mediaUrl]);
                        const cardHelp = ["failed", "blockedSafeguarding", "refused"].includes(post.status)
                            ? diagnosePost(post, broken)
                            : ["draft", "approved"].includes(post.status)
                                ? pictureProblem(post.mediaUrl, post.network, broken)
                                : null;

                        return (
                            <div key={post.id} className="bg-white rounded-xl border border-slate-200 p-5 flex gap-5">
                                {post.mediaUrl ? (
                                    <MediaPreview
                                        url={post.mediaUrl}
                                        broken={!!(brokenPics[post.mediaUrl] || pictureProblem(post.mediaUrl, post.network, false))}
                                        onBroken={() => markBroken(post.mediaUrl!)}
                                        className="w-32 h-32 rounded-lg border border-slate-200 flex-shrink-0"
                                    />
                                ) : (
                                    <div className="w-32 h-32 rounded-lg bg-slate-50 border border-slate-200 flex items-center justify-center text-slate-400 text-xs flex-shrink-0">
                                        Text only
                                    </div>
                                )}

                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-3 mb-2 flex-wrap">
                                        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-700">
                                            <NetIcon size={16} />
                                            {net.label}
                                            {"connected" in net && !net.connected && (
                                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">{NOT_CONNECTED_BADGE}</span>
                                            )}
                                        </span>
                                        {post.archived && (
                                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border bg-amber-50 text-amber-900 border-amber-200">
                                                <Archive size={13} /> Archived
                                            </span>
                                        )}
                                        <span className={"inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border " + st.className}>
                                            <StatusIcon size={13} />
                                            {st.label}
                                        </span>
                                        {post.containsPerson && (
                                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border bg-purple-50 text-purple-900 border-purple-200">
                                                {post.personConsentByName ? (
                                                    <>
                                                        <ShieldCheck size={13} />
                                                        Consent: {post.personConsentByName}
                                                    </>
                                                ) : (
                                                    <>
                                                        <ShieldAlert size={13} />
                                                        Shows a person: no consent recorded
                                                    </>
                                                )}
                                            </span>
                                        )}
                                    </div>

                                    <p className="text-slate-800 whitespace-pre-wrap text-sm leading-relaxed mb-3">{post.copy}</p>

                                    <div className="flex gap-x-6 gap-y-1 text-xs text-slate-500 flex-wrap mb-3">
                                        <span>Scheduled: {formatWhen(post.scheduledFor)}</span>
                                        {post.approvedByName && <span>Approved by {post.approvedByName}</span>}
                                        {post.editedByName && <span>Edited by {post.editedByName}{post.editedAt ? ` on ${formatWhen(post.editedAt)}` : ""}</span>}
                                        {post.publishedAt && <span>Published {formatWhen(post.publishedAt)}</span>}
                                        {post.permalinkUrl && (
                                            <a href={post.permalinkUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                                                View post
                                            </a>
                                        )}
                                    </div>

                                    {post.lastError && (
                                        <p className="mb-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{post.lastError}</p>
                                    )}
                                    {cardHelp && (
                                        <button
                                            onClick={() => setHelp({ help: cardHelp, post })}
                                            className="mb-3 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-red-700 rounded-lg hover:bg-red-800"
                                        >
                                            <Wrench size={13} />
                                            How to fix: {cardHelp.title}
                                        </button>
                                    )}
                                    {post.takedownReason && (
                                        <p className="mb-3 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded px-3 py-2">
                                            Removed: {post.takedownReason}
                                        </p>
                                    )}

                                    <div className="flex gap-2 flex-wrap">
                                        {post.status === "approved" && (
                                            <button
                                                disabled={busy}
                                                onClick={() => openEdit(post)}
                                                title="Change the text, time or network before it goes out. It stays approved."
                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
                                            >
                                                <Pencil size={13} />
                                                Edit
                                            </button>
                                        )}
                                        {BACK_TO_DRAFT.includes(post.status) && (
                                            <>
                                                <button
                                                    disabled={busy}
                                                    onClick={() => openEdit(post)}
                                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
                                                >
                                                    <Pencil size={13} />
                                                    Edit
                                                </button>
                                                <button
                                                    disabled={busy}
                                                    onClick={() => backToDraft(post)}
                                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
                                                >
                                                    <Undo2 size={13} />
                                                    Back to draft
                                                </button>
                                            </>
                                        )}
                                        {(post.status === "published" || post.status === "removed") && (
                                            <button
                                                disabled={busy}
                                                onClick={() => setDetailsPost(post)}
                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
                                            >
                                                <Eye size={13} />
                                                Details
                                            </button>
                                        )}
                                        {post.status === "draft" && (
                                            <>
                                                <button
                                                    disabled={busy}
                                                    onClick={() => openEdit(post)}
                                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
                                                >
                                                    <Pencil size={13} />
                                                    Edit
                                                </button>
                                                <button
                                                    disabled={busy}
                                                    onClick={() => beginApprove(post)}
                                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-green-700 rounded-lg hover:bg-green-800 disabled:opacity-50"
                                                >
                                                    <CheckCircle2 size={13} />
                                                    Approve
                                                </button>
                                                <button
                                                    disabled={busy}
                                                    onClick={() => reject(post)}
                                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
                                                >
                                                    <XCircle size={13} />
                                                    Reject
                                                </button>
                                            </>
                                        )}

                                        {post.status === "published" && !(post as any).takedownRequested && (
                                            <button
                                                disabled={busy}
                                                onClick={() => {
                                                    setTakedownPost(post);
                                                    setTakedownReason("");
                                                    setTakedownError(null);
                                                }}
                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-800 bg-white border border-red-300 rounded-lg hover:bg-red-50 disabled:opacity-50"
                                            >
                                                <Trash2 size={13} />
                                                Take down
                                            </button>
                                        )}

                                        {post.status === "published" && (post as any).takedownRequested && (
                                            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-900 bg-amber-50 border border-amber-300 rounded-lg">
                                                <Clock size={13} />
                                                Takedown queued
                                            </span>
                                        )}

                                        {post.status === "approved" && (
                                            <button
                                                disabled={busy || (post as any).publishNow}
                                                onClick={() => publishNow(post)}
                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50"
                                            >
                                                <Send size={13} />
                                                {(post as any).publishNow ? "Queued to publish" : "Publish now"}
                                            </button>
                                        )}
                                        {post.status === "approved" && (
                                            <button
                                                disabled={busy}
                                                onClick={() => reject(post)}
                                                title="Stop it going out"
                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
                                            >
                                                <XCircle size={13} />
                                                Reject
                                            </button>
                                        )}
                                        <button
                                            disabled={busy}
                                            onClick={() => duplicate(post)}
                                            title="Copy it as a new draft"
                                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
                                        >
                                            <Copy size={13} />
                                            Duplicate
                                        </button>
                                        {post.archived ? (
                                            <button
                                                disabled={busy}
                                                onClick={() => setArchived(post, false)}
                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
                                            >
                                                <ArchiveRestore size={13} />
                                                Restore
                                            </button>
                                        ) : (
                                            <button
                                                disabled={busy || post.status === "approved"}
                                                onClick={() => setArchived(post, true)}
                                                title={post.status === "approved" ? "Reject it first: an approved post is still published even when archived." : "Hide it behind Show archived"}
                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
                                            >
                                                <Archive size={13} />
                                                Archive
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {assistantOpen && (
                <AssistantModal onClose={() => setAssistantOpen(false)} onSaved={load} />
            )}

            {/* Takedown */}
            {takedownPost && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center overflow-y-auto py-10 px-4">
                    <div className="bg-white rounded-xl w-full max-w-lg p-6">
                        <div className="flex items-center justify-between mb-4">
                            <h2 className="text-lg font-bold text-slate-800">Take this post down</h2>
                            <button onClick={() => setTakedownPost(null)} className="text-slate-400 hover:text-slate-700">
                                <X size={20} />
                            </button>
                        </div>

                        <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 mb-4">
                            <p className="text-sm text-slate-800 whitespace-pre-wrap">{takedownPost.copy}</p>
                        </div>

                        <div className="p-3 bg-red-50 border border-red-200 rounded-lg mb-4">
                            <p className="text-sm text-red-900">
                                <span className="font-medium">This cannot be undone.</span> Facebook and Instagram both
                                delete permanently: there is no unpublish. The record of the post and this reason stay
                                in the portal.
                            </p>
                        </div>

                        <label className="block text-sm font-medium text-slate-700 mb-1.5">
                            Why is it being removed? <span className="text-red-600">*</span>
                        </label>
                        <textarea
                            value={takedownReason}
                            onChange={(e) => setTakedownReason(e.target.value)}
                            rows={3}
                            placeholder="e.g. photo consent withdrawn by parent · wrong date in the copy · superseded"
                            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                        />
                        <p className="text-xs text-slate-500 mt-1">
                            Recorded against your name. A consent withdrawal you can&apos;t evidence is worse than useless.
                        </p>

                        {takedownError && (
                            <p className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                                {takedownError}
                            </p>
                        )}

                        <div className="flex justify-end gap-2 mt-5">
                            <button
                                onClick={() => setTakedownPost(null)}
                                className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={requestTakedown}
                                disabled={busyId === takedownPost.id || !takedownReason.trim()}
                                className="px-4 py-2 text-sm font-medium text-white bg-red-700 rounded-lg hover:bg-red-800 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                Remove it
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Compose / edit */}
            {composeOpen && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center overflow-y-auto py-10 px-4">
                    <div className="bg-white rounded-xl w-full max-w-2xl p-6">
                        <div className="flex items-center justify-between mb-5">
                            <h2 className="text-lg font-bold text-slate-800">{!editingId ? "New post" : editMode === "approved" ? "Edit approved post" : editMode === "backToDraft" ? "Edit and send back to draft" : "Edit draft"}</h2>
                            <button onClick={() => setComposeOpen(false)} className="text-slate-400 hover:text-slate-700">
                                <X size={20} />
                            </button>
                        </div>

                        {editMode === "approved" && (
                            <p className="mb-4 text-sm text-blue-900 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                                This post is approved. You can change the text, the time and the network until it goes out; it stays approved and your name is recorded as the person who edited it. To change the picture, duplicate it as a new draft.
                            </p>
                        )}
                        {editMode === "backToDraft" && (
                            <p className="mb-4 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                                Saving sends this post back to draft. It needs approving again before it goes out.
                            </p>
                        )}

                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1.5">Network</label>
                                <select
                                    value={form.network}
                                    onChange={(e) => setForm({ ...form, network: e.target.value as SocialNetwork })}
                                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                                >
                                    {(Object.keys(NETWORK_META) as SocialNetwork[]).map((n) => (
                                        <option key={n} value={n}>
                                            {NETWORK_META[n].label}
                                            {NETWORK_META[n].needsImage ? " (picture or video required)" : ""}
                                            {!NETWORK_META[n].connected ? ` (${NOT_CONNECTED_BADGE.toLowerCase()})` : ""}
                                        </option>
                                    ))}
                                </select>
                                <p className="text-xs text-slate-500 mt-1">
                                    One post per network. To publish the same story twice, create two posts and word each for its audience.
                                </p>
                                <p className="text-xs text-slate-500 mt-1">{CONNECTED_NETWORKS_NOTE}</p>
                            </div>

                            <div>
                                <div className="flex items-center justify-between mb-1.5">
                                    <label className="block text-sm font-medium text-slate-700">Post text</label>
                                    {limit && (
                                        <span className={"text-xs " + (overLimit ? "text-red-600 font-medium" : "text-slate-400")}>
                                            {form.copy.length} / {limit}
                                        </span>
                                    )}
                                </div>
                                <textarea
                                    value={form.copy}
                                    onChange={(e) => setForm({ ...form, copy: e.target.value })}
                                    rows={7}
                                    placeholder="Write the post as it should appear."
                                    className={
                                        "w-full px-3 py-2 border rounded-lg text-sm " +
                                        (overLimit ? "border-red-400" : "border-slate-300")
                                    }
                                />
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                                    Picture or video link {networkNeedsImage && <span className="text-red-600">*</span>}
                                </label>
                                <input
                                    type="url"
                                    disabled={editMode === "approved"}
                                    value={form.mediaUrl}
                                    onChange={(e) =>
                                        setForm({
                                            ...form,
                                            mediaUrl: e.target.value,
                                            // Anything with a picture in it is assumed to show a person
                                            // until someone says otherwise. The safe answer needs no thought.
                                            containsPerson: e.target.value.trim() ? true : form.containsPerson,
                                        })
                                    }
                                    placeholder="A HeyGen video link, or https://sovereignhousegh.com/wp-content/uploads/… (.jpg or .mp4)"
                                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm disabled:bg-slate-50 disabled:text-slate-500"
                                />
                                <p className="text-xs text-slate-500 mt-1">
                                    A video: paste the HeyGen share link (app.heygen.com/videos/…), or an MP4 from WordPress Media. Videos go to Facebook, Instagram (as a Reel) and Threads.
                                    A picture: copy the File URL from WordPress Media, ending in .jpg (Instagram rejects PNG and AVIF).
                                    Links to YouTube, Canva or Google Drive pages will not work.
                                </p>
                                {form.mediaUrl.trim() && pictureProblem(form.mediaUrl, form.network, false) && (
                                    <p className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
                                        {pictureProblem(form.mediaUrl, form.network, false)!.title}.{" "}
                                        <button type="button" className="underline font-medium" onClick={() => setHelp({ help: pictureProblem(form.mediaUrl, form.network, false)! })}>
                                            How to fix
                                        </button>
                                    </p>
                                )}
                                {form.mediaUrl.trim() && !pictureProblem(form.mediaUrl, form.network, false) && (
                                    <MediaPreview url={form.mediaUrl.trim()} className="mt-3 max-h-40 w-48 h-28 rounded-lg border border-slate-200" />
                                )}
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1.5">Schedule for, UK time (optional)</label>
                                <input
                                    type="datetime-local"
                                    value={form.scheduledFor}
                                    onChange={(e) => setForm({ ...form, scheduledFor: e.target.value })}
                                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                                />
                                <p className="text-xs text-slate-500 mt-1">Leave blank to publish as soon as it&apos;s approved and sent.</p>
                            </div>

                            <label className={`flex items-start gap-3 p-3 bg-purple-50 border border-purple-200 rounded-lg ${editMode === "approved" ? "opacity-60" : "cursor-pointer"}`}>
                                <input
                                    type="checkbox"
                                    disabled={editMode === "approved"}
                                    checked={form.containsPerson}
                                    onChange={(e) => setForm({ ...form, containsPerson: e.target.checked })}
                                    className="mt-0.5"
                                />
                                <span className="text-sm text-purple-900">
                                    <span className="font-medium">This shows an identifiable person</span>
                                    <span className="block text-xs mt-0.5 text-purple-800">
                                        If ticked, approval is blocked until someone records who confirmed photo consent. If you&apos;re unsure whether a
                                        person is identifiable, leave it ticked.
                                    </span>
                                </span>
                            </label>

                            {formError && (
                                <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{formError}</p>
                            )}
                        </div>

                        <div className="flex justify-end gap-2 mt-6">
                            <button
                                onClick={() => setComposeOpen(false)}
                                className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={saveDraft}
                                disabled={saving || checking}
                                className="px-4 py-2 text-sm font-medium text-white bg-slate-800 rounded-lg hover:bg-slate-900 disabled:opacity-50"
                            >
                                {checking ? "Checking the picture…" : saving ? "Saving…" : !editingId ? "Save as draft" : editMode === "backToDraft" ? "Save as draft" : editMode === "approved" ? "Save, keep approved" : "Save changes"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Details of a published or removed post (opened from the list or the calendar) */}
            {detailsPost && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center overflow-y-auto py-10 px-4">
                    <div className="bg-white rounded-xl w-full max-w-lg p-6">
                        <div className="flex items-center justify-between mb-4">
                            <h2 className="text-lg font-bold text-slate-800">{STATUS_META[detailsPost.status]?.label ?? detailsPost.status}</h2>
                            <button onClick={() => setDetailsPost(null)} className="text-slate-400 hover:text-slate-700" aria-label="Close">
                                <X size={20} />
                            </button>
                        </div>
                        <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 mb-4">
                            <p className="text-xs font-medium text-slate-500 mb-2">{NETWORK_META[detailsPost.network]?.label ?? detailsPost.network}</p>
                            {detailsPost.mediaUrl && <MediaPreview url={detailsPost.mediaUrl} className="w-48 h-28 rounded mb-3 border border-slate-200 block" />}
                            <p className="text-sm text-slate-800 whitespace-pre-wrap">{detailsPost.copy}</p>
                        </div>
                        <div className="text-sm text-slate-600 space-y-1 mb-4">
                            {detailsPost.publishedAt && <p>Published {formatWhen(detailsPost.publishedAt)}</p>}
                            {detailsPost.approvedByName && <p>Approved by {detailsPost.approvedByName}</p>}
                            {detailsPost.personConsentByName && <p>Photo consent confirmed by {detailsPost.personConsentByName}</p>}
                            {detailsPost.takedownReason && <p>Takedown reason: {detailsPost.takedownReason}</p>}
                            {detailsPost.permalinkUrl && <a href={detailsPost.permalinkUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">View post</a>}
                        </div>
                        <div className="flex flex-wrap justify-end gap-2">
                            <button onClick={() => { const p = detailsPost; setDetailsPost(null); duplicate(p); }} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50">
                                <Copy size={14} /> Duplicate as a new draft
                            </button>
                            {detailsPost.status === "published" && !(detailsPost as any).takedownRequested && (
                                <button onClick={() => { setTakedownPost(detailsPost); setTakedownReason(""); setTakedownError(null); setDetailsPost(null); }}
                                    className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-red-800 bg-white border border-red-300 rounded-lg hover:bg-red-50">
                                    <Trash2 size={14} /> Take down
                                </button>
                            )}
                            {detailsPost.status === "published" && (detailsPost as any).takedownRequested && (
                                <span className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-amber-900 bg-amber-50 border border-amber-300 rounded-lg"><Clock size={14} /> Takedown queued</span>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Approve */}
            {approvingPost && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center overflow-y-auto py-10 px-4">
                    <div className="bg-white rounded-xl w-full max-w-lg p-6">
                        <div className="flex items-center justify-between mb-4">
                            <h2 className="text-lg font-bold text-slate-800">Approve this post</h2>
                            <button onClick={() => setApprovingPost(null)} className="text-slate-400 hover:text-slate-700">
                                <X size={20} />
                            </button>
                        </div>

                        <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 mb-4">
                            <p className="text-xs font-medium text-slate-500 mb-2">
                                {NETWORK_META[approvingPost.network]?.label ?? approvingPost.network}
                            </p>
                            {approvingPost.mediaUrl && (
                                <MediaPreview url={approvingPost.mediaUrl} className="w-48 h-28 rounded mb-3 border border-slate-200 block" />
                            )}
                            <p className="text-sm text-slate-800 whitespace-pre-wrap">{approvingPost.copy}</p>
                        </div>

                        <p className="text-sm text-slate-600 mb-4">
                            This will be recorded as approved by <span className="font-medium text-slate-800">{user?.displayName || user?.email}</span>.
                        </p>

                        {approvingPost.containsPerson && (
                            <div className="p-4 bg-purple-50 border border-purple-200 rounded-lg mb-4 space-y-3">
                                <p className="text-sm text-purple-900 font-medium">This post shows an identifiable person</p>
                                <div>
                                    <label className="block text-xs font-medium text-purple-900 mb-1">
                                        Who confirmed photo consent? <span className="text-red-600">*</span>
                                    </label>
                                    <input
                                        value={consentName}
                                        onChange={(e) => setConsentName(e.target.value)}
                                        placeholder="Full name of the person who confirmed it"
                                        className="w-full px-3 py-2 border border-purple-300 rounded-lg text-sm"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-purple-900 mb-1">Note (optional)</label>
                                    <input
                                        value={consentNote}
                                        onChange={(e) => setConsentNote(e.target.value)}
                                        placeholder="e.g. signed consent on file, 2026 cohort"
                                        className="w-full px-3 py-2 border border-purple-300 rounded-lg text-sm"
                                    />
                                </div>
                            </div>
                        )}

                        {approveError && (
                            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">{approveError}</p>
                        )}

                        <div className="flex justify-end gap-2">
                            <button
                                onClick={() => setApprovingPost(null)}
                                className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={confirmApprove}
                                disabled={busyId === approvingPost.id || (approvingPost.containsPerson && !consentName.trim())}
                                className="px-4 py-2 text-sm font-medium text-white bg-green-700 rounded-lg hover:bg-green-800 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                Approve
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {/* What went wrong and how to fix it (6 Oct 2026) */}
            {help && (
                <FixHelpModal
                    help={help.help}
                    postLabel={help.post ? `${NETWORK_META[help.post.network]?.label ?? help.post.network} post: ${(help.post.copy || "").split("\n")[0].slice(0, 70)}` : undefined}
                    onClose={() => setHelp(null)}
                    onEdit={help.post && (help.post.status === "draft" || BACK_TO_DRAFT.includes(help.post.status))
                        ? () => { const p = help.post!; setHelp(null); setApprovingPost(null); openEdit(p); }
                        : undefined}
                />
            )}
        </DashboardLayout>
    );
}
