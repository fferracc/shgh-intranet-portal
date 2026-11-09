"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
    onAuthStateChanged,
    signInWithPopup,
    GoogleAuthProvider,
    signInWithEmailAndPassword,
    sendPasswordResetEmail,
    signOut as firebaseSignOut,
    User as FirebaseUser
} from "firebase/auth";
import { doc, getDoc, getDocFromServer, setDoc, query, collection, where, getDocs, onSnapshot, DocumentReference, DocumentData } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { UserProfile, UserRole } from "@/lib/types";
import { useRouter } from "next/navigation";

interface AuthContextType {
    user: UserProfile | null;
    loading: boolean;
    signInWithGoogle: () => Promise<void>;
    signInWithEmail: (email: string, pass: string) => Promise<void>;
    resetPassword: (email: string) => Promise<void>;
    signOut: () => Promise<void>;
    /** Reads the signed-in person's profile again from the server (the live listener keeps it current anyway). */
    refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
    user: null,
    loading: true,
    signInWithGoogle: async () => { },
    signInWithEmail: async () => { },
    resetPassword: async () => { },
    signOut: async () => { },
    refreshProfile: async () => { },
});

export const useAuth = () => useContext(AuthContext);

// Existing user documents store the person's name under `name`, but UserProfile reads
// `displayName`, so it was undefined for every pre-existing user and anything showing a
// name fell back to the raw email address. Normalise it here, on every profile snapshot,
// so callers can rely on displayName being a real name. (My Profile saves both fields.)
function normaliseProfile(p: UserProfile, firebaseUser: FirebaseUser): UserProfile {
    if (p.displayName) return p;
    const legacyName = (p as unknown as { name?: string }).name;
    return { ...p, displayName: legacyName || firebaseUser.displayName || (p.email || "").split("@")[0] };
}

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
    const [user, setUser] = useState<UserProfile | null>(null);
    const [loading, setLoading] = useState(true);
    const router = useRouter();

    // Live profile (30 Sep 2026): after sign-in the profile document is watched with onSnapshot,
    // so a new name, role, permissions or leave balance shows without a reload.
    const profileUnsub = useRef<(() => void) | null>(null);
    const profileRef = useRef<{ ref: DocumentReference<DocumentData>; fb: FirebaseUser } | null>(null);
    const stopProfile = () => {
        if (profileUnsub.current) { profileUnsub.current(); profileUnsub.current = null; }
        profileRef.current = null;
    };

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, async (firebaseUser: FirebaseUser | null) => {
            stopProfile();
            if (firebaseUser) {
                // Fetch or create user profile
                const userDocRef = doc(db, "users", firebaseUser.uid);
                const userDoc = await getDoc(userDocRef);

                let resolvedProfile: UserProfile | null = null;
                let liveRef: DocumentReference<DocumentData> = userDocRef;

                if (userDoc.exists()) {
                    // Ensure UID is always part of the user object, even if missing in Firestore doc
                    resolvedProfile = { uid: firebaseUser.uid, ...userDoc.data() } as UserProfile;
                } else {
                    // Fallback: Check if user exists by email (legacy data support)
                    const q = query(collection(db, "users"), where("email", "==", firebaseUser.email));
                    const querySnapshot = await getDocs(q);

                    if (!querySnapshot.empty) {
                        // User exists with different ID, use that data
                        const existingUser = querySnapshot.docs[0].data() as UserProfile;
                        liveRef = querySnapshot.docs[0].ref;
                        // Optional: Link this Auth UID to the existing doc? 
                        // For now, just use the role data.
                        resolvedProfile = { ...existingUser, uid: firebaseUser.uid }; // Keep Auth UID for session
                    } else {
                        // New user logic
                        const email = firebaseUser.email || "";
                        // Every new profile starts with no privileges; an admin assigns the real
                        // role afterwards. Do not auto-promote on email domain — firestore.rules
                        // rejects any self-created profile whose role is not 'standard_user'.
                        const role: UserRole = 'standard_user';

                        const newUser: UserProfile = {
                            uid: firebaseUser.uid,
                            email,
                            displayName: firebaseUser.displayName || email.split('@')[0],
                            ...(firebaseUser.photoURL ? { photoURL: firebaseUser.photoURL } : {}),
                            role,
                            // No leave allowance here (30 Sep 2026): people cannot set their own
                            // allowance. A super admin gives leave days when the role changes.
                        };

                        await setDoc(userDocRef, newUser);
                        resolvedProfile = newUser;
                    }
                }

                if (resolvedProfile) {
                    setUser(normaliseProfile(resolvedProfile, firebaseUser));
                    // The yearly leave reset now runs on the server (annualLeaveReset), not on login.

                    // Keep it live. A sign-out or another sign-in in the meantime stops this listener.
                    if (auth.currentUser?.uid === firebaseUser.uid) {
                        stopProfile();
                        profileRef.current = { ref: liveRef, fb: firebaseUser };
                        profileUnsub.current = onSnapshot(liveRef, snap => {
                            if (!snap.exists() || auth.currentUser?.uid !== firebaseUser.uid) return;
                            setUser(normaliseProfile({ ...(snap.data() as UserProfile), uid: firebaseUser.uid }, firebaseUser));
                        }, err => console.warn("Live profile listener stopped", err));
                    }
                }
            } else {
                setUser(null);
            }
            setLoading(false);
        });

        return () => { unsubscribe(); stopProfile(); };
    }, []);

    const refreshProfile = async () => {
        const cur = profileRef.current;
        if (!cur) return;
        try {
            const snap = await getDocFromServer(cur.ref);
            if (snap.exists() && auth.currentUser?.uid === cur.fb.uid) {
                setUser(normaliseProfile({ ...(snap.data() as UserProfile), uid: cur.fb.uid }, cur.fb));
            }
        } catch (e) { console.warn("Could not refresh the profile", e); }
    };

    const signInWithGoogle = async () => {
        const provider = new GoogleAuthProvider();

        try {
            await signInWithPopup(auth, provider);
            // Route logic will handle redirection based on role/auth state change
        } catch (error: any) {
            console.error("Error signing in with Google", error);
            if (error.code === 'auth/popup-blocked') {
                alert("Sign-in popup was blocked. Please allow popups for this site and try again.");
            } else if (error.code === 'auth/cancelled-popup-request') {
                console.log("User cancelled the login popup.");
            } else {
                alert(`Google Sign-In failed: ${error.message}`);
            }
        }
    };

    const signInWithEmail = async (email: string, pass: string) => {
        try {
            await signInWithEmailAndPassword(auth, email.trim(), pass);
            // Back to the page they were sent from (e.g. a link in an email), else the dashboard.
            const next = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("next") || "" : "";
            router.push(next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard");
        } catch (error) {
            console.error("Error signing in with Email", error);
            throw error;
        }
    }

    const resetPassword = async (email: string) => {
        try {
            await sendPasswordResetEmail(auth, email.trim());
        } catch (error) {
            console.error("Error sending password reset email", error);
            throw error;
        }
    };

    const signOut = async () => {
        stopProfile();
        await firebaseSignOut(auth);
        router.push("/");
    };

    return (
        <AuthContext.Provider value={{ user, loading, signInWithGoogle, signInWithEmail, resetPassword, signOut, refreshProfile }}>
            {children}
        </AuthContext.Provider>
    );
};
