// 6 Oct 2026. An Instagram post failed with "The platform rejected this post" because its
// link was a HeyGen video page, and the publishers could only send pictures.
//
// Since then (same day, evening) posts can carry a picture or a video:
//   * a picture: a direct link to a JPG (WordPress Media);
//   * a video: a HeyGen video link (app.heygen.com/videos/...), which n8n turns into the video
//     file through the HeyGen API at the moment of publishing, or a direct link to an MP4 file.
// Video goes to Facebook, Instagram (as a Reel) and Threads.
//
// This file:
//   1. reads what kind of media a link is (mediaInfo);
//   2. checks a link before a post is saved, approved or sent (checkMediaLink);
//   3. turns a failed or held back post into plain, numbered steps (diagnosePost), shown as a
//      pop-up on the Social Media page.
import type { SocialNetwork, SocialPost } from "@/lib/types";

export interface FixHelp {
    title: string;
    /** What went wrong, in plain words. */
    what: string;
    /** What to do, in order. */
    steps: string[];
    /** False when the fix is not in the post itself (for example the Meta or HeyGen connection). */
    canFixHere: boolean;
}

export type MediaKind = "image" | "video";
export interface MediaInfo {
    kind: MediaKind;
    source: "heygen" | "url";
    heygenVideoId?: string;
}

/** Networks the portal can send a video to. */
export const VIDEO_NETWORKS: SocialNetwork[] = ["facebook", "instagram", "threads"];
/** Longest video each network takes through the API, in seconds; shortest is 3 s for Instagram. */
const VIDEO_MAX_SECONDS: Partial<Record<SocialNetwork, number>> = { instagram: 15 * 60, threads: 5 * 60, facebook: 4 * 60 * 60 };

