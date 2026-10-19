import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, LoaderCircle, Mail, RefreshCcw, Unplug } from "lucide-react";
import { nextQQPreview, type QQPreviewTiming } from "./qqNotificationTiming";
import "./QQMail.css";

const SETTINGS_KEY = "focusd-island-qq-mail-settings";

type MailMessage = {
  id: string;
  uid: number;
  sender: string;
  subject: string;
  receivedAt: number | null;
  unread: boolean;
};

export type MailSnapshot = {
  revision: number;
  email: string | null;
  configured: boolean;
  enabled: boolean;
  syncing: boolean;
  status: "disconnected" | "connecting" | "connected" | "paused" | "authRequired" | "error";
  unreadCount: number | null;
  items: MailMessage[];
  lastSyncedAt: number | null;
  error: string | null;
};

type MailEvent = { snapshot: MailSnapshot; newestId: string | null; windowVisible: boolean };
type MailSettings = { email: string; enabled: boolean };

const EMPTY_SNAPSHOT: MailSnapshot = {
  revision: 0, email: null, configured: false, enabled: false, syncing: false,
  status: "disconnected", unreadCount: null, items: [], lastSyncedAt: null, error: null,
};

function loadSettings(): MailSettings | null {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<MailSettings> | null;
    return typeof stored?.email === "string" && typeof stored.enabled === "boolean"
      ? { email: stored.email, enabled: stored.enabled } : null;
  } catch { return null; }
}

