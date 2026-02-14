import { spawn } from "node:child_process";

export type ProcResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export async function runCommand(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<ProcResult> {
  return await new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts?.cwd, env: opts?.env, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    child.on("error", (err) => resolve({ code: 1, stdout, stderr: stderr + err.message }));
  });
}

export async function runCommandStreaming(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; onLine?: (line: string, stream: "stdout" | "stderr") => void },
): Promise<ProcResult> {
  return await new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, shell: false });
    let stdout = "";
    let stderr = "";
    const handleChunk = (chunk: Buffer, stream: "stdout" | "stderr") => {
      const s = chunk.toString();
      if (stream === "stdout") stdout += s;
      else stderr += s;
      const lines = s.split(/\r?\n/);
      for (const line of lines) {
        if (!line) continue;
        opts.onLine?.(line, stream);
      }
    };
    child.stdout.on("data", (d) => handleChunk(d, "stdout"));
    child.stderr.on("data", (d) => handleChunk(d, "stderr"));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    child.on("error", (err) => resolve({ code: 1, stdout, stderr: stderr + err.message }));
  });
}

