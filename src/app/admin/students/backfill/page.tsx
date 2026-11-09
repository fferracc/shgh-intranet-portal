"use client";

import { useState } from "react";
import { collection, getDocs, doc, getDoc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { db as refugeesDb } from "@/lib/firebase-refugees";
import { Student } from "@/lib/types";
import { saveStudentPrivate, mainStudentData } from "@/lib/studentPrivate";

export default function BackfillStudentsPage() {
    const [status, setStatus] = useState<string>("Ready to run backfill.");
    const [running, setRunning] = useState(false);

    const runBackfill = async () => {
        setRunning(true);
        setStatus("Fetching all students...");
        try {
            const studentsSnap = await getDocs(collection(db, "students"));
            const students = studentsSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Student[];
            
            setStatus(`Found ${students.length} students. Checking for missing application data...`);
            let updatedCount = 0;

            for (const student of students) {
                if (!student.applicationId) continue;
                
                let appData = null;
                try {
                    // Try mainDb first
                    const appRefMain = doc(db, "applications", student.applicationId);
                    const appSnapMain = await getDoc(appRefMain);
                    if (appSnapMain.exists()) {
                        appData = appSnapMain.data();
                    } else if (refugeesDb) {
                        // Try refugeesDb applications
                        let appRefRefugee = doc(refugeesDb, "applications", student.applicationId);
                        try {
                            let appSnapRefugee = await getDoc(appRefRefugee);
                            if (appSnapRefugee.exists()) {
                                appData = appSnapRefugee.data();
                            }
                        } catch (e) {
                            console.warn("Could not read applications from refugeesDb", e);
                        }
                        
                        // Try refugeesDb BuryApplications if not found
                        if (!appData) {
                            try {
                                appRefRefugee = doc(refugeesDb, "BuryApplications", student.applicationId);
                                let appSnapRefugee = await getDoc(appRefRefugee);
                                if (appSnapRefugee.exists()) {
                                    appData = appSnapRefugee.data();
                                }
                            } catch (e) {
                                console.warn("Could not read BuryApplications from refugeesDb", e);
                            }
                        }
                    }
                } catch (err: any) {
                    console.warn(`Could not fetch application for student ${student.name} (${student.applicationId}): ${err.message}`);
                    continue; // skip to next student
                }

                if (appData) {
                    // We have the application data. Let's find missing fields.
                    const { id, firstName, lastName, name, email, status, nationality, postcode, age, dob, mobile, itLevel, languageUsed, submittedAt, __path__, ...rest } = appData;
                    
                    const fieldsToUpdate: Record<string, any> = {};
                    for (const key of Object.keys(rest)) {
                        if (student[key] === undefined) {
                            fieldsToUpdate[key] = rest[key];
                        }
                    }

                    if (Object.keys(fieldsToUpdate).length > 0) {
                        setStatus(`Updating student ${student.name} with ${Object.keys(fieldsToUpdate).length} new fields...`);
                        await updateDoc(doc(db, "students", student.id), mainStudentData(fieldsToUpdate));
                        await saveStudentPrivate(student.id, fieldsToUpdate);
                        updatedCount++;
                    }
                }
            }

            setStatus(`Backfill complete! Updated ${updatedCount} students.`);
        } catch (error: any) {
            console.error("Backfill failed:", error);
            setStatus(`Error: ${error.message}`);
        }
        setRunning(false);
    };

    return (
        <div className="p-8 max-w-2xl mx-auto">
            <h1 className="text-2xl font-bold mb-4">Backfill Missing Application Data</h1>
            <p className="mb-6 text-gray-600">
                This will scan all students in the database. For any student that has an `applicationId`, 
                it will fetch the original application and copy over any missing custom variables 
                (like Refugee Number, Sovereign House Reference Number, etc.) into the student document.
            </p>
            <button 
                onClick={runBackfill} 
                disabled={running}
                className="bg-blue-600 text-white px-6 py-2 rounded font-medium disabled:opacity-50"
            >
                {running ? "Running..." : "Run Backfill Now"}
            </button>
            <div className="mt-8 p-4 bg-gray-100 rounded border">
                <p className="font-mono text-sm">{status}</p>
            </div>
        </div>
    );
}
