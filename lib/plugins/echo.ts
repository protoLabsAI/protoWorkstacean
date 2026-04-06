import type { Plugin, EventBus, BusMessage } from "../types";

export class EchoPlugin implements Plugin {
  name = "echo";
  description = "Echo plugin - replies to inbound messages for testing";
  capabilities: string[] = ["echo"];

  install(bus: EventBus): void {
    bus.subscribe("message.inbound.#", this.name, (msg: BusMessage) => {
      this.handleInbound(bus, msg);
    });
  }

  uninstall(): void {}

  private handleInbound(bus: EventBus, msg: BusMessage): void {
    const sender = (msg.payload as { sender?: string })?.sender;
    const content = (msg.payload as { content?: string })?.content;

    if (!sender || !content) return;

    // Build reply topic by replacing inbound with outbound
    const replyTopic = msg.reply?.topic ?? msg.topic.replace("inbound", "outbound");

    const echoText = `Echo: ${content}`;
    const reply: BusMessage = {
      id: crypto.randomUUID(),
      correlationId: msg.correlationId,
      topic: replyTopic,
      timestamp: Date.now(),
      payload: { content: echoText },
    };

    console.log(`[Echo] Replying to ${sender}: ${echoText}`);
    bus.publish(reply.topic, reply);
  }
}