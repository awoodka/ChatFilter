import fs from "node:fs/promises";
import path from "node:path";

export type JobState = "queued" | "running" | "succeeded" | "failed";

export type JobStatus = {
  jobId: string;
  type?: "import" | "eval" | string;
  state: JobState;
  createdAt: number;
  updatedAt: number;
  vodId?: string;
  channel?: string | null;
  step?: string;
  error?: string;
  artifacts?: Record<string, string>;
  meta?: Record<string, unknown>;
};

export function jobsRootDir(): string {
  return path.join(process.cwd(), "..", "..", "data", "jobs");
}

export function jobDir(jobId: string): string {
  return path.join(jobsRootDir(), jobId);
}

export function jobStatusPath(jobId: string): string {
  return path.join(jobDir(jobId), "status.json");
}

export function jobLogPath(jobId: string): string {
  return path.join(jobDir(jobId), "log.txt");
}

export async function ensureJobDir(jobId: string): Promise<void> {
  await fs.mkdir(jobDir(jobId), { recursive: true });
}

export async function writeJobStatus(job: JobStatus): Promise<void> {
  await ensureJobDir(job.jobId);
  await fs.writeFile(jobStatusPath(job.jobId), JSON.stringify(job, null, 2), "utf-8");
}

export async function readJobStatus(jobId: string): Promise<JobStatus | null> {
  try {
    const txt = await fs.readFile(jobStatusPath(jobId), "utf-8");
    return JSON.parse(txt) as JobStatus;
  } catch {
    return null;
  }
}

export async function appendJobLog(jobId: string, line: string): Promise<void> {
  await ensureJobDir(jobId);
  await fs.appendFile(jobLogPath(jobId), line, "utf-8");
}

