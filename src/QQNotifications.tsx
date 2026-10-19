import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ExternalLink, MessageCircle, RefreshCcw, Trash2 } from "lucide-react";
import { nextQQPreview, type QQPreviewTiming } from "./qqNotificationTiming";
import "./QQNotifications.css";

const ENABLED_KEY = "focusd-island-qq-notifications-enabled";

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
  const [previewWindow, setPreviewWindow] = useState<{ id: string; expiresAt: number } | null>(null);
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
          const { timing, expiresAt } = nextQQPreview(timingRef.current, Date.now());
          timingRef.current = timing;
          setPreviewWindow(expiresAt === null ? null : { id: payload.newestId, expiresAt });
        }
      });
      if (cancelled) { unlisten(); return; }
      const next = await invoke<QQNotificationSnapshot>("set_qq_notifications_enabled", {
        enabled: window.localStorage.getItem(ENABLED_KEY) === "true",
      });
      if (!cancelled) acceptSnapshot(next);
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
    if (enabled) {
      const access = await invoke<string>("request_qq_notification_access");
      if (access !== "allowed") {
        throw new Error(access === "denied"
          ? "Windows 已拒绝通知访问，请在系统设置中允许后重试。"
          : "尚未获得通知访问权限，请重新开启并完成授权。");
      }
    }
    acceptSnapshot(await invoke<QQNotificationSnapshot>("set_qq_notifications_enabled", { enabled }));
    window.localStorage.setItem(ENABLED_KEY, String(enabled));
    if (!enabled) { timingRef.current = null; setPreviewWindow(null); }
  }), [acceptSnapshot, run]);

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
    snapshot, busy, actionError, setEnabled, refresh, clear, openQQ,
    preview: canPreview && previewWindow
      ? snapshot.items.find((item) => item.id === previewWindow.id) ?? null
      : null,
  };
}

export type QQNotificationsController = ReturnType<typeof useQQNotifications>;

const STATUS_LABELS: Record<QQNotificationSnapshot["status"], string> = {
  disabled: "开启后，新消息会短暂显示在岛上",
  waiting: "正在连接 Windows 通知…",
  listening: "已连接，等待新的 QQ 系统通知",
  permissionDenied: "Windows 通知访问已被拒绝，请授权后重试",
  permissionRequired: "需要 Windows 通知访问权限，请重新开启并授权",
  error: "通知连接出现问题",
};

export function QQNotificationPanel({ controller }: { controller: QQNotificationsController }) {
  const { snapshot, busy, actionError, setEnabled, refresh, clear, openQQ } = controller;
  return (
    <section className="qq-panel" aria-label="QQ 最近通知">
      <header className="qq-panel__header">
        <div><MessageCircle size={18} /><strong>QQ 消息</strong><span>{snapshot.items.length} 条</span></div>
        <div>
          <button className="icon-button" type="button" title="刷新连接状态" aria-label="刷新 QQ 通知状态" disabled={busy} onClick={() => void refresh()}><RefreshCcw size={15} /></button>
          <button className="icon-button" type="button" title="清空岛内通知" aria-label="清空岛内 QQ 通知" disabled={busy || snapshot.items.length === 0} onClick={() => void clear()}><Trash2 size={15} /></button>
        </div>
      </header>
      <label className="qq-panel__toggle">
        <span>接收 QQ 消息</span>
        <input type="checkbox" role="switch" checked={snapshot.enabled} disabled={busy} onChange={(event) => void setEnabled(event.currentTarget.checked)} />
      </label>
      <p className="qq-panel__status" role="status">{STATUS_LABELS[snapshot.status]}</p>
      {(actionError || snapshot.error) && <p className="qq-panel__error" role="alert">{actionError || snapshot.error}</p>}
      <div className="qq-panel__list" role="list" aria-label="最近收到的 QQ 通知">
        {snapshot.items.length === 0 ? (
          <div className="qq-panel__empty"><MessageCircle size={28} /><span>最近的消息会出现在这里</span><small>QQ 需在本机登录，并开启 Windows 通知</small></div>
        ) : snapshot.items.map((item) => (
          <article className="qq-panel__item" key={item.id} role="listitem">
            <button type="button" disabled={busy} onClick={() => void openQQ()} aria-label={`打开 QQ：${item.title}`}>
              <div className="qq-panel__item-heading"><strong>{item.title}</strong><time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time></div>
              <p>{item.body || "收到一条 QQ 通知"}</p>
              <span className="qq-panel__open-label">打开 QQ <ExternalLink size={12} /></span>
            </button>
          </article>
        ))}
      </div>
      <p className="qq-panel__footnote">仅保留本次运行的最近 20 条通知，退出后清空</p>
    </section>
  );
}
