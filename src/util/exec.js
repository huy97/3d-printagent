import { execFile } from 'node:child_process';

export function run(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: options.timeout ?? 20000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...options },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

export async function tryRun(command, args = [], options = {}) {
  try {
    return await run(command, args, options);
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? String(error.message), failed: true };
  }
}

export function powershell(script, options = {}) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], options);
}
