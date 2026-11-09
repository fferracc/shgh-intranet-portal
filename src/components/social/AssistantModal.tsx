"use client";

import React, { useState } from "react";
import { httpsCallable } from "firebase/functions";
import { collection, addDoc } from "firebase/firestore";
import { functions, db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { SocialNetwork } from "@/lib/types";
import { CONNECTED_NETWORKS_NOTE, NOT_CONNECTED_BADGE, SOCIAL_NETWORKS } from "@/lib/social/networks";
import { FixHelp, checkMediaLink as checkPictureLink, mediaFields } from "@/lib/social/mediaCheck";
import FixHelpModal from "@/components/social/FixHelpModal";
import {
    X,
    Sparkles,
    ArrowRight,
    ArrowLeft,
    Facebook,
    Instagram,
    Linkedin,
    Youtube,
    AtSign,
    Music2,
    ShieldAlert,
} from "lucide-react";

// Which networks are connected comes from one list (src/lib/social/networks.ts, 1 Oct 2026),
// so every screen says the same.
const ICONS: Record<SocialNetwork, any> = { facebook: Facebook, instagram: Instagram, threads: AtSign, linkedin: Linkedin, youtube: Youtube, tiktok: Music2 };
const NETWORKS: { key: SocialNetwork; label: string; icon: any; needsImage?: boolean; live: boolean }[] =
    SOCIAL_NETWORKS.map(n => ({ key: n.key, label: n.label, icon: ICONS[n.key], needsImage: n.needsImage, live: n.connected }));

const TONES = ["Warm and straightforward", "Announcement", "Celebration", "Educational", "Appeal"];

interface Draft {
    network: SocialNetwork;
    copy: string;
    save: boolean;
}

export default function AssistantModal({
    onClose,
    onSaved,
}: {
    onClose: () => void;
    onSaved: () => void;
}) {
    const { user } = useAuth();
    const [step, setStep] = useState<1 | 2>(1);
    const [generating, setGenerating] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // 6 Oct 2026: the same picture link check and fix pop-up as the Social Media page.
    const [help, setHelp] = useState<FixHelp | null>(null);

    const [brief, setBrief] = useState({
        whatHappened: "",
        audience: "",
        action: "",
        tone: TONES[0],
        extraNotes: "",
        mediaUrl: "",
        containsPerson: false,
        networks: ["facebook"] as SocialNetwork[],
    });

    const [drafts, setDrafts] = useState<Draft[]>([]);

    const toggleNetwork = (key: SocialNetwork) => {
        setBrief((b) => ({
            ...b,
            networks: b.networks.includes(key)
                ? b.networks.filter((n) => n !== key)
                : [...b.networks, key],
        }));
    };

    const imageRequiredBy = brief.networks.filter(
        (n) => NETWORKS.find((x) => x.key === n)?.needsImage
    );
    const missingImage = imageRequiredBy.length > 0 && !brief.mediaUrl.trim();

    const generate = async () => {
        setError(null);

        if (!brief.whatHappened.trim()) {
            setError("Tell the assistant what happened. That is the one thing it cannot invent.");
            return;
        }
        if (brief.networks.length === 0) {
            setError("Pick at least one network.");
            return;
        }
        if (missingImage) {
            setError(
                `${imageRequiredBy
                    .map((n) => NETWORKS.find((x) => x.key === n)?.label)
                    .join(" and ")} cannot post without a picture or video. Add a link or untick.`
            );
            return;
        }

        setGenerating(true);
        if (brief.mediaUrl.trim()) {
            // Instagram is the strictest (JPG only), so check against it when it is ticked.
            const strictest = brief.networks.includes("instagram" as SocialNetwork) ? ("instagram" as SocialNetwork) : brief.networks[0];
            const problem = await checkPictureLink(brief.mediaUrl.trim(), strictest);
            if (problem) {
                setGenerating(false);
                setError(`${problem.title}.`);
                setHelp(problem);
                return;
            }
        }
        try {
            const call = httpsCallable(functions, "socialDrafts");
            const res: any = await call({
                whatHappened: brief.whatHappened,
                audience: brief.audience,
                action: brief.action,
                tone: brief.tone,
                extraNotes: brief.extraNotes,
                networks: brief.networks,
                hasImage: !!brief.mediaUrl.trim(),
            });
            const returned: Draft[] = (res?.data?.drafts ?? []).map((d: any) => ({
                network: d.network,
                copy: d.copy ?? "",
                save: true,
            }));
            if (!returned.length) throw new Error("The assistant returned nothing. Try rephrasing the brief.");
            setDrafts(returned);
            setStep(2);
        } catch (err: any) {
            setError(err?.message ?? "Could not generate drafts.");
        } finally {
            setGenerating(false);
        }
    };

    const saveSelected = async () => {
        if (!user) return;
        setSaving(true);
        setError(null);
        try {
            const chosen = drafts.filter((d) => d.save && d.copy.trim());
            for (const d of chosen) {
                await addDoc(collection(db, "socialPosts"), {
                    network: d.network,
                    copy: d.copy.trim(),
                    ...mediaFields(brief.mediaUrl),
                    scheduledFor: null,
                    containsPerson: brief.containsPerson,
                    status: "draft",
                    // The rules require these empty on create. Approval identity
                    // is only ever written by the approve action.
                    approvedByUid: "",
                    approvedByName: "",
                    personConsentByUid: "",
                    personConsentByName: "",
                    createdByUid: user.uid,
                    createdByName: user.displayName || user.email,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                });
            }
            onSaved();
            onClose();
        } catch (err: any) {
            setError(err?.message ?? "Could not save drafts.");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center overflow-y-auto py-10 px-4">
            <div className="bg-white rounded-xl w-full max-w-3xl p-6">
                <div className="flex items-center justify-between mb-5">
                    <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                        <Sparkles size={18} className="text-purple-600" />
                        {step === 1 ? "Write with the assistant" : "Review the drafts"}
                    </h2>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
                        <X size={20} />
                    </button>
                </div>

                {step === 1 && (
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1.5">
                                What happened, or what do you want to say? <span className="text-red-600">*</span>
                            </label>
                            <textarea
                                value={brief.whatHappened}
                                onChange={(e) => setBrief({ ...brief, whatHappened: e.target.value })}
                                rows={3}
                                placeholder="Our Salford 50+ class visited Amazon last week and saw how a fulfilment centre uses technology."
                                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                            />
                            <p className="text-xs text-slate-500 mt-1">
                                One or two honest sentences about something real. This is the only thing the assistant
                                cannot invent, and it's what makes the difference between a good post and a generic one.
                            </p>
                        </div>

                        <div className="grid md:grid-cols-2 gap-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1.5">Who is it for?</label>
                                <input
                                    value={brief.audience}
                                    onChange={(e) => setBrief({ ...brief, audience: e.target.value })}
                                    placeholder="e.g. prospective learners over 50, or funders"
                                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                                    What should they do?
                                </label>
                                <input
                                    value={brief.action}
                                    onChange={(e) => setBrief({ ...brief, action: e.target.value })}
                                    placeholder="e.g. enrol, refer someone, get in touch"
                                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                                />
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1.5">Tone</label>
                            <select
                                value={brief.tone}
                                onChange={(e) => setBrief({ ...brief, tone: e.target.value })}
                                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                            >
                                {TONES.map((t) => (
                                    <option key={t} value={t}>
                                        {t}
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-2">Networks</label>
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                                {NETWORKS.map(({ key, label, icon: Icon, live }) => {
                                    const on = brief.networks.includes(key);
                                    return (
                                        <button
                                            key={key}
                                            type="button"
                                            onClick={() => toggleNetwork(key)}
                                            className={
                                                "flex items-center gap-2 px-3 py-2 rounded-lg border text-sm text-left " +
                                                (on
                                                    ? "bg-slate-800 text-white border-slate-800"
                                                    : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50")
                                            }
                                        >
                                            <Icon size={16} />
                                            <span className="flex-1">{label}</span>
                                            {!live && (
                                                <span
                                                    className={
                                                        "text-[10px] px-1.5 py-0.5 rounded " +
                                                        (on ? "bg-white/20" : "bg-amber-100 text-amber-800")
                                                    }
                                                >
                                                    {NOT_CONNECTED_BADGE}
                                                </span>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                            <p className="text-xs text-slate-500 mt-2">{CONNECTED_NETWORKS_NOTE}</p>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1.5">
                                Picture or video link {imageRequiredBy.length > 0 && <span className="text-red-600">*</span>}
                            </label>
                            <input
                                type="url"
                                value={brief.mediaUrl}
                                onChange={(e) =>
                                    setBrief({
                                        ...brief,
                                        mediaUrl: e.target.value,
                                        containsPerson: e.target.value.trim() ? true : brief.containsPerson,
                                    })
                                }
                                placeholder="A HeyGen video link, or a WordPress .jpg or .mp4 link"
                                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                            />
                            <p className="text-xs text-slate-500 mt-1">
                                A video: paste the HeyGen share link (app.heygen.com/videos/…), or an MP4 from WordPress Media. A picture: the WordPress Media File URL ending in .jpg.
                                Links to YouTube, Canva or Google Drive pages will not work.
                            </p>
                        </div>

                        <label className="flex items-start gap-3 p-3 bg-purple-50 border border-purple-200 rounded-lg cursor-pointer">
                            <input
                                type="checkbox"
                                checked={brief.containsPerson}
                                onChange={(e) => setBrief({ ...brief, containsPerson: e.target.checked })}
                                className="mt-0.5"
                            />
                            <span className="text-sm text-purple-900">
                                <span className="font-medium">Shows an identifiable person</span>
                                <span className="block text-xs mt-0.5 text-purple-800">
                                    Approval will be blocked until someone records who confirmed photo consent. If
                                    you're unsure, leave it ticked.
                                </span>
                            </span>
                        </label>

                        <details className="text-sm">
                            <summary className="cursor-pointer text-slate-600 hover:text-slate-800">
                                Anything else the assistant should know?
                            </summary>
                            <textarea
                                value={brief.extraNotes}
                                onChange={(e) => setBrief({ ...brief, extraNotes: e.target.value })}
                                rows={2}
                                placeholder="e.g. mention that spaces are limited, or that this is funded by Salford CVS"
                                className="w-full mt-2 px-3 py-2 border border-slate-300 rounded-lg text-sm"
                            />
                        </details>

                        {error && (
                            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                                {error}
                            </p>
                        )}

                        <div className="flex justify-end gap-2 pt-2">
                            <button
                                onClick={onClose}
                                className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={generate}
                                disabled={generating}
                                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-purple-700 rounded-lg hover:bg-purple-800 disabled:opacity-50"
                            >
                                {generating ? "Writing…" : "Write the drafts"}
                                {!generating && <ArrowRight size={16} />}
                            </button>
                        </div>
                    </div>
                )}

                {step === 2 && (
                    <div className="space-y-4">
                        <p className="text-sm text-slate-600">
                            Edit anything that doesn't sound right. Untick any you don't want to keep. Saved drafts still
                            need approving before they go anywhere.
                        </p>

                        {drafts.map((d, i) => {
                            const meta = NETWORKS.find((n) => n.key === d.network);
                            const Icon = meta?.icon ?? AtSign;
                            return (
                                <div key={i} className="border border-slate-200 rounded-lg p-4">
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
                                            <Icon size={16} />
                                            {meta?.label ?? d.network}
                                            {meta && !meta.live && (
                                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
                                                    {NOT_CONNECTED_BADGE}
                                                </span>
                                            )}
                                        </span>
                                        <label className="flex items-center gap-2 text-xs text-slate-600">
                                            <input
                                                type="checkbox"
                                                checked={d.save}
                                                onChange={(e) => {
                                                    const next = [...drafts];
                                                    next[i] = { ...d, save: e.target.checked };
                                                    setDrafts(next);
                                                }}
                                            />
                                            Keep
                                        </label>
                                    </div>
                                    <textarea
                                        value={d.copy}
                                        onChange={(e) => {
                                            const next = [...drafts];
                                            next[i] = { ...d, copy: e.target.value };
                                            setDrafts(next);
                                        }}
                                        rows={6}
                                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                                    />
                                    <p className="text-xs text-slate-400 mt-1">{d.copy.length} characters</p>
                                </div>
                            );
                        })}

                        {brief.containsPerson && (
                            <p className="text-xs text-purple-900 bg-purple-50 border border-purple-200 rounded-lg px-3 py-2 flex items-start gap-2">
                                <ShieldAlert size={14} className="mt-0.5 flex-shrink-0" />
                                These are marked as showing an identifiable person, so approval will stay blocked until
                                photo consent is recorded.
                            </p>
                        )}

                        {error && (
                            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                                {error}
                            </p>
                        )}

                        <div className="flex justify-between gap-2 pt-2">
                            <button
                                onClick={() => setStep(1)}
                                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                            >
                                <ArrowLeft size={16} />
                                Back to the brief
                            </button>
                            <button
                                onClick={saveSelected}
                                disabled={saving || !drafts.some((d) => d.save)}
                                className="px-4 py-2 text-sm font-medium text-white bg-slate-800 rounded-lg hover:bg-slate-900 disabled:opacity-50"
                            >
                                {saving ? "Saving…" : `Save ${drafts.filter((d) => d.save).length} draft(s)`}
                            </button>
                        </div>
                    </div>
                )}
            </div>
            {help && <FixHelpModal help={help} onClose={() => setHelp(null)} />}
        </div>
    );
}
