export function readLineFromStream(stream: NodeJS.ReadableStream, opts?: { timeoutMs?: number }) {
  const timeoutMs = Number(opts?.timeoutMs ?? 0);
  const ttyStream = stream as NodeJS.ReadableStream & { isTTY?: boolean };
  const shouldPauseOnCleanup = Boolean(ttyStream.isTTY && typeof ttyStream.pause === "function");

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let buf = "";
    let timer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("close", onClose);
      stream.off("error", onError);
      if (timer) clearTimeout(timer);
      if (shouldPauseOnCleanup) ttyStream.pause();
    };

    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onData = (chunk: Buffer | string) => {
      buf += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        finish(buf.slice(0, idx));
      }
    };

    const onEnd = () => finish(buf);
    const onClose = () => finish(buf);
    const onError = (err: Error) => fail(err);

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        fail(new Error(`Timed out waiting for input (${timeoutMs}ms)`));
      }, timeoutMs);
    }

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("close", onClose);
    stream.on("error", onError);
    if (ttyStream.isTTY && typeof ttyStream.resume === "function") ttyStream.resume();
  });
}
