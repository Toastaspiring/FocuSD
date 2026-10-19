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

export function latestMessagePreview(candidates: (MessagePreview | null)[]): MessagePreview | null {
  return candidates.reduce<MessagePreview | null>(
    (latest, candidate) => candidate && (!latest || candidate.receivedAt > latest.receivedAt) ? candidate : latest,
    null,
  );
}

export function mailBadgeCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}
