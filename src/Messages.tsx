import { useEffect } from "react";
import { useTranslation } from "./i18n";
import { QQMailPanel, type QQMailController } from "./QQMail";
import { QQNotificationPanel, type QQNotificationsController } from "./QQNotifications";
import { WeChatReminderPanel, type WeChatRemindersController } from "./WeChatReminders";
import { MessageSourceIcon } from "./MessageSourceIcon";
import { mailBadgeCount, type MessageSource } from "./messagePreview";

export type MessageView = MessageSource;

type MessagesProps = {
  qqMail: QQMailController;
  qqNotifications: QQNotificationsController;
  wechatReminders: WeChatRemindersController;
  source: MessageView;
  onSourceChange: (source: MessageView) => void;
};

export function messagePanelHeight(source: MessageView, readingMail = false) {
  return source === "qqMail" && readingMail ? 600 : 350;
}

export function MessagesPanel({ qqMail, qqNotifications, wechatReminders, source, onSourceChange }: MessagesProps) {
  const t = useTranslation();
  const { snapshot: qq } = qqNotifications;
  const { snapshot: mail } = qqMail;
  const navigate = (next: MessageView) => onSourceChange(next);

  // A source only gets a tab once it actually has something to show.
  const showNotifs = qq.items.length > 0;
  const showWechat = wechatReminders.snapshot.enabled;
  const showMail = mail.configured;
  const visibleSources: MessageView[] = [
    ...(showNotifs ? ["qq" as const] : []),
    ...(showWechat ? ["wechat" as const] : []),
    ...(showMail ? ["qqMail" as const] : []),
  ];

  useEffect(() => {
    if (visibleSources.length > 0 && !visibleSources.includes(source)) {
      onSourceChange(visibleSources[0]);
    }
  }, [visibleSources, source, onSourceChange]);

  const navigation = (
    <div className="message-sources" role="group" aria-label={t.messages.sources}>
      {showNotifs && <button type="button" aria-label={t.messages.qqNotifications} aria-pressed={source === "qq"} onClick={() => navigate("qq")}><MessageSourceIcon source="qq" /><span>{t.messages.notifications}</span>{qq.items.length > 0 && <span className="message-source-count">{mailBadgeCount(qq.items.length)}</span>}</button>}
      {showWechat && <button type="button" aria-label={t.messages.wechatReminders} aria-pressed={source === "wechat"} onClick={() => navigate("wechat")}><MessageSourceIcon source="wechat" /><span>{t.messages.wechat}</span>{wechatReminders.snapshot.pending && <span className="message-source-dot" aria-label={t.messages.newReminder} />}</button>}
      {showMail && <button type="button" aria-label={t.messages.qqMail} aria-pressed={source === "qqMail"} onClick={() => navigate("qqMail")}><MessageSourceIcon source="qqMail" email={mail.email} /><span>{t.messages.mail}</span>{mail.enabled && (mail.unreadCount ?? 0) > 0 && <span className="message-source-count">{mailBadgeCount(mail.unreadCount ?? 0)}</span>}</button>}
    </div>
  );

  if (visibleSources.length === 0) {
    return (
      <section className="qq-panel" aria-label={t.messages.title}>
        <div className="qq-panel__empty qq-panel__empty--sources" role="status">
          <span>{t.messages.noSources}</span>
        </div>
      </section>
    );
  }

  const effectiveSource = visibleSources.includes(source) ? source : visibleSources[0];
  if (effectiveSource === "qqMail") return <QQMailPanel controller={qqMail} navigation={navigation} />;
  if (effectiveSource === "wechat") return <WeChatReminderPanel controller={wechatReminders} navigation={navigation} />;
  return <QQNotificationPanel controller={qqNotifications} navigation={navigation} />;
}
