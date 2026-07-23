import { LingoPropList, type LingoValue, isSymbol } from "./lingo-runtime.js";

type Callback = (target: LingoValue, handler: string) => void;

interface NetMessage {
  errorCode: number;
  content: string;
  senderID: string;
  subject: string;
}

/** Browser counterpart of LibreShockwave's MultiuserXtra for raw Habbo sockets. */
export class BrowserMultiuserXtra {
  private socket: WebSocket | null = null;
  private callbackTarget: LingoValue | undefined;
  private callbackHandler = "";
  private queue: NetMessage[] = [];
  private current: NetMessage | undefined;

  constructor(private readonly invoke: Callback, private readonly websocketMode: () => string) {}

  setNetBufferLimits(): number { return 0; }

  setNetMessageHandler(handler: LingoValue, target: LingoValue): number {
    this.callbackHandler = isSymbol(handler) ? handler.name : String(handler ?? "");
    this.callbackTarget = target;
    return 0;
  }

  connectToNetServer(...args: LingoValue[]): number {
    const host = String(args[2] ?? "");
    const port = Number(args[3] ?? 0);
    const configured = this.websocketMode().toLowerCase();
    const scheme = configured === "wss" ? "wss" : "ws";
    console.info(`[multiuser] connecting ${scheme}://${host}:${port}`);
    try {
      const socket = new WebSocket(`${scheme}://${host}:${port}`);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => this.enqueue({
        errorCode: 0, content: "", senderID: "System", subject: "ConnectToNetServer",
      });
      socket.onmessage = (event) => {
        const len = typeof event.data === "string" ? event.data.length : event.data.byteLength;
        let prefix = "";
        if (typeof event.data === "string") {
          prefix = event.data.slice(0, 20);
        } else if (event.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(event.data);
          const printable = String.fromCharCode(...bytes.subarray(0, 20));
          prefix = printable.replace(/[^\x20-\x7e]/g, "?");
        }
        console.info(`[multiuser] received ${len} bytes prefix="${prefix}"`);
        if (typeof event.data === "string") {
          this.enqueue({ errorCode: 0, content: event.data, senderID: "", subject: "" });
        } else if (event.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(event.data);
          let content = "";
          for (let i = 0; i < bytes.length; i += 0x8000) {
            content += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          }
          this.enqueue({ errorCode: 0, content, senderID: "", subject: "" });
        }
      };
      socket.onerror = () => {
        console.info("[multiuser] socket error");
        this.enqueue({ errorCode: -2, content: "", senderID: "System", subject: "ConnectToNetServer" });
      };
      socket.onclose = (event) => {
        console.info(`[multiuser] closed ${event.code} ${event.reason}`);
        this.enqueue({ errorCode: -2, content: "", senderID: "System", subject: "ConnectToNetServer" });
      };
      this.socket = socket;
      return 0;
    } catch {
      return -6;
    }
  }

  sendNetMessage(_recipients: LingoValue, subject: LingoValue, content: LingoValue): number {
    if (this.socket?.readyState !== WebSocket.OPEN) return -2;
    // LibreShockwave's mode-0 bridge sends the subject and content as one
    // plaintext command, separated by a space when both are non-empty.
    const subjectText = String(subject ?? "");
    const contentText = String(content ?? "");
    const value = !subjectText || subjectText === "0"
      ? contentText
      : !contentText ? subjectText : `${subjectText} ${contentText}`;
    const bytes = Uint8Array.from(value, (char) => char.charCodeAt(0) & 0xff);
    const preview = value.slice(0, 80).replace(/[^\x20-\x7e]/g, "?");
    console.info(`[multiuser] sending ${subjectText} (${bytes.length} bytes) content="${preview}"`);
    this.socket.send(bytes);
    return 0;
  }

  getNetMessage(): LingoValue {
    if (!this.current) return undefined;
    return new LingoPropList([
      "errorCode", this.current.errorCode,
      "content", this.current.content,
      "senderID", this.current.senderID,
      "subject", this.current.subject,
    ]) as unknown as LingoValue;
  }

  checkNetMessages(count: LingoValue = 1): number {
    let processed = 0;
    while (processed < Number(count) && this.queue.length) {
      this.current = this.queue.shift();
      this.fireCallback();
      processed++;
    }
    this.current = undefined;
    return processed;
  }

  getNumberWaitingNetMessages(): number { return this.queue.length; }
  getNetErrorString(code: LingoValue): string { return Number(code) === 0 ? "No error" : `Network error (${Number(code)})`; }

  private enqueue(message: NetMessage): void {
    this.queue.push(message);
    // LibreShockwave ticks the Xtra and invokes its registered callback.
    queueMicrotask(() => this.checkNetMessages(this.queue.length));
  }

  private fireCallback(): void {
    if (this.callbackTarget !== undefined && this.callbackHandler) {
      const props = (this.callbackTarget as { props?: Map<string, unknown> }).props;
      const script = props instanceof Map ? props.get("__scriptName") : undefined;
      console.info(`[multiuser] callback ${String(script)}.${this.callbackHandler}`);
      this.invoke(this.callbackTarget, this.callbackHandler);
    }
  }
}
