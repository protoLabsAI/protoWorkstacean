import type { Plugin, EventBus, BusMessage } from "../types";

interface SignalEnvelope {
  envelope: {
    source: string;
    dataMessage?: {
      message?: string;
      voiceNote?: unknown;
    };
  };
}

function parseAuth(url: string): { baseUrl: string; auth: string } {
  const match = url.match(/^https?:\/\/(.+?)@(.+)$/);
  if (match) {
    return {
      baseUrl: `https://${match[2]}`,
      auth: match[1],
    };
  }
  return { baseUrl: url, auth: "" };
}

export class SignalPlugin implements Plugin {
  name = "signal";
  description = "Signal bridge - WebSocket listener and message sender";
  capabilities: string[] = ["send_signal", "receive_signal"];

  private bus: EventBus | null = null;
  private ws: WebSocket | null = null;
  private signalUrl: string | undefined;
  private signalNumber: string | undefined;

  install(bus: EventBus): void {
    this.bus = bus;
    this.signalUrl = process.env.SIGNAL_URL;
    this.signalNumber = process.env.SIGNAL_NUMBER;

    if (!this.signalUrl || !this.signalNumber) {
      console.log("Signal not configured, skipping bridge");
      return;
    }

    // Subscribe to outbound messages
    bus.subscribe(
      "message.outbound.signal.#",
      this.name,
      (msg: BusMessage) => this.handleOutbound(msg)
    );

    // Start WebSocket listener
    this.connect();
  }

  uninstall(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private connect(): void {
    if (!this.signalUrl || !this.signalNumber) return;

    const { baseUrl, auth } = parseAuth(this.signalUrl);
    const wsUrl = baseUrl.replace(/^https/, "wss") + `/v1/receive/${this.signalNumber}`;
    const wsUrlWithAuth = auth ? wsUrl.replace(/^wss?:\/\//, `wss://${auth}@`) : wsUrl;
    console.log(`Connecting to Signal WebSocket: ${wsUrl}`);

    this.ws = new WebSocket(wsUrlWithAuth);

    this.ws.onopen = () => console.log("Signal bridge connected");
    this.ws.onerror = (err) => console.error("Signal WebSocket error:", err);
    this.ws.onclose = () => console.log("Signal WebSocket closed");

    this.ws.onmessage = (event) => {
      try {
        const data: SignalEnvelope = JSON.parse(event.data);
        const envelope = data.envelope;

        if (!envelope.dataMessage) return;

        // Voice notes: silently ignored for now
        if (envelope.dataMessage.voiceNote) return;

        const text = envelope.dataMessage.message;
        if (!text) return;

        const sender = envelope.source;
        console.log(`[Signal] ${sender}: ${text}`);

        const msg: BusMessage = {
          id: crypto.randomUUID(),
          topic: `message.inbound.signal.${sender}`,
          timestamp: Date.now(),
          payload: { sender, content: text },
          reply: text,
        };

        this.bus!.publish(msg.topic, msg);
      } catch (e) {
        console.error("Error processing Signal message:", e);
      }
    };
  }

  private async handleOutbound(msg: BusMessage): Promise<void> {
    if (!this.signalUrl || !this.signalNumber || !this.bus) return;

    // Extract recipient from topic: message.outbound.signal.+1234
    const topicParts = msg.topic.split(".");
    const recipient = topicParts[3]; // +1234 or similar
    const content = msg.reply || (msg.payload as { content?: string })?.content;

    if (!recipient || !content) {
      console.error("Invalid outbound signal message:", msg);
      return;
    }

    const { baseUrl, auth } = parseAuth(this.signalUrl);
    const url = `${baseUrl}/v2/send`;
    const body = {
      message: content,
      number: this.signalNumber,
      recipients: [recipient],
    };

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (auth) {
      headers["Authorization"] = `Basic ${btoa(auth)}`;
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.text();
        console.error(`Signal send failed: ${res.status} ${err}`);
      }
    } catch (e) {
      console.error(`Signal send error: ${e}`);
    }
  }
}