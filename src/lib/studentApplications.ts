// Student applications, one model (6 Oct 2026, Franco).
//
// One PROCESS (applicationProcesses/{id}) = one course intake: a course, one of the portal forms,
// optional "opens on" / "closes on" dates and its own public link (/apply?p=<id>). Answers live
// in applicationProcesses/{id}/submissions. A process past its "closes on" date is closed by
// itself (the database refuses new answers after closesAt, see firestore.rules).
//
// "Delete" a process = ARCHIVE it (super admin only): it leaves the page, and its applications
// stay readable under Archived. Nothing is ever deleted.
//
// An applicant is New, Accepted (becomes a student on the course), Waiting list, or Declined
// (the person deciding may send a polite email, server callable studentDeclineEmail).
//
// Processes moved from the old refugees-appform database keep their id; their applications are
// copied into submissions with importedFrom = "<project>/<collection>" (the server sends no
// alert or copy email for those).
import { collection, getDocs, orderBy, query, Timestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { db as refugeesDb } from "@/lib/firebase-refugees";
import type { ApplicationProcess } from "@/lib/types";
export * from "@/lib/studentApplicationRules";
import { isOldDatabase, whenMs, type Application } from "@/lib/studentApplicationRules";

/** The last moment of a UK calendar day ("YYYY-MM-DD", 23:59:59 London time) as a Timestamp. */
export function endOfLondonDay(day: string): Timestamp | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || "");
    if (!m) return null;
    // Find the UK offset on that day: London is UTC+0 or UTC+1.
    const guess = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59));
    const londonHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false }).format(guess));
    const offsetHours = (londonHour - 23 + 24) % 24; // 0 in winter, 1 in summer
    return Timestamp.fromDate(new Date(guess.getTime() - offsetHours * 3600 * 1000));
}

/** Every application of a process, newest first (no limit). */
export async function loadApplications(p: ApplicationProcess): Promise<Application[]> {
    const old = isOldDatabase(p);
    const ref = collection(old ? refugeesDb : db, p.collectionName || `applicationProcesses/${p.id}/submissions`);
    let docs;
    try { docs = (await getDocs(query(ref, orderBy("submittedAt", "desc")))).docs; }
    catch { docs = (await getDocs(ref)).docs; } // a document without submittedAt must not hide the rest
    return docs.map(d => ({ id: d.id, processId: p.id, ...d.data() } as Application))
        .sort((a, b) => whenMs(b.submittedAt) - whenMs(a.submittedAt));
}

