// Runs one custom JavaScript tool in its own thread. The parent terminates this thread on timeout.
// This limits accidents (runaway loops, memory, access to server internals). It is not a hardened
// sandbox against hostile code: run the server in Docker so the container is the real boundary.
import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';

const { code, args, secrets } = workerData;
const logs = [];
const print = (...parts) => {
  if (logs.length < 100) logs.push(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '));
};

const sandbox = {
  args, secrets, fetch, URL, URLSearchParams, Headers, AbortSignal, TextEncoder, TextDecoder,
  setTimeout, clearTimeout, console: { log: print, info: print, warn: print, error: print },
};

try {
  const fn = vm.runInNewContext(`(async (args, secrets) => {\n${code}\n})`, sandbox, { timeout: 2000, filename: 'tool.js' });
  fn(args, secrets).then(
    (result) => parentPort.postMessage({ ok: true, result, logs }),
    (error) => parentPort.postMessage({ ok: false, error: String(error?.message ?? error), logs }),
  );
} catch (error) {
  parentPort.postMessage({ ok: false, error: String(error?.message ?? error), logs });
}
