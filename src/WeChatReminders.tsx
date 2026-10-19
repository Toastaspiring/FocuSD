import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ExternalLink, MessageCircle } from "lucide-react";
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
  disabled: "开启后，微信的新提醒会短暂显示在岛上",
  waiting: "正在连接微信提醒…",
  listening: "正在等待微信的任务栏提醒",
  error: "微信提醒暂时不可用，正在重试",
};

export function WeChatReminderControls({ controller }: { controller: WeChatRemindersController }) {
  const { snapshot, busy, actionError, setEnabled } = controller;
  return <>
    <label className="qq-panel__toggle">
      <span>接收微信提醒</span>
      <input type="checkbox" role="switch" checked={snapshot.enabled} disabled={busy}
        onChange={(event) => void setEnabled(event.currentTarget.checked)} />
    </label>
    <p className="qq-panel__status" role="status">{STATUS_LABELS[snapshot.status]}</p>
    {(actionError || snapshot.error) && <p className="qq-panel__error" role="alert">{actionError || snapshot.error}</p>}
  </>;
}

export function WeChatReminderPanel({ controller }: { controller: WeChatRemindersController }) {
  const { snapshot, busy, openWeChat } = controller;
  return (
    <section className="qq-panel" aria-label="微信提醒">
      <header className="qq-panel__header">
        <div><MessageCircle size={18} /><strong>微信提醒</strong></div>
      </header>
      <WeChatReminderControls controller={controller} />
      <div className="wechat-reminder-state">
        <MessageCircle size={30} />
        <strong>{snapshot.pending ? "微信有新提醒" : "有提醒时，看一眼岛屿"}</strong>
        <p>{snapshot.pending ? "打开微信后，岛上的提醒标记会消失" : "微信需在本机登录，并在后台发出任务栏提醒"}</p>
        <button className="qq-badge wechat-open-button" type="button" disabled={busy}
          onClick={() => void openWeChat()}>
          打开微信 <ExternalLink size={13} />
        </button>
      </div>
      <p className="qq-panel__footnote">仅提示有新提醒，不显示发送人、聊天正文或准确未读数</p>
    </section>
  );
}