export function useQQMail(canPreview: boolean) {
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(isTauri);
  const [previewWindow, setPreviewWindow] = useState<{ id: string; receivedAt: number; expiresAt: number } | null>(null);
  const canPreviewRef = useRef(canPreview);
  const revisionRef = useRef(-1);
  const accountRef = useRef<string | null>(null);
  const timingRef = useRef<QQPreviewTiming | null>(null);
  const actionIdRef = useRef(0);

  const clearPreview = useCallback(() => {
    timingRef.current = null;
    setPreviewWindow(null);
  }, []);

  useLayoutEffect(() => {
    canPreviewRef.current = canPreview;
    if (!canPreview) clearPreview();
  }, [canPreview, clearPreview]);

  const acceptSnapshot = useCallback((next: MailSnapshot, persist = true) => {
    if (next.revision < revisionRef.current) return false;
    revisionRef.current = next.revision;
    if (next.email !== accountRef.current || !next.enabled || next.status !== "connected") clearPreview();
    accountRef.current = next.email;
    setSnapshot(next);
    if (next.status === "connected" && !next.syncing) setActionError(null);
    if (persist) {
      try {
        if (next.configured && next.email) {
          localStorage.setItem(SETTINGS_KEY, JSON.stringify({ email: next.email, enabled: next.enabled }));
        } else if (next.status === "disconnected" && next.revision > 0) {
          localStorage.removeItem(SETTINGS_KEY);
        }
      } catch { setActionError("无法保存邮箱连接偏好，下次启动可能需要重新连接。"); }
    }
    return true;
  }, [clearPreview]);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const saved = loadSettings();
    void (async () => {
      unlisten = await listen<MailEvent>("qq-mail-changed", ({ payload }) => {
        if (cancelled || !acceptSnapshot(payload.snapshot)) return;
        if (!canPreviewRef.current || !payload.windowVisible || !payload.snapshot.enabled
          || payload.snapshot.status !== "connected") {
          clearPreview();
          return;
        }
        if (payload.newestId) {
          const receivedAt = Date.now();
          const { timing, expiresAt } = nextQQPreview(timingRef.current, receivedAt);
          timingRef.current = timing;
          setPreviewWindow(expiresAt === null ? null : { id: payload.newestId, receivedAt, expiresAt });
        }
      });
      if (cancelled) { unlisten(); return; }
      const current = await invoke<MailSnapshot>("get_qq_mail_state");
      if (cancelled) return;
      acceptSnapshot(current, false);
      if (!current.email && saved) {
        const restored = await invoke<MailSnapshot>("set_qq_mail_enabled", saved);
        if (!cancelled) acceptSnapshot(restored);
      }
    })().catch((error: unknown) => {
      if (!cancelled) setActionError(String(error));
    }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; unlisten?.(); };
  }, [acceptSnapshot, clearPreview]);

  useEffect(() => {
    if (!previewWindow) return;
    const timer = window.setTimeout(() => setPreviewWindow(null), Math.max(0, previewWindow.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [previewWindow]);

  const run = useCallback(async (command: string, args?: Record<string, unknown>) => {
    if (!isTauri()) { setActionError("请在 Windows 桌面版中连接 QQ 邮箱。"); return false; }
    const id = ++actionIdRef.current;
    setBusy(true);
    setActionError(null);
    try {
      const next = await invoke<MailSnapshot>(command, args);
      return id === actionIdRef.current && acceptSnapshot(next);
    } catch (error) {
      if (id === actionIdRef.current) setActionError(String(error));
      return false;
    } finally { if (id === actionIdRef.current) setBusy(false); }
  }, [acceptSnapshot]);

  const connect = useCallback((email: string, authorizationCode: string) =>
    run("connect_qq_mail", { email, authorizationCode }), [run]);
  const setEnabled = useCallback((enabled: boolean) =>
    run("set_qq_mail_enabled", { email: snapshot.email, enabled }), [run, snapshot.email]);
  const refresh = useCallback(() => run("refresh_qq_mail"), [run]);
  const disconnect = useCallback(() => run("disconnect_qq_mail"), [run]);
  const openMail = useCallback(async () => {
    try {
      await openUrl("https://mail.qq.com/");
      clearPreview();
      return true;
    } catch {
      setActionError("无法打开 QQ 邮箱，请检查默认浏览器。");
      return false;
    }
  }, [clearPreview]);
  const openHelp = useCallback(async () => {
    try { await openUrl("https://service.mail.qq.com/"); }
    catch { setActionError("无法打开邮箱帮助，请在 QQ 邮箱设置中查找 IMAP 和授权码。"); }
  }, []);

  const preview = canPreview && previewWindow && snapshot.enabled && snapshot.status === "connected"
    ? snapshot.items.find((item) => item.id === previewWindow.id && item.unread) ?? null : null;

  return {
    snapshot, busy, actionError, connect, setEnabled, refresh, disconnect, openMail, openHelp,
    preview, previewReceivedAt: preview ? previewWindow?.receivedAt ?? null : null,
  };
}

export type QQMailController = ReturnType<typeof useQQMail>;

const STATUS_LABELS: Record<MailSnapshot["status"], string> = {
  disconnected: "连接后，每分钟检查一次新邮件",
  connecting: "正在连接 QQ 邮箱…",
  connected: "已连接，每分钟自动检查",
  paused: "已暂停，恢复后继续检查新邮件",
  authRequired: "需要重新连接 QQ 邮箱",
  error: "同步失败，稍后自动重试",
};

function formatMailTime(time: number) {
  return new Date(time).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function QQMailPanel({ controller }: { controller: QQMailController }) {
  const { snapshot, busy, actionError, connect, setEnabled, refresh, disconnect, openMail, openHelp } = controller;
  const [email, setEmail] = useState(snapshot.email ?? "");
  const [authorizationCode, setAuthorizationCode] = useState("");
  const showForm = !snapshot.configured || snapshot.status === "authRequired";
  const error = actionError || snapshot.error;

  useEffect(() => { if (snapshot.email) setEmail(snapshot.email); }, [snapshot.email]);

  return (
    <section className="qq-panel qq-mail-panel" aria-label="QQ 邮箱">
      <header className="qq-panel__header">
        <div><Mail size={18} /><strong>QQ 邮箱</strong>{snapshot.unreadCount !== null && <span>{snapshot.unreadCount} 封未读</span>}</div>
        <div>
          {snapshot.configured && <button className="icon-button" type="button" title="刷新邮件" aria-label="刷新 QQ 邮箱" disabled={busy || snapshot.syncing || !snapshot.enabled || snapshot.status === "authRequired"} onClick={() => void refresh()}><RefreshCcw size={15} className={snapshot.syncing ? "qq-mail-spinning" : undefined} /></button>}
          {snapshot.email && <button className="icon-button" type="button" title="断开并删除保存的授权码" aria-label="断开 QQ 邮箱" onClick={() => void disconnect().then((disconnected) => { if (disconnected) setAuthorizationCode(""); })}><Unplug size={15} /></button>}
        </div>
      </header>
      {snapshot.configured && !showForm && <>
        <label className="qq-panel__toggle qq-mail-account">
          <span title={snapshot.email ?? undefined}>{snapshot.email}</span>
          <input type="checkbox" role="switch" aria-label="接收 QQ 邮箱" checked={snapshot.enabled} disabled={busy || snapshot.status === "authRequired"} onChange={(event) => void setEnabled(event.currentTarget.checked)} />
        </label>
      </>}
      {(!error || !showForm) && <p className="qq-panel__status" role="status">{snapshot.syncing ? "正在检查邮件…" : STATUS_LABELS[snapshot.status]}</p>}
      {error && <p className="qq-panel__error" role="alert">{error}</p>}
      {showForm ? (
        <form className="qq-mail-form" onSubmit={(event) => {
          event.preventDefault();
          void connect(email, authorizationCode).then((connected) => { if (connected) setAuthorizationCode(""); });
        }}>
          <div className="qq-mail-fields">
            <label htmlFor="qq-mail-email">邮箱地址</label>
            <input id="qq-mail-email" type="email" autoComplete="username" placeholder="你的邮箱@qq.com" required maxLength={80} value={email} disabled={busy || snapshot.configured} onChange={(event) => setEmail(event.currentTarget.value)} />
            <label htmlFor="qq-mail-code">邮箱授权码</label>
            <input id="qq-mail-code" type="password" autoComplete="off" placeholder="在 QQ 邮箱设置中生成" required maxLength={256} value={authorizationCode} disabled={busy} onChange={(event) => setAuthorizationCode(event.currentTarget.value)} />
            {!error && <p>先在 QQ 邮箱设置中开启 IMAP，再生成授权码。授权码与 QQ 登录密码不同。</p>}
          </div>
          <div className="qq-mail-form__actions">
            <button className="qq-mail-help" type="button" onClick={() => void openHelp()}>开启 IMAP / 获取授权码 <ExternalLink size={12} /></button>
            <button className="qq-mail-connect" type="submit" disabled={busy || !email.trim() || !authorizationCode.trim()}>{busy && <LoaderCircle size={14} className="qq-mail-spinning" />}{busy ? "连接中…" : "连接邮箱"}</button>
          </div>
          <small>授权码安全保存在本机 Windows 凭据管理器中</small>
        </form>
      ) : (
        <>
          <div className="qq-panel__list qq-mail-list" role="list" aria-label="收件箱最近 20 封邮件" aria-busy={snapshot.syncing}>
            {snapshot.items.length === 0 ? (
              <div className="qq-panel__empty"><Mail size={28} /><span>{snapshot.lastSyncedAt === null ? snapshot.syncing ? "正在加载收件箱" : "尚未完成首次同步" : "收件箱暂无邮件"}</span><small>{snapshot.lastSyncedAt === null ? "首次同步只加载最近邮件，不弹出历史提醒" : "新邮件到达后会显示在这里"}</small></div>
            ) : snapshot.items.map((item) => (
              <article className={`qq-panel__item qq-mail-item${item.unread ? " qq-mail-item--unread" : ""}`} key={item.id} role="listitem">
                <button type="button" onClick={() => void openMail()} aria-label={`打开 QQ 邮箱：${item.subject}${item.unread ? "，未读" : ""}`}>
                  <div className="qq-panel__item-heading"><strong title={item.sender}>{item.unread && <span className="qq-mail-unread-dot" aria-hidden="true" />}{item.sender}</strong>{item.receivedAt !== null && <time dateTime={new Date(item.receivedAt).toISOString()}>{formatMailTime(item.receivedAt)}</time>}</div>
                  <p>{item.subject}</p>
                </button>
              </article>
            ))}
          </div>
          <footer className="qq-mail-footer">
            <span>{snapshot.lastSyncedAt === null ? "尚未完成同步" : `上次同步 ${formatMailTime(snapshot.lastSyncedAt)}`}</span>
            <button className="qq-mail-help" type="button" onClick={() => void openMail()}>打开邮箱 <ExternalLink size={12} /></button>
          </footer>
        </>
      )}
    </section>
  );
}