// Links to web pages that show a picture or video but are not the file itself.
const PAGE_HOSTS: [RegExp, string, boolean][] = [
    [/(^|\.)(youtube\.com|youtu\.be)$/i, "a YouTube page", true],
    [/(^|\.)vimeo\.com$/i, "a Vimeo page", true],
    [/(^|\.)(canva\.com|canva\.link)$/i, "a Canva design page", false],
    [/(^|\.)(drive\.google\.com|docs\.google\.com|photos\.google\.com|photos\.app\.goo\.gl)$/i, "a Google Drive or Google Photos page", false],
    [/(^|\.)(sharepoint\.com|onedrive\.live\.com|1drv\.ms)$/i, "a OneDrive or SharePoint page", false],
    [/(^|\.)dropbox\.com$/i, "a Dropbox page", false],
    [/(^|\.)(facebook\.com|fb\.watch|instagram\.com|tiktok\.com|linkedin\.com|threads\.net|x\.com|twitter\.com)$/i, "a social media page", false],
];
const HEYGEN_HOST = /(^|\.)heygen\.com$/i;
const VIDEO_FILE = /\.(mp4|mov|m4v)(\?|#|$)/i;
const OTHER_VIDEO_FILE = /\.(webm|avi|mkv|wmv)(\?|#|$)/i;
const NOT_JPEG = /\.(png|webp|gif|avif|heic|heif|bmp|svg|tiff?)(\?|#|$)/i;

const UPLOAD_STEPS = [
    "Open WordPress (sovereignhousegh.com/wp-admin), go to Media and click Add New.",
    "Upload the picture as a JPG file. Photos from a phone or camera are usually JPG already.",
    "Click the uploaded picture, then Copy URL to clipboard. The link ends in .jpg.",
    "Back here, click Edit on the post and paste that link into Picture or video link, replacing the old one. If the post is approved, click Reject first, then Back to draft, then Edit.",
    "Save, click Approve, then Publish now (or leave it for its scheduled time).",
];
const HEYGEN_STEPS = [
    "In HeyGen, open the video (it must have finished rendering) and click Share.",
    "Copy the link. It looks like app.heygen.com/videos/... and ends in a long code.",
    "Back here, click Edit on the post and paste that link into Picture or video link. If the post is approved, click Reject first, then Back to draft, then Edit.",
    "Save, click Approve, then Publish now (or leave it for its scheduled time).",
];
const AGAIN = "Click Back to draft, then Approve it again and press Publish now (or leave it for its scheduled time).";

function hostOf(url: string): string {
    try { return new URL(url).hostname; } catch { return ""; }
}

/** The HeyGen video id inside a HeyGen video or share link, or null. */
export function heygenVideoId(url: string): string | null {
    const u = (url || "").trim();
    if (!HEYGEN_HOST.test(hostOf(u))) return null;
    let path = "";
    try { path = new URL(u).pathname; } catch { return null; }
    const m = path.match(/\/(?:videos?|share|embed|embeds)\/(?:[a-z0-9-]*-)?([0-9a-f]{32})(?:\/|$)/i);
    return m ? m[1].toLowerCase() : null;
}

/** What kind of media a link is. */
export function mediaInfo(url: string): MediaInfo {
    const id = heygenVideoId(url);
    if (id) return { kind: "video", source: "heygen", heygenVideoId: id };
    if (VIDEO_FILE.test((url || "").trim())) return { kind: "video", source: "url" };
    return { kind: "image", source: "url" };
}

/** Fields stored on the post for its media link. */
export function mediaFields(url: string) {
    const u = (url || "").trim();
    if (!u) return { mediaUrl: "", mediaType: "none" as const, mediaSource: "", heygenVideoId: "" };
    const info = mediaInfo(u);
    return { mediaUrl: u, mediaType: info.kind, mediaSource: info.source, heygenVideoId: info.heygenVideoId ?? "" };
}

function noVideoHere(network?: SocialNetwork): FixHelp {
    return {
        title: "This network cannot take a video from the portal yet",
        what: `Videos can go to Facebook, Instagram and Threads. ${network ? network.charAt(0).toUpperCase() + network.slice(1) : "This network"} is not connected for video yet.`,
        steps: ["Click Edit and choose Facebook, Instagram or Threads, or use a picture instead of the video.", "Save, click Approve, then Publish now."],
        canFixHere: true,
    };
}

/** Problems that can be seen from the link alone, with no network call. */
export function linkProblem(url: string, network?: SocialNetwork): FixHelp | null {
    const u = (url || "").trim();
    if (!u) return null;

    if (!/^https:\/\//i.test(u) || !hostOf(u)) {
        return {
            title: "The link is not a web address",
            what: "The picture or video link must be a full web link starting with https://.",
            steps: UPLOAD_STEPS,
            canFixHere: true,
        };
    }

    const host = hostOf(u);
    if (HEYGEN_HOST.test(host)) {
        if (!heygenVideoId(u)) {
            return {
                title: "This HeyGen link is not a video link",
                what: "The link goes to HeyGen but not to one video. The portal needs the share link of the finished video.",
                steps: HEYGEN_STEPS,
                canFixHere: true,
            };
        }
        return network && !VIDEO_NETWORKS.includes(network) ? noVideoHere(network) : null;
    }

    const page = PAGE_HOSTS.find(([re]) => re.test(host));
    if (page) {
        const [, label, isVideo] = page;
        return {
            title: "The link is a web page, not a picture or video",
            what: `The link is ${label} (${host}). The networks need the picture or video file itself, or a HeyGen video link, so they turn the post down.`,
            steps: isVideo
                ? [
                    "If the video was made in HeyGen, use its HeyGen link instead:",
                    ...HEYGEN_STEPS.slice(0, 2),
                    "Otherwise download the video as an MP4 file, upload it in WordPress (Media, Add New) and copy its URL. The link ends in .mp4.",
                    "Back here, click Edit on the post and paste the link into Picture or video link, then Save, Approve and Publish now.",
                ]
                : UPLOAD_STEPS,
            canFixHere: true,
        };
    }

    if (OTHER_VIDEO_FILE.test(u)) {
        return {
            title: "This video format is not accepted",
            what: "The networks take MP4 or MOV videos. This link is a different kind of video file.",
            steps: [
                "Save or export the video as MP4 (HeyGen downloads are MP4 already).",
                "Upload it in WordPress (Media, Add New) and copy its URL. The link ends in .mp4.",
                "Back here, click Edit on the post and paste the link into Picture or video link, then Save, Approve and Publish now.",
            ],
            canFixHere: true,
        };
    }

    if (VIDEO_FILE.test(u)) {
        return network && !VIDEO_NETWORKS.includes(network) ? noVideoHere(network) : null;
    }

    if (network === "instagram" && NOT_JPEG.test(u)) {
        return {
            title: "Instagram only takes JPG pictures",
            what: "This picture is not a JPG (it looks like PNG, WebP, GIF or similar). Instagram turns these down.",
            steps: [
                "Open the picture on your computer and save or export it as JPG (in Windows: open it in Paint, then File, Save as, JPEG picture).",
                ...UPLOAD_STEPS.slice(0, 1),
                ...UPLOAD_STEPS.slice(2),
            ],
            canFixHere: true,
        };
    }
    return null;
}

/** A link that should be a picture or video but does not open as one in this browser. */
export function brokenLinkHelp(kind: MediaKind = "image"): FixHelp {
    const thing = kind === "video" ? "video" : "picture";
    return {
        title: `The link does not open as a ${thing}`,
        what: `The link could not be opened as a ${thing}. It may be private, deleted, mistyped, or a web page rather than the file.`,
        steps: [
            `Paste the link into a new browser tab. It should show the ${thing} on its own, nothing else.`,
            "If it does not, get a working link:",
            ...(kind === "video"
                ? [...HEYGEN_STEPS.slice(0, 2), "Or upload the MP4 in WordPress (Media, Add New) and copy its URL.", HEYGEN_STEPS[2], HEYGEN_STEPS[3]]
                : UPLOAD_STEPS),
        ],
        canFixHere: true,
    };
}

/** Everything known about a link without loading it, plus whether it failed to load here. */
export function pictureProblem(url: string | undefined, network: SocialNetwork, broken: boolean): FixHelp | null {
    if (!url) return null;
    return linkProblem(url, network) ?? (broken ? brokenLinkHelp(mediaInfo(url).kind) : null);
}

/** Loads the link as a picture in this browser: "ok", "broken", or "unknown" when too slow to tell. */
export function loadsAsPicture(url: string, timeoutMs = 15000): Promise<"ok" | "broken" | "unknown"> {
    return new Promise((resolve) => {
        if (typeof window === "undefined") return resolve("unknown");
        const img = new Image();
        const timer = window.setTimeout(() => { img.src = ""; resolve("unknown"); }, timeoutMs);
        img.onload = () => { window.clearTimeout(timer); resolve(img.naturalWidth > 0 ? "ok" : "broken"); };
        img.onerror = () => { window.clearTimeout(timer); resolve("broken"); };
        img.src = url;
    });
}

/** Loads a video file's details in this browser. Duration in seconds when it worked. */
export function loadsAsVideo(url: string, timeoutMs = 20000): Promise<{ result: "ok" | "broken" | "unknown"; duration?: number }> {
    return new Promise((resolve) => {
        if (typeof document === "undefined") return resolve({ result: "unknown" });
        const v = document.createElement("video");
        v.preload = "metadata";
        v.muted = true;
        const done = (r: { result: "ok" | "broken" | "unknown"; duration?: number }) => {
            window.clearTimeout(timer);
            v.removeAttribute("src");
            try { v.load(); } catch { /* ignore */ }
            resolve(r);
        };
        const timer = window.setTimeout(() => done({ result: "unknown" }), timeoutMs);
        v.onloadedmetadata = () => done({ result: "ok", duration: isFinite(v.duration) ? v.duration : undefined });
        v.onerror = () => done({ result: "broken" });
        v.src = url;
    });
}

function lengthProblem(seconds: number, network: SocialNetwork): FixHelp | null {
    const max = VIDEO_MAX_SECONDS[network];
    const mins = (s: number) => (s >= 60 ? `${Math.round(s / 60)} minutes` : `${Math.round(s)} seconds`);
    if (network === "instagram" && seconds < 3) {
        return { title: "The video is too short for Instagram", what: "Instagram Reels must be at least 3 seconds long.", steps: ["Use a longer video, then Save, Approve and Publish now."], canFixHere: true };
    }
    if (max && seconds > max) {
        return {
            title: "The video is too long for this network",
            what: `This video is about ${mins(seconds)}. The limit is ${mins(max)}.`,
            steps: ["Make a shorter version in HeyGen, or choose Facebook, which takes longer videos.", "Paste the new link with Edit, then Save, Approve and Publish now."],
            canFixHere: true,
        };
    }
    return null;
}

/** Full check before saving, approving or sending. Null means the link looks fine. */
export async function checkMediaLink(url: string, network: SocialNetwork): Promise<FixHelp | null> {
    const u = url.trim();
    const quick = linkProblem(u, network);
    if (quick) return quick;
    const info = mediaInfo(u);
    if (info.source === "heygen") return null; // checked by n8n through the HeyGen API when it publishes
    if (info.kind === "video") {
        const v = await loadsAsVideo(u);
        if (v.result === "broken") return brokenLinkHelp("video");
        return v.duration ? lengthProblem(v.duration, network) : null;
    }
    const loaded = await loadsAsPicture(u);
    return loaded === "broken" ? brokenLinkHelp("image") : null;
}
/** Kept for older callers. */
export const checkPictureLink = checkMediaLink;

const LIMITS: Partial<Record<SocialNetwork, number>> = { facebook: 5000, instagram: 2200, threads: 500, linkedin: 3000 };

/** Plain steps for a failed, blocked or refused post. Null when there is nothing to fix. */
export function diagnosePost(post: SocialPost, pictureBroken: boolean): FixHelp | null {
    if (post.status === "blockedSafeguarding") {
        return {
            title: "Held back: photo consent not recorded",
            what: "This post is marked as showing an identifiable person, and nobody recorded who confirmed consent, so it was held back on purpose.",
            steps: [
                "Check that consent is on file for everyone who can be recognised.",
                "Click Back to draft.",
                "Click Approve and type the name of the person who confirmed consent.",
                "Press Publish now, or leave it for its scheduled time.",
            ],
            canFixHere: true,
        };
    }
    if (post.status === "refused") {
        return {
            title: "Refused: no named approver",
            what: "The post reached the network without a recorded approver, so it was refused on purpose.",
            steps: [AGAIN],
            canFixHere: true,
        };
    }
    if (post.status !== "failed") return null;

    const media = pictureProblem(post.mediaUrl, post.network, pictureBroken);
    if (media) return media;

    if ((post.network === "instagram" || post.network === "youtube" || post.network === "tiktok") && !post.mediaUrl) {
        return {
            title: "This network needs a picture or video",
            what: "Instagram cannot publish text on its own.",
            steps: UPLOAD_STEPS,
            canFixHere: true,
        };
    }

    const limit = LIMITS[post.network];
    if (limit && (post.copy || "").length > limit) {
        return {
            title: "The text is too long for this network",
            what: `It has ${(post.copy || "").length} characters; the limit is ${limit}.`,
            steps: ["Click Edit and shorten the text until the counter is under the limit.", "Save, click Approve, then Publish now."],
            canFixHere: true,
        };
    }

    const err = (post.lastError || "").toLowerCase();
    if (/heygen/.test(err)) {
        if (/key|401|403|unauthori[sz]ed|forbidden|credential|not connected/.test(err)) {
            return {
                title: "The connection to HeyGen needs fixing",
                what: "The portal could not sign in to HeyGen to collect the video. The post itself is fine.",
                steps: [
                    "Tell Franco: \"the HeyGen connection for social media needs its API key checked in n8n\".",
                    "When he confirms it is done, come back here and: " + AGAIN,
                ],
                canFixHere: false,
            };
        }
        return {
            title: "HeyGen could not hand over this video",
            what: "HeyGen says the video was not found or is not finished. It may still be rendering, it may have been deleted, or it may belong to a different HeyGen account.",
            steps: [
                "Open the HeyGen link in a new tab and check the video plays to the end.",
                "If it is still rendering, wait until it finishes, then: " + AGAIN,
                "If it was made in another HeyGen account, download the MP4, upload it in WordPress (Media, Add New) and paste that link instead (click Edit).",
            ],
            canFixHere: true,
        };
    }
    if (/token|session has expired|oauth|#190|access token|not authori[sz]ed|credential|#10\b|#200\b/.test(err)) {
        return {
            title: "The connection to Facebook and Instagram needs renewing",
            what: "The portal's link to the Meta account has expired or lost a permission. The post itself is fine.",
            steps: [
                "Tell Franco: \"the Meta connection for social media needs renewing in n8n\".",
                "When he confirms it is done, come back here and: " + AGAIN,
            ],
            canFixHere: false,
        };
    }
    if (/did not finish processing|still processing|in_progress|processing timed out/.test(err)) {
        return {
            title: "The network took too long to process the video",
            what: "The video was sent but the network had not finished preparing it when the portal stopped waiting. Long or very large videos take longer.",
            steps: ["Wait about 15 minutes.", AGAIN, "If it happens again, use a shorter or smaller version of the video."],
            canFixHere: true,
        };
    }
    if (/rate limit|too many|#4\b|#32\b|#613\b|temporar|try again|timed? ?out|unavailable|unexpected error|#2\b|#1\b/.test(err)) {
        return {
            title: "The network was busy",
            what: "Facebook, Instagram or Threads did not answer properly at the time. Nothing is wrong with the post.",
            steps: ["Wait about 30 minutes.", AGAIN, "If it fails again, tell Franco."],
            canFixHere: true,
        };
    }
    if (/duplicate|#506\b/.test(err)) {
        return {
            title: "The same text was posted already",
            what: "The network refuses a post that repeats one already on the page.",
            steps: ["Click Edit and change the wording.", "Save, click Approve, then Publish now."],
            canFixHere: true,
        };
    }
    if (post.mediaType === "video" && /video|reel|duration|codec|format|frame|aspect|resolution|processing|container|error/.test(err)) {
        return {
            title: "The network could not use the video",
            what: "The video was turned down while being processed. The usual causes are length (Instagram 3 seconds to 15 minutes, Threads up to 5 minutes), a very large file, or an unusual format.",
            steps: [
                "In HeyGen, download or re-export the video as MP4 at 1080p, and keep it within the length limit.",
                "Use its HeyGen link, or upload the MP4 in WordPress (Media, Add New) and use that link (click Edit).",
                AGAIN,
            ],
            canFixHere: true,
        };
    }
    if (/aspect ratio|#36003|dimension|resolution|too small|too large|file size/.test(err)) {
        return {
            title: "Instagram did not accept the picture's shape or size",
            what: "Instagram takes pictures between square, portrait 4:5 and landscape 1.91:1, at least 320 pixels wide and under 8 MB.",
            steps: [
                "In WordPress Media, open the picture, click Edit Image and crop it to a square, or upload a different JPG.",
                ...UPLOAD_STEPS.slice(2),
            ],
            canFixHere: true,
        };
    }
    if (/media|image|photo|picture|url|fetch|download|format|jpe?g|container|#9004|#2207/.test(err)) {
        return {
            title: "The network could not use the picture",
            what: "The network could not download or read the picture at the link.",
            steps: brokenLinkHelp("image").steps,
            canFixHere: true,
        };
    }
    return {
        title: "The network turned this post down",
        what: `It gave this reason: "${post.lastError || "no reason given"}".`,
        steps: [
            "Paste the picture or video link into a new browser tab and check that it opens.",
            "If it does not, use a working link (WordPress Media for a JPG or MP4, or the HeyGen share link) and paste it in with Edit.",
            AGAIN,
            "If it fails a second time, forward this message to Franco.",
        ],
        canFixHere: true,
    };
}
