import type { VercelRequest, VercelResponse } from "@vercel/node";
import { LandmarkScraper, ScrapeConfig } from "../lib/stagehand-automation.js";
import { z } from "zod";

// Request validation schema
const RequestSchema = z.object({
  // Date range options
  startDate: z.string().optional(), // MM/DD/YYYY format
  endDate: z.string().optional(),   // MM/DD/YYYY format
  daysBack: z.number().min(1).max(365).optional(), // Alternative: just specify days back
  
  // Document types to search for
  documentTypes: z.array(z.string()).default(["DEED"]),
  
  // County configuration (for future multi-county support)
  county: z.string().default("king"),
});

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Only allow POST requests
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    // Parse and validate request
    const body = RequestSchema.parse(req.body || {});
    
    // Calculate date range
    let startDate: string;
    let endDate: string;
    
    if (body.startDate && body.endDate) {
      // Use provided dates
      startDate = body.startDate;
      endDate = body.endDate;
    } else {
      // Use daysBack to calculate range
      const daysBack = body.daysBack || 30;
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - daysBack);
      
      startDate = `${(start.getMonth() + 1).toString().padStart(2, '0')}/${start.getDate().toString().padStart(2, '0')}/${start.getFullYear()}`;
      endDate = `${(end.getMonth() + 1).toString().padStart(2, '0')}/${end.getDate().toString().padStart(2, '0')}/${end.getFullYear()}`;
    }

    const config: ScrapeConfig = {
      startDate,
      endDate,
      documentTypes: body.documentTypes,
      county: body.county
    };

    console.log(`Starting scrape with config:`, config);

    // Create and run scraper
    const scraper = new LandmarkScraper(config);
    const result = await scraper.execute();

    if (result.success) {
      res.status(200).json({
        ok: true,
        message: "Scraping completed",
        summary: result.summary,
        results: result.results,
      });
    } else {
      res.status(500).json({
        ok: false,
        error: "Scraping failed",
        summary: result.summary,
        results: result.results,
      });
    }
  } catch (error) {
    console.error("Handler error:", error);
    
    if (error instanceof z.ZodError) {
      res.status(400).json({
        ok: false,
        error: "Invalid request parameters",
        details: error.errors,
      });
    } else {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Internal server error",
      });
    }
  }
}

// Increase timeout for this function
export const config = {
  maxDuration: 300, // 5 minutes
};
