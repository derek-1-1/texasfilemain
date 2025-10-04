import { Stagehand, Page } from "@browserbasehq/stagehand";
import { S3Uploader } from "./s3-upload.js";

export interface ScrapeConfig {
  startDate: string;  // MM/DD/YYYY format
  endDate: string;    // MM/DD/YYYY format
  documentTypes: string[];  // Array of document types: ["DEED", "QUITCLAIM DEED", etc.]
  county: string;     // For future multi-county support
}

export class LandmarkScraper {
  private stagehand: Stagehand;
  private s3Uploader: S3Uploader;
  private config: ScrapeConfig;
  private sessionInfo: any;

  constructor(config: ScrapeConfig) {
    this.config = config;
    
    this.stagehand = new Stagehand({
      env: "BROWSERBASE",
      apiKey: process.env.BROWSERBASE_API_KEY!,
      projectId: process.env.BROWSERBASE_PROJECT_ID!,
      disablePino: true,
      modelName: "deepseek/deepseek-chat",
      modelClientOptions: {
        apiKey: process.env.DEEPSEEK_API_KEY!,
        baseURL: "https://api.deepseek.com/v1",
      },
     browserbaseSessionCreateParams: {
  projectId: process.env.BROWSERBASE_PROJECT_ID!,
  proxies: true,  // ✅ ADD THIS LINE
  region: "us-west-2",
  browserSettings: {
    viewport: { width: 1920, height: 1080 },
    blockAds: true,
    solveCaptchas: true,  // ✅ ADD THIS LINE
  },
  timeout: 300,
},
verbose: 2,
domSettleTimeoutMs: 45000,
    });

    this.s3Uploader = new S3Uploader();
  }

  /**
   * Generate array of dates between start and end
   */
  private generateDateRange(startDate: string, endDate: string): string[] {
    const dates: string[] = [];
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    // Iterate through each day
    for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
      const month = (date.getMonth() + 1).toString().padStart(2, '0');
      const day = date.getDate().toString().padStart(2, '0');
      const year = date.getFullYear();
      dates.push(`${month}/${day}/${year}`);
    }
    
