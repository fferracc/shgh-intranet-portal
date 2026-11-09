import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { FUNDING_CONTEXT } from '@/lib/data/fundingContext';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

async function generateWithRetry(model: any, prompt: string, maxRetries = 3, initialDelay = 1500) {
    let delay = initialDelay;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await model.generateContent(prompt);
        } catch (error: any) {
            if (error.status === 503 && i < maxRetries - 1) {
                console.warn(`[AI-Grants] 503 Service Unavailable. Retrying in ${delay}ms... (Attempt ${i + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 1.5; // Exponential backoff
            } else {
                throw error;
            }
        }
    }
}

export async function POST(req: NextRequest) {
    try {
        const { action, payload } = await req.json();

        // 1. Suggest Idea
        if (action === 'suggest_idea') {
            const { funderRequirements } = payload;

            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
            const prompt = `
            You are an expert grant writer for Sovereign House GH, a charity based in the UK operating programs in Bury and Ghana.
            
            Here is the core background and context of Sovereign House GH:
            ${FUNDING_CONTEXT}
            
            A user wants to apply for a grant with the following requirements/aims from the funder:
            "${funderRequirements}"
            
            Based strictly on Sovereign House GH's actual activities, history, and goals, suggest ONE highly compelling project idea that perfectly aligns with this funder's aims. 
            Do NOT makeup activities we haven't done or aren't planning to do (e.g. don't suggest building a hospital if we only do computer training). 
            Keep the suggestion to 1-2 paragraphs. Be persuasive.
            `;

            const result = await generateWithRetry(model, prompt);
            return NextResponse.json({ result: result.response.text() });
        }

        // 2. Generate Draft
        if (action === 'generate_draft') {
            const { funderRequirements, applicationForm, acceptedIdea, amount } = payload;

            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
            const prompt = `
            You are an expert grant writer for Sovereign House GH.
            
            Context:
            ${FUNDING_CONTEXT}
            
            Funder Requirements:
            ${funderRequirements}
            
            The Approved Project Idea to pitch:
            ${acceptedIdea}
            
            Total Funding Requested: £${amount}
            
            Please complete the following Application Form, ensuring you strictly follow any word or character limits mentioned in the questions.
            Application Form:
            ${applicationForm}
            
            CRITICAL INSTRUCTION: At the very end of the application, you MUST include a well-structured Budget Table. 
            The total of this budget table MUST exactly equal £${amount}. Break down the costs logically based on the Approved Project Idea. Provide clear explanations for each calculation.
            Format the response clearly using Markdown.
            `;

            const result = await generateWithRetry(model, prompt);
            return NextResponse.json({ result: result.response.text() });
        }

        // 3. Summarize Grant
        if (action === 'summarize') {
            const { funderText } = payload;
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

            const prompt = `
            You are a grant researcher for Sovereign House GH. 
            Our Context:
            ${FUNDING_CONTEXT}
            
            Please analyze the following funder text/guidelines:
            ${funderText}
            
            Extract and output exactly these points in Markdown format:
            1. **Funder Name:** (Extract the name of the foundation/grantor/funder)
            2. **Funding Amount Available:** (What is the max/range they give?)
            3. **Deadline:** (When is the application due?)
            4. **Core Requirements:** (Bullet points of what they fund)
            5. **Eligibility Check:** (Are we theoretically eligible based strictly on our context? Say YES or NO and give a 1 sentence reason why).
            `;

            const result = await generateWithRetry(model, prompt);
            return NextResponse.json({ result: result.response.text() });
        }

        // 4. Review Application
        if (action === 'review') {
            const { draft, rubric } = payload;
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

            const prompt = `
            You are a strict, objective, and highly experienced grant panel judge evaluating an application for Sovereign House GH.
            
            Here is the scoring rubric or criteria you must judge against:
            ${rubric}
            
            Here is the draft application:
            ${draft}
            
            Please provide a rigorous critique. Point out exactly where the application fails to meet the rubric, where it is weak, and suggest specific ways to improve it. Be constructive but very strict.
            `;

            const result = await generateWithRetry(model, prompt);
            return NextResponse.json({ result: result.response.text() });
        }

        // 5. Generate project milestones for a granted funding
        if (action === 'generate_milestones') {
            const { fundingContent, grantName, amount } = payload;
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

            const today = new Date().toISOString().split('T')[0];
            const prompt = `
            You are a project management expert for Sovereign House GH, a UK charity.

            A funding grant has been AWARDED. Here are the details:
            Grant Name: ${grantName || 'Unknown'}
            Amount: £${amount || 'Unknown'}
            
            Here is the full content/requirements of the awarded funding:
            ${fundingContent}

            Today's date is ${today}.

            Based on this funding, generate a complete project execution plan with milestones and tasks.
            
            Return ONLY a valid JSON array (no markdown, no code fences) with this structure:
            [
              {
                "milestone": "Milestone name",
                "date": "YYYY-MM-DD",
                "tasks": ["Task 1", "Task 2", "Task 3"],
                "completed": false
              }
            ]

            Include milestones for:
            - Project setup and planning
            - Key deliverables and activities required by the funder
            - Monitoring and evaluation points
            - Financial reporting deadlines
            - Interim reports
            - Final report and project closure
            
            Spread milestones across the project timeline realistically. Include 5-10 milestones with 2-5 tasks each.
            Return ONLY the JSON array, nothing else.
            `;

            const result = await generateWithRetry(model, prompt);
            const text = result.response.text().trim();

            // Try to parse JSON, handle potential markdown wrapping
            let cleanJson = text;
            if (cleanJson.startsWith('```')) {
                cleanJson = cleanJson.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
            }

            try {
                const parsed = JSON.parse(cleanJson);
                return NextResponse.json({ result: parsed });
            } catch {
                return NextResponse.json({ result: text });
            }
        }

        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });

    } catch (error: any) {
        console.error("AI Grants Error:", error);
        return NextResponse.json({ error: error.message || 'Error processing AI request' }, { status: 500 });
    }
}
