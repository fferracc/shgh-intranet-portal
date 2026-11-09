"use client";

import { RequirePermission } from "@/components/auth/RequirePermission";
import React, { Suspense } from "react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { ProcessDashboardContent } from "./ProcessDashboardContent";

export default function ProcessDashboard() {
    return (
        <Suspense fallback={
            <DashboardLayout>
                <div className="flex justify-center items-center h-64">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                </div>
            </DashboardLayout>
        }>
            <RequirePermission perm="student_applications"><ProcessDashboardContent /></RequirePermission>
        </Suspense>
    );
}
