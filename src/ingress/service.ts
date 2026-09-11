import type { DeliveryEvent } from "../domain-events.js";
import type { IngressDependencies, PublishInput, PublishResult, TopicRecord } from "./types.js";

type StoredMessage = {
  id: string;
  createdAt: number;
};

export class PublishService {
  constructor(private readonly deps: IngressDependencies) {}

  async publish(topic: TopicRecord, input: PublishInput): Promise<PublishResult> {
    const title = input.title ?? topic.name;
    const result = input.priority === 5 && topic.critical
      ? this.publishCritical(topic, input, title)
      : this.publishStandard(topic, input, title);
    if (result.events.length > 0) {
      await this.deps.dispatch(result.events);
    }
    return result.response;
  }

  private publishCritical(topic: TopicRecord, input: PublishInput, title: string): { response: PublishResult; events: DeliveryEvent[] } {
    const published = this.deps.incidents.publishCritical({
      topicId: topic.id,
      topicHash: topic.topicHash,
      topic: topic.name,
      baseUrl: topic.baseUrl,
      repeatIntervalS: topic.repeatIntervalS,
      maxRingS: topic.maxRingS,
      deskTimerS: topic.deskTimerS,
      message: { title, body: input.message, priority: 5, tags: input.tags, click: input.click ?? null, markdown: input.markdown },
    });
    return {
      response: this.response(topic, input, title, published.message, published.incident.id),
      events: published.events,
    };
  }

  private publishStandard(topic: TopicRecord, input: PublishInput, title: string): { response: PublishResult; events: DeliveryEvent[] } {
    const canDeliverP4 = input.priority !== 4 || this.p4Available(topic);
    const message = this.store(topic, input, title);
    const events: DeliveryEvent[] = input.priority >= 4 && canDeliverP4
      ? [{
          kind: input.priority === 4 ? "p4" : "p5",
          topicHash: topic.topicHash,
          topic: topic.name,
          incidentId: null,
          messageId: message.id,
          priority: input.priority as 4 | 5,
          maxRingS: topic.maxRingS,
          server: topic.baseUrl,
          title,
          body: input.message,
          critical: false,
        }]
      : [];
    return { response: this.response(topic, input, title, message), events };
  }

  private p4Available(topic: TopicRecord): boolean {
    const dayStart = Math.floor(this.deps.clock.now() / 86_400) * 86_400;
    const count = this.deps.db.prepare("SELECT COUNT(*) AS count FROM messages m JOIN topics t ON t.id = m.topic_id WHERE t.account_id = ? AND m.priority = 4 AND m.created_at >= ? AND m.created_at < ?").get(topic.accountId, dayStart, dayStart + 86_400) as { count: number };
    return count.count < 50;
  }

  private store(topic: TopicRecord, input: PublishInput, title: string): StoredMessage {
    const message = { id: this.deps.ids.message(), createdAt: this.deps.clock.now() };
    this.deps.db
      .prepare(
        "INSERT INTO messages (id, topic_id, incident_id, title, body, priority, tags, click, markdown, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(message.id, topic.id, title, input.message, input.priority, JSON.stringify(input.tags), input.click ?? null, input.markdown ? 1 : 0, message.createdAt);
    return message;
  }

  private response(topic: TopicRecord, input: PublishInput, title: string, message: StoredMessage, incidentId?: string): PublishResult {
    return {
      id: message.id,
      time: message.createdAt,
      expires: message.createdAt + 43_200,
      event: "message",
      topic: topic.name,
      title,
      message: input.message,
      priority: input.priority,
      tags: input.tags,
      ...(input.click === undefined ? {} : { click: input.click }),
      ...(input.markdown ? { markdown: true } : {}),
      ...(incidentId === undefined ? {} : { incident_id: incidentId }),
    };
  }
}
