"use client";

import React from "react";
import { PlayCircle, AlertTriangle } from "lucide-react";
import { mediaInfo } from "@/lib/social/mediaCheck";

// 6 Oct 2026: one preview for a post's picture or video. A HeyGen link cannot be shown
// here (HeyGen only hands the file to the publisher through its API), so it shows as a
// tile that opens the video in HeyGen.
export default function MediaPreview({
    url,
    className = "",
    broken = false,
    onBroken,
}: {
    url?: string;
    className?: string;
    broken?: boolean;
    onBroken?: () => void;
}) {
    if (!url) return null;
    if (broken) {
        return (
            <div className={`${className} bg-red-50 border border-red-200 text-red-700 flex flex-col items-center justify-center text-xs text-center px-2`}>
                <AlertTriangle size={18} className="mb-1" />
                Link not working
            </div>
        );
    }
    const info = mediaInfo(url);
    if (info.source === "heygen") {
        return (
            <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                title="Open the video in HeyGen"
                className={`${className} bg-purple-50 border border-purple-200 text-purple-900 flex flex-col items-center justify-center text-xs text-center px-2 hover:bg-purple-100`}
            >
                <PlayCircle size={28} className="mb-1" />
                HeyGen video
                <span className="text-[10px] text-purple-700 mt-0.5">Open in HeyGen</span>
            </a>
        );
    }
    if (info.kind === "video") {
        return <video src={url} className={`${className} object-cover bg-black`} muted controls preload="metadata" onError={onBroken} />;
    }
    return <img src={url} alt="" className={`${className} object-cover`} onError={onBroken} />;
}
