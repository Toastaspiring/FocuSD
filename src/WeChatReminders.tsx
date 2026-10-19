import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowUpRight, Power } from "lucide-react";
import { MessageSourceIcon } from "./MessageSourceIcon";
import "./WeChatReminders.css";

const ENABLED_KEY = "focusd-island-wechat-reminders-enabled";

type ReminderSnapshot = {
  revision: number;
  enabled: boolean;
  status: "disabled" | "waiting" | "listening" | "error";
  pending: boolean;
  lastAttentionAt: number | null;
  error: string | null;
};

type ReminderEvent = { snapshot: ReminderSnapshot; windowVisible: boolean };

const EMPTY_SNAPSHOT: ReminderSnapshot = {
  revision: 0, enabled: false, status: "disabled", pending: false,
  lastAttentionAt: null, error: null,
};

export function useWeChatReminders(canPreview: boolean) {
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [busy, setBusy] = useState(isTauri);
  const [actionError, setActionError] = useState<string | null>(null);
  const [previewReceivedAt, setPreviewReceivedAt] = useState<number | null>(null);
  const canPreviewRef = useRef(canPreview);
  const revisionRef = useRef(-1);
  const attentionRef = useRef<number | null>(null);
  const actionPending = useRef(false);

  useLayoutEffect(() => {
    canPreviewRef.current = canPreview;
    if (!canPreview) setPreviewReceivedAt(null);
  }, [canPreview]);

  const acceptSnapshot = useCallback((next: ReminderSnapshot) => {
    if (next.revision < revisionRef.current) return false;
    revisionRef.current = next.revision;
    attentionRef.current = next.lastAttentionAt;
    setSnapshot(next);
    return true;
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await listen<ReminderEvent>("wechat-reminder-changed", ({ payload }) => {
        const newlyPending = payload.snapshot.pending
          && payload.snapshot.lastAttentionAt !== attentionRef.current;
        if (cancelled || !acceptSnapshot(payload.snapshot)) return;
        if (!payload.snapshot.enabled || !payload.snapshot.pending
          || payload.snapshot.status !== "listening" || !payload.windowVisible || !canPreviewRef.current) {
          setPreviewReceivedAt(null);
        } else if (newlyPending) {
          setPreviewReceivedAt(Date.now());
        }
      });
      if (cancelled) { unlisten(); return; }
      const next = await invoke<ReminderSnapshot>("set_wechat_reminders_enabled", {
        enabled: window.localStorage.getItem(ENABLED_KEY) !== "false",
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
    if (previewReceivedAt === null) return;
    const timer = window.setTimeout(() => setPreviewReceivedAt(null),
      Math.max(0, previewReceivedAt + 5_000 - Date.now()));
    return () => window.clearTimeout(timer);
  }, [previewReceivedAt]);

  const run = useCallback(async (action: () => Promise<void>) => {
    if (actionPending.current) return;
    if (!isTauri()) {
      setActionError("请在 Windows 桌面版中使用微信提醒。");
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
    acceptSnapshot(await invoke<ReminderSnapshot>("set_wechat_reminders_enabled", { enabled }));
    window.localStorage.setItem(ENABLED_KEY, String(enabled));
    if (!enabled) setPreviewReceivedAt(null);
  }), [acceptSnapshot, run]);

  const openWeChat = useCallback(() => run(async () => {
    await invoke("open_wechat");
    setPreviewReceivedAt(null);
  }), [run]);

  return {
    snapshot, busy, actionError, setEnabled, openWeChat,
    previewReceivedAt: canPreview && snapshot.pending ? previewReceivedAt : null,
  };
}

export type WeChatRemindersController = ReturnType<typeof useWeChatReminders>;

const STATUS_LABELS: Record<ReminderSnapshot["status"], string> = {
  disabled: "已暂停",
  waiting: "连接中",
  listening: "已连接",
  error: "连接失败，正在重试",
};

export function WeChatReminderControls({ controller, compact = false }: { controller: WeChatRemindersController; compact?: boolean }) {
  const { snapshot, busy, actionError, setEnabled } = controller;
  return <div className={`qq-panel__controls${compact ? " qq-panel__controls--compact" : ""}`}>
    {compact ? <button className="icon-button message-receiver-toggle" type="button" role="switch" aria-checked={snapshot.enabled} aria-label="接收微信提醒" title={snapshot.enabled ? "暂停微信提醒" : "接收微信提醒"} disabled={busy} onClick={() => void setEnabled(!snapshot.enabled)}><Power size={15} strokeWidth={1.8} /></button> : <label className="qq-panel__toggle" title={snapshot.enabled ? "暂停微信提醒" : "接收微信提醒"}>
      <span>微信提醒</span>
      <span className="message-status" data-state={snapshot.status} role="status" aria-label={STATUS_LABELS[snapshot.status]} title={STATUS_LABELS[snapshot.status]} />
      <input type="checkbox" role="switch" aria-label="接收微信提醒" checked={snapshot.enabled} disabled={busy}
        onChange={(event) => void setEnabled(event.currentTarget.checked)} />
    </label>}
    {!compact && (actionError || snapshot.error) && <p className="qq-panel__error" role="alert">{actionError || snapshot.error}</p>}
  </div>;
}

export function WeChatReminderPanel({ controller, navigation }: { controller: WeChatRemindersController; navigation: ReactNode }) {
  const { snapshot, busy, actionError, openWeChat } = controller;
  return (
    <section className="qq-panel" aria-label="微信提醒">
      <header className="qq-panel__header">
        {navigation}
        <div className="qq-panel__toolbar"><WeChatReminderControls controller={controller} compact /><button className="icon-button" type="button" title="打开微信" aria-label="打开微信" disabled={busy} onClick={() => void openWeChat()}><ArrowUpRight size={16} strokeWidth={1.8} /></button></div>
      </header>
      {(actionError || snapshot.error) && <p className="qq-panel__error" role="alert">{actionError || snapshot.error}</p>}
      <div className={`qq-panel__empty${snapshot.pending ? " wechat-reminder-state--pending" : ""}`} role="status">
        <span className="message-empty-icon"><MessageSourceIcon source="wechat" size={28} /></span>
        <span>{snapshot.pending ? "有新提醒" : "暂无提醒"}</span>
      </div>
    </section>
  );
}
