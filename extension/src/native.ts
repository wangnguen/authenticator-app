import {
  NATIVE_HOST_NAME,
  type NativeCommand,
  type NativeResponse,
  type NativeResultMap,
} from "@auth/core";

const REQUEST_TIMEOUT_MS = 5000;

export class NativeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function disconnectError(reason: string): NativeError {
  if (/not found|forbidden/i.test(reason)) {
    return new NativeError(
      "HOST_NOT_FOUND",
      "Chưa kết nối được app desktop. Hãy cài và mở app Authenticator ít nhất một lần.",
    );
  }
  return new NativeError("DISCONNECTED", reason);
}

/**
 * Client cho native messaging. Dùng một port (một tiến trình host) cho
 * suốt thời gian popup mở, mỗi request có id để ghép với response.
 */
class NativeClient {
  private port: chrome.runtime.Port | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  private connect(): chrome.runtime.Port {
    if (this.port) return this.port;

    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    port.onMessage.addListener((message: NativeResponse) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.data);
      else pending.reject(new NativeError(message.error.code, message.error.message));
    });
    port.onDisconnect.addListener(() => {
      const error = disconnectError(chrome.runtime.lastError?.message ?? "Mất kết nối.");
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.port = null;
    });

    this.port = port;
    return port;
  }

  request<C extends NativeCommand>(command: C): Promise<NativeResultMap[C["type"]]> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new NativeError("TIMEOUT", "App desktop không phản hồi."));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        this.connect().postMessage({ ...command, id });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
}

export const native = new NativeClient();