    return dates;
  }

  /**
   * Clear and fill a date field properly
   */
  private async fillDateField(page: Page, selector: string, dateValue: string): Promise<void> {
    const field = page.getByRole('textbox', { name: selector });
    await field.click();
    
    // Clear the field first
    await field.press('Control+a');
    await field.press('Delete');
    
    // Fill with new date
    await field.fill(dateValue);
    await page.waitForTimeout(500);
  }

  /**
   * Scrape records for a single day and document type
   */
  private async scrapeSingleDay(
    page: Page, 
    date: string, 
    documentType: string
  ): Promise<{ success: boolean; s3Path?: string; error?: string }> {
    try {
      console.log(`Scraping ${documentType} records for ${date}...`);

      // Navigate to Document Search if not already there
      const documentSearchLink = page.getByRole('link', { name: 'Document Search' });
      if (await documentSearchLink.isVisible({ timeout: 5000 })) {
        await documentSearchLink.click();
        await page.waitForTimeout(2000);
      }

      // Fill Document Type
      console.log(`Setting document type to: ${documentType}`);
      const docTypeField = page.getByRole('textbox', { name: 'Document Type *' });
      await docTypeField.click();
      await docTypeField.press('Control+a');
      await docTypeField.fill(documentType);
      await page.waitForTimeout(1000);

      // Fill Begin Date (same as End Date for single day)
      console.log(`Setting date to: ${date}`);
      await this.fillDateField(page, 'Begin Date', date);
      
      // Fill End Date (same as Begin Date for single day)
      await this.fillDateField(page, 'End Date', date);

      // Click Submit
      console.log("Submitting search...");
      await page.getByRole('link', { name: ' Submit' }).click();
      
      // Wait for results to load
      await page.waitForTimeout(5000);

      // Check if there are results
      const noResultsText = await page.locator('text=/no records found/i').isVisible({ timeout: 3000 }).catch(() => false);
      if (noResultsText) {
        console.log(`No records found for ${documentType} on ${date}`);
        return { success: true, s3Path: "no-records" };
      }

      // Click Export
      console.log("Clicking Export...");
      const exportButton = page.getByRole('link', { name: ' Export' });
      if (!await exportButton.isVisible({ timeout: 5000 })) {
        console.log("No export button found - likely no results");
        return { success: true, s3Path: "no-records" };
      }
      await exportButton.click();
      await page.waitForTimeout(2000);

      // Set up download handling
      const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
      
      // Click the modal export button
      console.log("Clicking export modal button...");
      await page.locator('#exportResultsModalButton').click();
      
      // Wait for download
      const download = await downloadPromise;
      const fileName = `${this.config.county}-${documentType.replace(/\s+/g, '-')}-${date.replace(/\//g, '-')}.csv`;
      console.log(`Download started: ${fileName}`);
      
      // Convert download to buffer
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      const buffer = await new Promise<Buffer>((resolve, reject) => {
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
      });

      console.log(`Download completed: ${buffer.length} bytes`);

      // Upload to S3
      const s3Path = await this.s3Uploader.uploadFile(buffer, fileName);
      console.log(`Uploaded to S3: ${s3Path}`);

      // Go back to search page for next iteration
      await page.goBack();
      await page.waitForTimeout(2000);

      return { success: true, s3Path };

    } catch (error) {
      console.error(`Error scraping ${documentType} for ${date}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async execute(): Promise<{ 
    success: boolean; 
    results: Array<{ date: string; documentType: string; s3Path?: string; error?: string }>;
    summary: { total: number; successful: number; failed: number };
  }> {
    const results: Array<{ date: string; documentType: string; s3Path?: string; error?: string }> = [];
    
    try {
      // Initialize Stagehand session
      this.sessionInfo = await this.stagehand.init();
      console.log(`Session started: ${this.sessionInfo.sessionId}`);
      console.log(`Debug URL: ${this.sessionInfo.debugUrl}`);
      
      const page = this.stagehand.page;

      // Navigate to King County website
      console.log("Navigating to King County Landmark...");
      await page.goto("https://recordsearch.kingcounty.gov/LandmarkWeb", {
        waitUntil: "networkidle",
        timeout: 60000,
      });
      await page.waitForTimeout(3000);

      // Generate date range
      const dates = this.generateDateRange(this.config.startDate, this.config.endDate);
      console.log(`Processing ${dates.length} days with ${this.config.documentTypes.length} document types`);
      console.log(`Total operations: ${dates.length * this.config.documentTypes.length}`);

      // Process each day
      for (const date of dates) {
        // Process each document type for this day
        for (const documentType of this.config.documentTypes) {
          const result = await this.scrapeSingleDay(page, date, documentType);
          
          results.push({
            date,
            documentType,
            s3Path: result.s3Path,
            error: result.error
          });

          // Small delay between requests to avoid overwhelming the server
          await page.waitForTimeout(2000);
        }
      }

      // Calculate summary
      const successful = results.filter(r => r.s3Path && !r.error).length;
      const failed = results.filter(r => r.error).length;

      // Clean up
      await this.stagehand.close();
      
      return {
        success: true,
        results,
        summary: {
          total: results.length,
          successful,
          failed
        }
      };

    } catch (error) {
      console.error("Scraping session failed:", error);
      
      // Try to close stagehand on error
      try {
        await this.stagehand.close();
      } catch (closeError) {
        console.error("Failed to close Stagehand:", closeError);
      }
      
      return {
        success: false,
        results,
        summary: {
          total: results.length,
          successful: results.filter(r => r.s3Path && !r.error).length,
          failed: results.filter(r => r.error).length + 1
        }
      };
    }
  }
}
