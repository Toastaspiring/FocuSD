export type MessageSource = "qq" | "wechat" | "qqMail";

export type MessagePreview = {
  source: MessageSource;
  title: string;
  body: string;
  receivedAt: number;
};

export const MESSAGE_SOURCE_LABELS: Record<MessageSource, string> = {
  qq: "QQ",
  wechat: "微信",
  qqMail: "QQ 邮箱",
};

export function messagePreviewText(preview: MessagePreview): string {
  if (preview.source === "wechat") return "你收到了一条消息";
  if (preview.source === "qqMail") return preview.body.trim() || "收到一封新邮件";
  return `${preview.title.trim() || "QQ"}：${preview.body.trim() || "收到一条新消息"}`;
}

export function latestMessagePreview(candidates: (MessagePreview | null)[], latestReceivedAt = -Infinity): MessagePreview | null {
  return candidates.reduce<MessagePreview | null>(
    (latest, candidate) => candidate && candidate.receivedAt >= latestReceivedAt
      && (!latest || candidate.receivedAt > latest.receivedAt) ? candidate : latest,
    null,
  );
}

export function mailBadgeCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}
