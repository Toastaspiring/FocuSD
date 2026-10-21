import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, ArrowRight, ArrowUpRight, AtSign, CircleHelp, KeyRound, LoaderCircle, Power, RefreshCw, Unplug } from "lucide-react";
import DOMPurify from "dompurify";
import { MessageSourceIcon } from "./MessageSourceIcon";
import { nextQQPreview, type QQPreviewTiming } from "./qqNotificationTiming";
import "./QQMail.css";

const SETTINGS_KEY = "focusd-island-qq-mail-settings";

export type MailMessage = {
  id: string;
  uid: number;
  sender: string;
  subject: string;
  receivedAt: number | null;
  unread: boolean;
};

export type MailContent = { id: string; content: string; contentType: "text/plain" | "text/html" };

export function sanitizeMailHtml(content: string) {
  return DOMPurify.sanitize(content, {
    ALLOWED_TAGS: ["p", "br", "div", "span", "h1", "h2", "h3", "h4", "strong", "b", "em", "i", "u", "s", "blockquote", "pre", "code", "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "a", "hr"],
    ALLOWED_ATTR: ["href", "title", "colspan", "rowspan"],
    ALLOWED_URI_REGEXP: /^https?:\/\//i,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}

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
  const [selectedMail, setSelectedMail] = useState<MailMessage | null>(null);
  const [content, setContent] = useState<MailContent | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const readerRequestRef = useRef(0);
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

  const closeReader = useCallback(() => {
    ++readerRequestRef.current;
    setSelectedMail(null);
    setContent(null);
    setReadError(null);
    setReading(false);
  }, []);

  useLayoutEffect(() => {
    canPreviewRef.current = canPreview;
    if (!canPreview) clearPreview();
  }, [canPreview, clearPreview]);

  const acceptSnapshot = useCallback((next: MailSnapshot, persist = true) => {
    if (next.revision < revisionRef.current) return false;
    revisionRef.current = next.revision;
    if (next.email !== accountRef.current || !next.enabled || next.status !== "connected") clearPreview();
    if (next.email !== accountRef.current || !next.configured || next.status === "authRequired") closeReader();
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
  }, [clearPreview, closeReader]);

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
    return () => { cancelled = true; ++readerRequestRef.current; unlisten?.(); };
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
  const disconnect = useCallback(() => { closeReader(); return run("disconnect_qq_mail"); }, [closeReader, run]);
  const readMail = useCallback(async (message: MailMessage) => {
    const requestId = ++readerRequestRef.current;
    setSelectedMail(message);
    setContent(null);
    setReadError(null);
    clearPreview();
    if (!isTauri()) { setReadError("请在 Windows 桌面版中阅读邮件。"); setReading(false); return false; }
    setReading(true);
    try {
      const next = await invoke<MailContent>("read_qq_mail", { messageId: message.id });
      if (requestId !== readerRequestRef.current) return false;
      if (next.id !== message.id) throw new Error("邮件内容已改变，请重试。");
      setContent(next);
      return true;
    } catch (error) {
      if (requestId === readerRequestRef.current) setReadError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      if (requestId === readerRequestRef.current) setReading(false);
    }
  }, [clearPreview]);
  const openLink = useCallback(async (href: string) => {
    if (!/^https?:\/\//i.test(href)) return;
    try { await openUrl(href); }
    catch { setActionError("无法打开链接，请检查默认浏览器。"); }
  }, []);
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
    selectedMail, content, reading, readError, readMail, closeReader, openLink,
    preview, previewReceivedAt: preview ? previewWindow?.receivedAt ?? null : null,
  };
}

export type QQMailController = ReturnType<typeof useQQMail>;

const STATUS_LABELS: Record<MailSnapshot["status"], string> = {
  disconnected: "未连接",
  connecting: "连接中",
  connected: "已连接",
  paused: "已暂停",
  authRequired: "需要重新授权",
  error: "同步失败",
};

function formatMailTime(time: number) {
  return new Date(time).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function QQMailPanel({ controller, navigation, onRead, onBack }: {
  controller: QQMailController;
  navigation: ReactNode;
  onRead?: (message: MailMessage) => void;
  onBack?: () => void;
}) {
  const { snapshot, busy, actionError, connect, setEnabled, refresh, disconnect, openMail, openHelp } = controller;
  const [email, setEmail] = useState(snapshot.email ?? "");
  const [authorizationCode, setAuthorizationCode] = useState("");
  const showForm = !snapshot.configured || snapshot.status === "authRequired";
  const error = actionError || snapshot.error;
  const listRef = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  const returnFocus = useRef<string | null>(null);
  const { selectedMail, content, reading, readError, readMail, closeReader, openLink } = controller;
  const html = useMemo(() => content?.contentType === "text/html" ? sanitizeMailHtml(content.content) : "", [content]);
  const readerRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (snapshot.email) setEmail(snapshot.email); }, [snapshot.email]);
  useLayoutEffect(() => {
    if (!selectedMail && listRef.current) {
      listRef.current.scrollTop = listScroll.current;
      if (returnFocus.current) {
        Array.from(listRef.current.querySelectorAll<HTMLButtonElement>("button[data-mail-id]")).find(button => button.dataset.mailId === returnFocus.current)?.focus({ preventScroll: true });
        returnFocus.current = null;
      }
    }
    if (selectedMail && readerRef.current) { returnFocus.current = selectedMail.id; readerRef.current.scrollTop = 0; readerRef.current.focus(); }
  }, [selectedMail]);

  if (selectedMail) return (
    <section className="qq-panel qq-mail-panel" aria-label="邮件阅读">
      <header className="qq-panel__header">
        <button className="message-action qq-mail-back" type="button" onClick={onBack ?? closeReader}><ArrowLeft size={15} strokeWidth={1.8} />返回列表</button>
        <button className="message-action" type="button" title="附件和回复请在网页中处理" onClick={() => void openMail()}>在网页打开<ArrowUpRight size={14} strokeWidth={1.8} /></button>
      </header>
      {actionError && <p className="qq-panel__error" role="alert">{actionError}</p>}
      <div className="qq-mail-reader" ref={readerRef} tabIndex={-1} aria-label="邮件正文" aria-busy={reading}>
        <h2 className="qq-mail-reader__subject">{selectedMail.subject}</h2>
        <div className="qq-mail-reader__meta"><span>{selectedMail.sender}</span>{selectedMail.receivedAt !== null && <time dateTime={new Date(selectedMail.receivedAt).toISOString()}>{formatMailTime(selectedMail.receivedAt)}</time>}</div>
        {reading ? <div className="qq-mail-reader__state" role="status"><LoaderCircle size={19} className="qq-mail-spinning" />正在加载正文</div>
          : readError ? <div className="qq-mail-reader__state"><p className="qq-panel__error" role="alert">{readError}</p><button className="message-action" type="button" onClick={() => void readMail(selectedMail)}><RefreshCw size={14} />重试</button></div>
          : content?.contentType === "text/html" ? <div className="qq-mail-body" onClick={(event) => {
              const link = event.target instanceof Element ? event.target.closest("a") : null;
              if (!link) return;
              event.preventDefault();
              if (link.getAttribute("href")) void openLink(link.getAttribute("href")!);
            }} dangerouslySetInnerHTML={{ __html: html || "<p>这封邮件没有可显示的文字，请在网页中查看。</p>" }} />
          : <div className="qq-mail-body qq-mail-body--text">{content?.content || "这封邮件没有文字正文。"}</div>}
      </div>
      <p className="qq-mail-reader__notice">仅预览，不自动标为已读 · 附件请在网页查看</p>
    </section>
  );

  return (
    <section className="qq-panel qq-mail-panel" aria-label="QQ 邮箱">
      <header className="qq-panel__header">
        {navigation}
        <div className="qq-panel__toolbar">
          {snapshot.configured && <button className="icon-button message-receiver-toggle" type="button" role="switch" aria-checked={snapshot.enabled} aria-label="接收 QQ 邮箱" title={snapshot.enabled ? "暂停接收邮件" : "接收邮件"} disabled={busy || snapshot.status === "authRequired"} onClick={() => void setEnabled(!snapshot.enabled)}><Power size={15} strokeWidth={1.8} /></button>}
          {showForm && <button className="icon-button" type="button" title="开启 IMAP / 获取授权码" aria-label="查看 IMAP 和邮箱授权码帮助" onClick={() => void openHelp()}><CircleHelp size={16} strokeWidth={1.8} /></button>}
          <button className="icon-button" type="button" title="打开邮箱" aria-label="打开 QQ 邮箱" onClick={() => void openMail()}><ArrowUpRight size={16} strokeWidth={1.8} /></button>
          {snapshot.configured && <button className="icon-button" type="button" title={snapshot.lastSyncedAt === null ? "刷新邮件" : `刷新邮件 · 上次同步 ${formatMailTime(snapshot.lastSyncedAt)}`} aria-label="刷新 QQ 邮箱" disabled={busy || snapshot.syncing || !snapshot.enabled || snapshot.status === "authRequired"} onClick={() => void refresh()}><RefreshCw size={16} strokeWidth={1.8} className={snapshot.syncing ? "qq-mail-spinning" : undefined} /></button>}
          {snapshot.configured && <button className="icon-button" type="button" title="断开并删除授权码" aria-label="断开 QQ 邮箱并删除保存的授权码" disabled={busy} onClick={() => void disconnect().then((disconnected) => { if (disconnected) setAuthorizationCode(""); })}><Unplug size={16} strokeWidth={1.8} /></button>}
        </div>
      </header>
      {snapshot.configured && <div className="qq-mail-account" title={`${snapshot.email} · ${STATUS_LABELS[snapshot.status]}`}><span className="message-status" data-state={snapshot.status} role="status" aria-label={STATUS_LABELS[snapshot.status]} /><span className="qq-mail-account__email">{snapshot.email}</span></div>}
      {error && <p className="qq-panel__error" role="alert">{error}</p>}
      {showForm ? (
        <form className="qq-mail-form" onSubmit={(event) => {
          event.preventDefault();
          void connect(email, authorizationCode).then((connected) => { if (connected) setAuthorizationCode(""); });
        }}>
          <div className="qq-mail-fields">
            <label className="qq-mail-field"><AtSign size={16} strokeWidth={1.8} aria-hidden="true" /><input id="qq-mail-email" aria-label="QQ 邮箱地址" type="email" autoComplete="username" placeholder="邮箱地址@qq.com" required maxLength={80} value={email} disabled={busy || snapshot.configured} onChange={(event) => setEmail(event.currentTarget.value)} /></label>
            <label className="qq-mail-field"><KeyRound size={16} strokeWidth={1.8} aria-hidden="true" /><input id="qq-mail-code" aria-label="QQ 邮箱授权码" type="password" autoComplete="off" placeholder="邮箱授权码" required maxLength={256} value={authorizationCode} disabled={busy} onChange={(event) => setAuthorizationCode(event.currentTarget.value)} /></label>
          </div>
          <div className="qq-mail-form__actions">
            <button className="message-action qq-mail-connect" type="submit" disabled={busy || !email.trim() || !authorizationCode.trim()}>{busy ? <LoaderCircle size={15} strokeWidth={1.8} className="qq-mail-spinning" /> : <ArrowRight size={15} strokeWidth={1.8} />}{busy ? "连接中" : "连接"}</button>
          </div>
        </form>
      ) : (
        <>
          <div className="qq-panel__list qq-mail-list" ref={listRef} onScroll={(event) => { listScroll.current = event.currentTarget.scrollTop; }} role="list" aria-label="收件箱最近 20 封邮件" aria-busy={snapshot.syncing}>
            {snapshot.items.length === 0 ? (
              <div className="qq-panel__empty" role="status"><span className="message-empty-icon">{snapshot.syncing ? <LoaderCircle size={26} strokeWidth={1.5} className="qq-mail-spinning" /> : <MessageSourceIcon source="qqMail" size={28} />}</span><span>{snapshot.syncing ? "同步中" : "暂无邮件"}</span></div>
            ) : snapshot.items.map((item) => (
              <article className={`qq-panel__item qq-mail-item${item.unread ? " qq-mail-item--unread" : ""}`} key={item.id} role="listitem">
                <button type="button" data-mail-id={item.id} onClick={() => { if (onRead) onRead(item); else void readMail(item); }} aria-label={`阅读邮件：${item.subject}${item.unread ? "，未读" : ""}`}>
                  <div className="qq-panel__item-heading"><strong title={item.sender}>{item.unread && <span className="qq-mail-unread-dot" aria-hidden="true" />}<span>{item.sender}</span></strong>{item.receivedAt !== null && <time dateTime={new Date(item.receivedAt).toISOString()}>{formatMailTime(item.receivedAt)}</time>}</div>
                  <p>{item.subject}</p>
                </button>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
