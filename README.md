# SHGH Intranet Portal

The staff intranet and operations system for Sovereign House GH, a digital inclusion charity working in Greater Manchester and Ghana. One place for recruitment, students, volunteers, leave, policies, inventory, funding and impact reporting.

**Live:** https://shgh-portal.web.app (staff sign in; the volunteer application page is public)

Part of the **SHGH Digital Platform**: [UK Learning App](https://github.com/fferracc/shgh-learning-app-uk) · [Ghana Attendance App](https://github.com/fferracc/shgh-attendance-app-ghana) · [Application Forms](https://github.com/fferracc/shgh-application-forms) · [n8n Automations](https://github.com/fferracc/n8n-automations)

<!-- ![Portal dashboard](docs/screenshot.png) -->

## What it does
| Area | Features |
|---|---|
| Recruitment | Public volunteer and student application forms, CV upload, one inbox with New, Accepted, Waiting list and Declined stages, referral form |
| Academy | UK and Ghana course data, attendance reports and statistics |
| People | Users and permissions with roles, change log, line managers, archive and restore |
| Leave | Requests, approvals, annual allowance reset at the start of the holiday year |
| Volunteers | Hours approval and automatic badges for attendance, hours and one to one sessions |
| Policies | Policy hub with reminder emails |
| Inventory | Laptop and equipment tracking |
| Funding | Grants tracker and an AI grant writing assistant |
| Social | AI drafted social media posts for review |
| Impact | Dashboard statistics aggregated on the server |

## Architecture
```
Next.js (static export) ──> Firebase Hosting
        │
        ├── Firebase Auth (staff accounts, roles)
        ├── Firestore + Storage (role based security rules)
        └── Cloud Functions
              ├── triggers: badges, leave, change log, mail queue, applications
              ├── scheduled: nightly badges, annual leave reset, orphan CV cleanup
              ├── callables: staff accounts, CV access, team overview, AI assistants
              └── Microsoft Graph mail via workload identity federation (no stored secret)

UK Learning App (Capacitor) shares the same Firebase project.
```

## Engineering highlights
- **Email without secrets:** Cloud Functions send email from a Microsoft 365 mailbox using workload identity federation (a Google ID token exchanged with Entra ID). Sending is limited to one mailbox through Exchange application RBAC.
- **Privacy by design:** sensitive equality data sits in a private subcollection, CVs are only available through a permission checked function, students' private fields are kept apart from their main record, and a scheduled job removes CVs that no longer belong to an application.
- **Security rules:** Firestore and Storage rules enforce roles, field validation and file limits (PDF only, up to 3 MB for CVs).
- **AI assistants:** Gemini drafts grant answers grounded in the organisation's funding pack, and drafts social posts for staff approval.

## Stack
Next.js 15, React 19, TypeScript, Tailwind CSS 4, Recharts, Firebase (Auth, Firestore, Storage, Cloud Functions, Hosting), Microsoft Graph, Google Gemini API

## Run locally
```
cp .env.example .env.local    # add your Firebase web config
npm install
npm run dev
```
Functions: `cd functions && npm install`, then deploy with the Firebase CLI.

## Data and privacy
No real staff, student or volunteer data is in this repository. The funding pack used by the AI assistant is replaced with a placeholder.

## Status
Live and in daily use.

Shown with permission of Sovereign House GH.
