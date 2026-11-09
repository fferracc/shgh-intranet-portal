// The social networks and which ones can publish (1 Oct 2026). One list, so every screen
// (the queue, the compose window, the AI assistant, the calendar and the content plan)
// says the same thing about connected networks. Change `connected` here when a network is
// connected in n8n.
import type { SocialNetwork } from "@/lib/types";

export interface NetworkInfo { key: SocialNetwork; label: string; needsImage?: boolean; connected: boolean }

export const SOCIAL_NETWORKS: NetworkInfo[] = [
    { key: "facebook", label: "Facebook", connected: true },
    { key: "instagram", label: "Instagram", needsImage: true, connected: true },
    { key: "threads", label: "Threads", connected: true },
    { key: "linkedin", label: "LinkedIn", connected: false },
    { key: "youtube", label: "YouTube", needsImage: true, connected: false },
    { key: "tiktok", label: "TikTok", needsImage: true, connected: false },
];

export const networkInfo = (key: string): NetworkInfo | undefined => SOCIAL_NETWORKS.find(n => n.key === key);
export const isConnected = (key: string) => !!networkInfo(key)?.connected;

const list = (names: string[]) => names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
const CONNECTED = SOCIAL_NETWORKS.filter(n => n.connected).map(n => n.label);
const NOT_CONNECTED = SOCIAL_NETWORKS.filter(n => !n.connected).map(n => n.label);

/** The small badge next to a network that cannot publish yet. */
export const NOT_CONNECTED_BADGE = "Not connected yet";

/** The one sentence every screen uses about connected networks. */
export const CONNECTED_NETWORKS_NOTE = NOT_CONNECTED.length
    ? `${list(CONNECTED)} are connected and publish automatically once a post is approved. ${list(NOT_CONNECTED)} are not connected yet: you can write, approve and keep posts for them, but nothing is published there until they are connected.`
    : `${list(CONNECTED)} are connected and publish automatically once a post is approved.`;
