import qqIcon from "./assets/brands/qq.png";
import wechatIcon from "./assets/brands/wechat.png";
import qqMailIcon from "./assets/brands/qq-mail.png";
import gmailIcon from "./assets/brands/gmail.svg";
import type { MessageSource } from "./messagePreview";

const SOURCE_ICONS: Record<MessageSource, string> = {
  qq: qqIcon,
  wechat: wechatIcon,
  qqMail: qqMailIcon,
};

function mailIconFor(email?: string | null) {
  const value = email?.trim().toLowerCase() ?? "";
  if (value.endsWith("@gmail.com") || value.endsWith("@googlemail.com")) return gmailIcon;
  return qqMailIcon;
}

export function MessageSourceIcon({ source, size = 16, email }: { source: MessageSource; size?: number; email?: string | null }) {
  const src = source === "qqMail" ? mailIconFor(email) : SOURCE_ICONS[source];
  return <img className={`message-brand-icon message-brand-icon--${source}`} src={src} alt="" aria-hidden="true" width={size} height={size} draggable={false} />;
}
