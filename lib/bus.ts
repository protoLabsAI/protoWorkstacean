import type { BusMessage, MessageHandler, Subscription, TopicInfo, ConsumerInfo } from "./types";

export class InMemoryEventBus {
  private subscriptions = new Map<string, Subscription[]>();
  private consumerInfo = new Map<string, ConsumerInfo>();
  private publishing = false;
  private deferred: { topic: string; message: BusMessage }[] = [];

  publish(topic: string, message: BusMessage): void {
    if (this.publishing) {
      this.deferred.push({ topic, message });
      return;
    }

    this.publishing = true;
    try {
      this.deliver(topic, message);
      while (this.deferred.length > 0) {
        const next = this.deferred.shift()!;
        this.deliver(next.topic, next.message);
      }
    } finally {
      this.publishing = false;
    }
  }

  private deliver(topic: string, message: BusMessage): void {
    for (const [pattern, subs] of this.subscriptions) {
      if (this.topicMatches(pattern, topic)) {
        for (const sub of subs) {
          try {
            sub.handler(message);
          } catch (e) {
            console.error(`Error in handler for ${pattern}:`, e);
          }
        }
      }
    }
  }

  subscribe(pattern: string, pluginName: string, handler: MessageHandler): string {
    const id = crypto.randomUUID();
    const sub: Subscription = { id, pattern, pluginName, handler };

    if (!this.subscriptions.has(pattern)) {
      this.subscriptions.set(pattern, []);
    }
    this.subscriptions.get(pattern)!.push(sub);

    // Update consumer info
    if (!this.consumerInfo.has(pluginName)) {
      this.consumerInfo.set(pluginName, {
        name: pluginName,
        subscriptions: [],
        capabilities: [],
      });
    }
    this.consumerInfo.get(pluginName)!.subscriptions.push(pattern);

    return id;
  }

  unsubscribe(id: string): void {
    for (const [pattern, subs] of this.subscriptions) {
      const idx = subs.findIndex(s => s.id === id);
      if (idx !== -1) {
        subs.splice(idx, 1);
        if (subs.length === 0) {
          this.subscriptions.delete(pattern);
        }
        return;
      }
    }
  }

  topics(): TopicInfo[] {
    const result: TopicInfo[] = [];
    for (const [pattern, subs] of this.subscriptions) {
      result.push({ pattern, subscribers: subs.length });
    }
    return result.sort((a, b) => a.pattern.localeCompare(b.pattern));
  }

  consumers(): ConsumerInfo[] {
    return Array.from(this.consumerInfo.values());
  }

  private topicMatches(pattern: string, topic: string): boolean {
    // # matches everything (must be at end)
    if (pattern === "#") return true;

    const patternParts = pattern.split(".");
    const topicParts = topic.split(".");

    // Ensure # is only at the end of pattern
    if (patternParts.includes("#") && patternParts[patternParts.length - 1] !== "#") {
      return false;
    }

    // Check if pattern ends with #
    const hasMultiLevel = patternParts[patternParts.length - 1] === "#";
    const compareLength = hasMultiLevel ? patternParts.length - 1 : patternParts.length;

    for (let i = 0; i < compareLength; i++) {
      if (patternParts[i] === "*") continue;  // * matches any single level
      if (patternParts[i] !== topicParts[i]) return false;
    }

    // If pattern doesn't have #, topic must have same number of levels
    if (!hasMultiLevel) {
      return patternParts.length === topicParts.length;
    }

    // Pattern has #, topic can have more levels
    return topicParts.length >= patternParts.length - 1;
  }
}
