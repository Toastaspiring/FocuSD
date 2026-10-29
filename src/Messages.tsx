import { useEffect } from "react";
import { useTranslation } from "./i18n";
import { QQMailPanel, type QQMailController } from "./QQMail";
import { QQNotificationPanel, groupNotificationApps, type QQNotificationsController } from "./QQNotifications";
import { MessageSourceIcon } from "./MessageSourceIcon";
import { mailBadgeCount, type MessageSource } from "./messagePreview";

const NOTIF_PREFIX = "notif:";
export type MessageView = MessageSource | `${typeof NOTIF_PREFIX}${string}`;

type MessagesProps = {
  qqMail: QQMailController;
  qqNotifications: QQNotificationsController;
  source: MessageView;
  onSourceChange: (source: MessageView) => void;
};

export function messagePanelHeight(source: MessageView, readingMail = false) {
  return source === "qqMail" && readingMail ? 600 : 350;
}

export function MessagesPanel({ qqMail, qqNotifications, source, onSourceChange }: MessagesProps) {
  const t = useTranslation();
  const { snapshot: qq } = qqNotifications;
  const { snapshot: mail } = qqMail;
  const navigate = (next: MessageView) => onSourceChange(next);

  // Each app that has fired a notification gets its own tab, built on the fly.
  const notifApps = groupNotificationApps(qq.items);
  // Mail earns a tab while it has unread mail, or while a mail is open to read
  // (opening marks it read, which would otherwise pull the tab out mid-read).
  const showMail = mail.configured && ((mail.unreadCount ?? 0) > 0 || qqMail.selectedMail != null);
  const visibleSources: MessageView[] = [
    ...notifApps.map((app) => `${NOTIF_PREFIX}${app.appId}` as MessageView),
    ...(showMail ? ["qqMail" as const] : []),
  ];
  const visibleKey = visibleSources.join("|");

  useEffect(() => {
    if (visibleSources.length > 0 && !visibleSources.includes(source)) {
      onSourceChange(visibleSources[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey, source, onSourceChange]);

  const navigation = (
    <div className="message-sources" role="group" aria-label={t.messages.sources}>
      {notifApps.map((app) => {
        const view = `${NOTIF_PREFIX}${app.appId}` as MessageView;
        return (
          <button key={app.appId} type="button" aria-label={app.name} aria-pressed={source === view} onClick={() => navigate(view)}>
            <MessageSourceIcon source="qq" icon={app.icon} />
            <span>{app.name}</span>
            {app.count > 0 && <span className="message-source-count">{mailBadgeCount(app.count)}</span>}
          </button>
        );
      })}
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
  const appId = effectiveSource.startsWith(NOTIF_PREFIX) ? effectiveSource.slice(NOTIF_PREFIX.length) : undefined;
  return <QQNotificationPanel controller={qqNotifications} navigation={navigation} appId={appId} />;
}
