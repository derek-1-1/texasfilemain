import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

export class S3Uploader {
  private s3Client: S3Client;
  private bucketName: string;

  constructor() {
    this.s3Client = new S3Client({
      region: process.env.AWS_REGION || "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });
    this.bucketName = process.env.S3_BUCKET_NAME!;
  }

 async uploadFile(fileBuffer: Buffer, fileName: string): Promise<string> {
  const dateFolder = new Date().toISOString().split("T")[0];
  const timestamp = Date.now();
  const key = `landmark-scraper/${dateFolder}/${timestamp}-${fileName}`;
  
  console.log(`Uploading to S3: ${key}`);
  
  // Determine content type based on file extension
  const contentType = fileName.toLowerCase().endsWith('.csv') 
    ? "text/csv"
    : "application/pdf";
  
  const command = new PutObjectCommand({
    Bucket: this.bucketName,
    Key: key,
    Body: fileBuffer,
    ContentType: contentType,  // ✅ CHANGED
    Metadata: {
      source: "king-county-landmark",
      timestamp: new Date().toISOString(),
      fileName: fileName,  // ✅ ADDED
      scraperSession: process.env.BROWSERBASE_SESSION_ID || "unknown", // ✅ ADDED
    }
  });

  try {
    await this.s3Client.send(command);
    console.log(`Successfully uploaded to S3: ${key}`);
    return `s3://${this.bucketName}/${key}`;
  } catch (error) {
    console.error("S3 upload error:", error);
    throw new Error(`Failed to upload to S3: ${error instanceof Error ? error.message : String(error)}`);
  }
}
}
