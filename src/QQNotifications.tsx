import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowUpRight, KeyRound, MessageSquareDashed, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { nextQQPreview, type QQPreviewTiming } from "./qqNotificationTiming";
import "./QQNotifications.css";

const ENABLED_KEY = "focusd-island-qq-notifications-enabled";
const ACCESS_REQUESTED_KEY = "focusd-island-qq-notification-access-requested";

export type QQNotification = {
  id: string;
  title: string;
  body: string;
  createdAt: number;
};

type QQNotificationSnapshot = {
  revision: number;
  enabled: boolean;
  status: "disabled" | "waiting" | "listening" | "permissionDenied" | "permissionRequired" | "error";
  items: QQNotification[];
  error: string | null;
};

type QQNotificationEvent = {
  snapshot: QQNotificationSnapshot;
  newestId: string | null;
  windowVisible: boolean;
};

const EMPTY_SNAPSHOT: QQNotificationSnapshot = {
  revision: 0,
  enabled: false,
  status: "disabled",
  items: [],
  error: null,
};

export function useQQNotifications(canPreview: boolean) {
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(isTauri);
  const [previewWindow, setPreviewWindow] = useState<{ id: string; expiresAt: number; receivedAt: number } | null>(null);
  const canPreviewRef = useRef(canPreview);
  const revisionRef = useRef(-1);
  const timingRef = useRef<QQPreviewTiming | null>(null);
  const actionPending = useRef(false);

  useLayoutEffect(() => {
    canPreviewRef.current = canPreview;
    if (!canPreview) {
      timingRef.current = null;
      setPreviewWindow(null);
    }
  }, [canPreview]);

  const acceptSnapshot = useCallback((next: QQNotificationSnapshot) => {
    if (next.revision < revisionRef.current) return false;
    revisionRef.current = next.revision;
    setSnapshot(next);
    return true;
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await listen<QQNotificationEvent>("qq-notifications-changed", ({ payload }) => {
        if (cancelled || !acceptSnapshot(payload.snapshot)) return;
        if (!payload.snapshot.enabled || !payload.windowVisible || !canPreviewRef.current) {
          setPreviewWindow(null);
          timingRef.current = null;
          return;
        }
        if (payload.newestId) {
          const receivedAt = Date.now();
          const { timing, expiresAt } = nextQQPreview(timingRef.current, receivedAt);
          timingRef.current = timing;
          setPreviewWindow(expiresAt === null ? null : { id: payload.newestId, expiresAt, receivedAt });
        }
      });
      if (cancelled) { unlisten(); return; }
      const next = await invoke<QQNotificationSnapshot>("set_qq_notifications_enabled", {
        enabled: window.localStorage.getItem(ENABLED_KEY) !== "false",
      });
      if (!cancelled) acceptSnapshot(next);
      if (!cancelled && next.enabled && window.localStorage.getItem(ACCESS_REQUESTED_KEY) !== "true") {
        // Remember the attempt before invoking so a dismissed prompt never repeats on startup.
        window.localStorage.setItem(ACCESS_REQUESTED_KEY, "true");
        await invoke<string>("request_qq_notification_access");
      }
    })().catch((error: unknown) => {
      if (!cancelled) setActionError(String(error));
    }).finally(() => {
      if (!cancelled) setBusy(false);
    });
    return () => { cancelled = true; unlisten?.(); };
  }, [acceptSnapshot]);

  useEffect(() => {
    if (!previewWindow) return;
    const timer = window.setTimeout(() => setPreviewWindow(null), Math.max(0, previewWindow.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [previewWindow]);

  const run = useCallback(async (action: () => Promise<void>) => {
    if (actionPending.current) return;
    if (!isTauri()) {
      setActionError("请在 Windows 桌面版中使用 QQ 消息。");
      return false;
    }
    actionPending.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await action();
      return true;
    } catch (error) {
      setActionError(String(error));
      return false;
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  }, []);

  const setEnabled = useCallback((enabled: boolean) => run(async () => {
    acceptSnapshot(await invoke<QQNotificationSnapshot>("set_qq_notifications_enabled", { enabled }));
    window.localStorage.setItem(ENABLED_KEY, String(enabled));
    if (!enabled) { timingRef.current = null; setPreviewWindow(null); }
    if (enabled) {
      window.localStorage.setItem(ACCESS_REQUESTED_KEY, "true");
      await invoke<string>("request_qq_notification_access");
    }
  }), [acceptSnapshot, run]);

  const requestAccess = useCallback(() => run(async () => {
    window.localStorage.setItem(ACCESS_REQUESTED_KEY, "true");
    await invoke<string>("request_qq_notification_access");
  }), [run]);

  const openSettings = useCallback(() => run(async () => {
    await invoke("open_qq_notification_settings", {
      access: snapshot.status === "permissionDenied" || snapshot.status === "permissionRequired",
    });
  }), [run, snapshot.status]);

  const refresh = useCallback(() => run(async () => {
    acceptSnapshot(await invoke<QQNotificationSnapshot>("get_qq_notification_state"));
  }), [acceptSnapshot, run]);

  const clear = useCallback(() => run(async () => {
    acceptSnapshot(await invoke<QQNotificationSnapshot>("clear_qq_notifications"));
    setPreviewWindow(null);
  }), [acceptSnapshot, run]);

  const openQQ = useCallback(() => run(async () => {
    await invoke("open_qq");
    setPreviewWindow(null);
  }), [run]);

  return {
    snapshot, busy, actionError, setEnabled, requestAccess, openSettings, refresh, clear, openQQ,
    previewReceivedAt: canPreview ? previewWindow?.receivedAt ?? null : null,
    preview: canPreview && previewWindow
      ? snapshot.items.find((item) => item.id === previewWindow.id) ?? null
      : null,
  };
}

export type QQNotificationsController = ReturnType<typeof useQQNotifications>;

const STATUS_LABELS: Record<QQNotificationSnapshot["status"], string> = {
  disabled: "已暂停",
  waiting: "连接中",
  listening: "已连接",
  permissionDenied: "通知权限被拒绝",
  permissionRequired: "需要通知权限",
  error: "连接失败",
};

export function QQNotificationControls({ controller, compact = false }: { controller: QQNotificationsController; compact?: boolean }) {
  const { snapshot, busy, actionError, setEnabled, requestAccess, openSettings } = controller;
  const needsAccess = snapshot.status === "permissionRequired" || snapshot.status === "permissionDenied";
  return <div className={`qq-panel__controls${compact ? " qq-panel__controls--compact" : ""}`}>
    <div className="qq-panel__control-row">
      <label className="qq-panel__toggle" title={snapshot.enabled ? "暂停 QQ 通知" : "接收 QQ 通知"}>
        {!compact && <span>QQ 消息</span>}
        <span className="message-status" data-state={snapshot.status} role="status" aria-label={STATUS_LABELS[snapshot.status]} title={STATUS_LABELS[snapshot.status]} />
        <input type="checkbox" role="switch" aria-label="接收 QQ 消息" checked={snapshot.enabled} disabled={busy} onChange={(event) => void setEnabled(event.currentTarget.checked)} />
      </label>
      {snapshot.enabled && <div className="qq-panel__actions">
        {snapshot.status === "permissionRequired" && <button className="message-action" type="button" title="允许通知访问" aria-label="允许 QQ 通知访问" disabled={busy} onClick={() => void requestAccess()}><KeyRound size={14} strokeWidth={1.8} />授权</button>}
        {(snapshot.status === "permissionDenied" || snapshot.error || actionError) && <button className="icon-button" type="button" title="打开 Windows 通知设置" aria-label="打开 Windows 通知设置" disabled={busy} onClick={() => void openSettings()}><Settings2 size={16} strokeWidth={1.8} /></button>}
        {snapshot.status === "error" && <button className="icon-button" type="button" title="重试授权" aria-label="重试 QQ 通知授权" disabled={busy} onClick={() => void requestAccess()}><KeyRound size={16} strokeWidth={1.8} /></button>}
      </div>}
    </div>
    {needsAccess && <p className="qq-panel__error" role="alert">{STATUS_LABELS[snapshot.status]}</p>}
    {(actionError || snapshot.error) && <p className="qq-panel__error" role="alert">{actionError || snapshot.error}</p>}
  </div>;
}

export function QQNotificationPanel({ controller }: { controller: QQNotificationsController }) {
  const { snapshot, busy, refresh, clear, openQQ } = controller;
  return (
    <section className="qq-panel" aria-label="QQ 最近通知">
      <header className="qq-panel__header">
        <QQNotificationControls controller={controller} compact />
        <div className="qq-panel__toolbar">
          <button className="icon-button" type="button" title="打开 QQ" aria-label="打开 QQ" disabled={busy} onClick={() => void openQQ()}><ArrowUpRight size={16} strokeWidth={1.8} /></button>
          <button className="icon-button" type="button" title="刷新" aria-label="刷新 QQ 通知状态" disabled={busy} onClick={() => void refresh()}><RefreshCw size={16} strokeWidth={1.8} /></button>
          <button className="icon-button" type="button" title="清空" aria-label="清空岛内 QQ 通知" disabled={busy || snapshot.items.length === 0} onClick={() => void clear()}><Trash2 size={16} strokeWidth={1.8} /></button>
        </div>
      </header>
      <div className="qq-panel__list" role="list" aria-label="最近收到的 QQ 通知" aria-busy={busy}>
        {snapshot.items.length === 0 ? (
          <div className="qq-panel__empty" role="status"><span className="message-empty-icon"><MessageSquareDashed size={27} strokeWidth={1.4} /></span><span>暂无消息</span></div>
        ) : snapshot.items.map((item) => (
          <article className="qq-panel__item" key={item.id} role="listitem">
            <button type="button" disabled={busy} onClick={() => void openQQ()} aria-label={`打开 QQ：${item.title}`}>
              <div className="qq-panel__item-heading"><strong>{item.title}</strong><time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time></div>
              {item.body && <p>{item.body}</p>}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
