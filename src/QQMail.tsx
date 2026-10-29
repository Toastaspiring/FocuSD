import { useTranslation } from "./i18n";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, ArrowRight, ArrowUpRight, AtSign, Check, CheckCheck, ChevronDown, CircleHelp, KeyRound, LoaderCircle, Power, RefreshCw, Server, Unplug } from "lucide-react";
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
    USE_PROFILES: { html: true },
    ADD_TAGS: ["style", "center", "font"],
    ADD_ATTR: ["target", "bgcolor", "background", "align", "valign", "face", "size", "color"],
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "button", "textarea", "meta", "link", "base"],
    FORBID_ATTR: ["srcset"],
    ALLOWED_URI_REGEXP: /^(?:https?:|data:image\/|mailto:|cid:)/i,
    ALLOW_DATA_ATTR: false,
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

export type MailProvider = "qq" | "gmail" | "custom";
const MAIL_PROVIDER_PRESETS: Record<"qq" | "gmail", { host: string; port: number }> = {
  qq: { host: "imap.qq.com", port: 993 },
  gmail: { host: "imap.gmail.com", port: 993 },
};
const MAIL_PROVIDER_KEY = "focusd-island-mail-provider";
type MailProviderPrefs = { provider: MailProvider; host: string; port: number };

function loadProviderPrefs(): MailProviderPrefs {
  try {
    const stored = JSON.parse(localStorage.getItem(MAIL_PROVIDER_KEY) ?? "null") as Partial<MailProviderPrefs> | null;
    if (stored?.provider === "qq" || stored?.provider === "gmail" || stored?.provider === "custom") {
      return {
        provider: stored.provider,
        host: typeof stored.host === "string" ? stored.host : "",
        port: typeof stored.port === "number" && stored.port > 0 ? stored.port : 993,
      };
    }
  } catch { /* ignore */ }
  return { provider: "qq", host: "", port: 993 };
}

function saveProviderPrefs(prefs: MailProviderPrefs) {
  try { localStorage.setItem(MAIL_PROVIDER_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
}

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
  const t = useTranslation();
  const translationsRef = useRef(t);
  translationsRef.current = t;
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(isTauri);
  const [selectedMail, setSelectedMail] = useState<MailMessage | null>(null);
  const [content, setContent] = useState<MailContent | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [readerHeight, setReaderHeight] = useState<number | null>(null);
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
      } catch { setActionError(translationsRef.current.mail.savePreferencesFailed); }
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
    if (!isTauri()) { setActionError(t.mail.desktopConnect); return false; }
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
  }, [acceptSnapshot, t]);

  const connect = useCallback((email: string, authorizationCode: string, host: string, port: number) =>
    run("connect_qq_mail", { email, authorizationCode, host, port }), [run]);
  const setEnabled = useCallback((enabled: boolean) =>
    run("set_qq_mail_enabled", { email: snapshot.email, enabled }), [run, snapshot.email]);
  const refresh = useCallback(() => run("refresh_qq_mail"), [run]);
  const markAllRead = useCallback(() => { closeReader(); return run("mark_all_qq_mail_read"); }, [closeReader, run]);
  const disconnect = useCallback(() => { closeReader(); return run("disconnect_qq_mail"); }, [closeReader, run]);
  const readMail = useCallback(async (message: MailMessage) => {
    const requestId = ++readerRequestRef.current;
    setSelectedMail(message);
    setContent(null);
    setReadError(null);
    clearPreview();
    if (!isTauri()) { setReadError(t.mail.desktopRead); setReading(false); return false; }
    setReading(true);
    try {
      const next = await invoke<MailContent>("read_qq_mail", { messageId: message.id });
      if (requestId !== readerRequestRef.current) return false;
      if (next.id !== message.id) throw new Error(t.mail.changed);
      setContent(next);
      // The mail is now marked read on the server; drop it from the unread list.
      setSnapshot((current) => current.items.some((item) => item.id === message.id)
        ? {
            ...current,
            revision: current.revision + 1,
            items: current.items.filter((item) => item.id !== message.id),
            unreadCount: current.unreadCount != null ? Math.max(0, current.unreadCount - 1) : current.unreadCount,
          }
        : current);
      return true;
    } catch (error) {
      if (requestId === readerRequestRef.current) setReadError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      if (requestId === readerRequestRef.current) setReading(false);
    }
  }, [clearPreview, t]);
  const openLink = useCallback(async (href: string) => {
    if (!/^https?:\/\//i.test(href)) return;
    try { await openUrl(href); }
    catch { setActionError(t.mail.openLinkFailed); }
  }, [t]);
  const openMail = useCallback(async () => {
    try {
      await openUrl("https://mail.qq.com/");
      clearPreview();
      return true;
    } catch {
      setActionError(t.mail.openFailed);
      return false;
    }
  }, [clearPreview, t]);
  const openHelp = useCallback(async () => {
    try { await openUrl("https://service.mail.qq.com/"); }
    catch { setActionError(t.mail.helpFailed); }
  }, [t]);

  const preview = canPreview && previewWindow && snapshot.enabled && snapshot.status === "connected"
    ? snapshot.items.find((item) => item.id === previewWindow.id && item.unread) ?? null : null;

  return {
    snapshot, busy, actionError, connect, setEnabled, refresh, markAllRead, disconnect, openMail, openHelp,
    selectedMail, content, reading, readError, readMail, closeReader, openLink,
    readerHeight, setReaderHeight,
    preview, previewReceivedAt: preview ? previewWindow?.receivedAt ?? null : null,
  };
}

export type QQMailController = ReturnType<typeof useQQMail>;

function formatMailTime(time: number, locale: string) {
  return new Date(time).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function MailHtmlFrame({ html, onOpenLink, onHeight }: { html: string; onOpenLink: (href: string) => void; onHeight?: (height: number) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const [height, setHeight] = useState(200);
  const doc = useMemo(
    () => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}html{overflow:hidden}body{background:#ffffff;color:#1a1a1a;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;padding:14px;word-break:break-word;overflow-wrap:anywhere}img{max-width:100%;height:auto;border:0}a{color:#0b66c3}table{max-width:100%}*{box-sizing:border-box}</style></head><body>${html}</body></html>`,
    [html],
  );

  // Keep the iframe exactly as tall as its content so it never shows its own
  // scrollbar; the outer reader scrolls only once the island hits its cap.
  const measure = useCallback(() => {
    const body = ref.current?.contentDocument?.body;
    if (!body) return;
    const next = Math.min(Math.max(body.scrollHeight, 60), 20000);
    setHeight(next);
    onHeight?.(next);
  }, [onHeight]);

  const handleLoad = useCallback(() => {
    const frameDoc = ref.current?.contentDocument;
    if (!frameDoc?.body) return;
    measure();
    observerRef.current?.disconnect();
    const observer = new ResizeObserver(() => measure());
    observer.observe(frameDoc.body);
    observerRef.current = observer;
    frameDoc.addEventListener("click", (event) => {
      const anchor = (event.target as Element | null)?.closest?.("a");
      if (!anchor) return;
      event.preventDefault();
      const href = anchor.getAttribute("href");
      if (href && /^https?:/i.test(href)) onOpenLink(href);
    });
  }, [measure, onOpenLink]);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return (
    <iframe ref={ref} className="qq-mail-frame" title="email" scrolling="no" sandbox="allow-same-origin" srcDoc={doc} onLoad={handleLoad} style={{ height: `${height}px` }} />
  );
}

function MailProviderSelect({ value, disabled, onChange }: { value: MailProvider; disabled?: boolean; onChange: (provider: MailProvider) => void }) {
  const t = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const options: MailProvider[] = ["qq", "gmail", "custom"];
  const label = (provider: MailProvider) => t.mail.providerNames[provider];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKeyDown); };
  }, [open]);

  return (
    <div className="qq-mail-field qq-mail-field--select" ref={ref}>
      <Server size={16} strokeWidth={1.8} aria-hidden="true" />
      <button type="button" className="mail-provider-select__button" aria-haspopup="listbox" aria-expanded={open} aria-label={t.mail.provider} disabled={disabled} onClick={() => setOpen((value) => !value)}>
        <span>{label(value)}</span>
        <ChevronDown size={15} strokeWidth={2} className={`mail-provider-select__chevron${open ? " mail-provider-select__chevron--open" : ""}`} />
      </button>
      {open && (
        <ul className="mail-provider-select__list" role="listbox" aria-label={t.mail.provider}>
          {options.map((option) => (
            <li key={option} role="option" aria-selected={option === value}>
              <button type="button" className={`mail-provider-select__option${option === value ? " mail-provider-select__option--active" : ""}`} onClick={() => { onChange(option); setOpen(false); }}>
                <span>{label(option)}</span>
                {option === value && <Check size={14} strokeWidth={2.4} />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MailConnectForm({ controller }: { controller: QQMailController }) {
  const { snapshot, busy, connect } = controller;
  const t = useTranslation();
  const [email, setEmail] = useState(snapshot.email ?? "");
  const [authorizationCode, setAuthorizationCode] = useState("");
  const [provider, setProvider] = useState<MailProvider>(() => loadProviderPrefs().provider);
  const [customHost, setCustomHost] = useState(() => loadProviderPrefs().host);
  const [customPort, setCustomPort] = useState(() => String(loadProviderPrefs().port));
  const resolvedHost = provider === "custom" ? customHost.trim() : MAIL_PROVIDER_PRESETS[provider].host;
  const resolvedPort = provider === "custom" ? Number(customPort) || 993 : MAIL_PROVIDER_PRESETS[provider].port;

  useEffect(() => { if (snapshot.email) setEmail(snapshot.email); }, [snapshot.email]);

  return (
    <form className="qq-mail-form" onSubmit={(event) => {
      event.preventDefault();
      saveProviderPrefs({ provider, host: customHost, port: Number(customPort) || 993 });
      void connect(email, authorizationCode, resolvedHost, resolvedPort).then((connected) => { if (connected) setAuthorizationCode(""); });
    }}>
      <div className="qq-mail-fields">
        <MailProviderSelect value={provider} disabled={busy || snapshot.configured} onChange={setProvider} />
        <label className="qq-mail-field"><AtSign size={16} strokeWidth={1.8} aria-hidden="true" /><input aria-label={t.mail.email} type="email" autoComplete="username" placeholder={t.mail.emailPlaceholder} required maxLength={120} value={email} disabled={busy || snapshot.configured} onChange={(event) => setEmail(event.currentTarget.value)} /></label>
        {provider === "custom" && (
          <div className="qq-mail-field-row">
            <label className="qq-mail-field qq-mail-field--host"><Server size={16} strokeWidth={1.8} aria-hidden="true" /><input aria-label={t.mail.imapHost} type="text" autoComplete="off" spellCheck={false} placeholder={t.mail.imapHostPlaceholder} required maxLength={255} value={customHost} disabled={busy} onChange={(event) => setCustomHost(event.currentTarget.value)} /></label>
            <label className="qq-mail-field qq-mail-field--port"><input aria-label={t.mail.imapPort} type="number" inputMode="numeric" min={1} max={65535} placeholder="993" value={customPort} disabled={busy} onChange={(event) => setCustomPort(event.currentTarget.value)} /></label>
          </div>
        )}
        <label className="qq-mail-field"><KeyRound size={16} strokeWidth={1.8} aria-hidden="true" /><input aria-label={t.mail.authorizationCode} type="password" autoComplete="off" placeholder={t.mail.authorizationPlaceholder} required maxLength={256} value={authorizationCode} disabled={busy} onChange={(event) => setAuthorizationCode(event.currentTarget.value)} /></label>
      </div>
      <div className="qq-mail-form__actions">
        <button className="message-action qq-mail-connect" type="submit" disabled={busy || !email.trim() || !authorizationCode.trim() || (provider === "custom" && !customHost.trim())}>{busy ? <LoaderCircle size={15} strokeWidth={1.8} className="qq-mail-spinning" /> : <ArrowRight size={15} strokeWidth={1.8} />}{busy ? t.common.connecting : t.mail.connect}</button>
      </div>
    </form>
  );
}

export function MailAccountSettings({ controller }: { controller: QQMailController }) {
  const { snapshot, busy, actionError, setEnabled, disconnect } = controller;
  const t = useTranslation();
  if (!isTauri()) return <p className="mail-settings__hint">{t.mail.desktopConnect}</p>;
  const showForm = !snapshot.configured || snapshot.status === "authRequired";
  const error = actionError || snapshot.error;
  return (
    <div className="mail-settings">
      {snapshot.configured && (
        <div className="mail-settings__account">
          <span className="message-status" data-state={snapshot.status} role="status" aria-label={t.mail.status[snapshot.status]} />
          <span className="mail-settings__email" title={snapshot.email ?? undefined}>{snapshot.email}</span>
          <button className="icon-button message-receiver-toggle" type="button" role="switch" aria-checked={snapshot.enabled} aria-label={t.mail.receive} title={snapshot.enabled ? t.mail.pause : t.mail.resume} disabled={busy || snapshot.status === "authRequired"} onClick={() => void setEnabled(!snapshot.enabled)}><Power size={15} strokeWidth={1.8} /></button>
          <button className="icon-button" type="button" title={t.mail.disconnect} aria-label={t.mail.disconnectLabel} disabled={busy} onClick={() => void disconnect()}><Unplug size={16} strokeWidth={1.8} /></button>
        </div>
      )}
      {error && <p className="qq-panel__error" role="alert">{error}</p>}
      {showForm && <MailConnectForm controller={controller} />}
    </div>
  );
}

export function QQMailPanel({ controller, navigation, onRead, onBack }: {
  controller: QQMailController;
  navigation: ReactNode;
  onRead?: (message: MailMessage) => void;
  onBack?: () => void;
}) {
  const { snapshot, busy, actionError, setEnabled, refresh, markAllRead, disconnect, openMail, openHelp } = controller;
  const t = useTranslation();
  const showForm = !snapshot.configured || snapshot.status === "authRequired";
  const error = actionError || snapshot.error;
  const listRef = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  const returnFocus = useRef<string | null>(null);
  const { selectedMail, content, reading, readError, readMail, closeReader, openLink, setReaderHeight } = controller;
  const html = useMemo(() => content?.contentType === "text/html" ? sanitizeMailHtml(content.content) : "", [content]);
  const readerRef = useRef<HTMLDivElement>(null);

  const reportReaderHeight = useCallback(() => {
    const scroll = readerRef.current?.scrollHeight;
    if (!scroll) return;
    // scroll = subject + meta + body (incl. reader padding); add the island
    // chrome around it (window padding, header, panel header, notice).
    setReaderHeight(Math.min(Math.max(scroll + 150, 360), 660));
  }, [setReaderHeight]);

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

  useLayoutEffect(() => {
    if (!selectedMail) { setReaderHeight(null); return; }
    reportReaderHeight();
  }, [selectedMail, content, reading, readError, reportReaderHeight, setReaderHeight]);

  if (selectedMail) return (
    <section className="qq-panel qq-mail-panel" aria-label={t.mail.reader}>
      <header className="qq-panel__header">
        <button className="message-action qq-mail-back" type="button" onClick={onBack ?? closeReader}><ArrowLeft size={15} strokeWidth={1.8} />{t.mail.back}</button>
        <button className="message-action" type="button" title={t.mail.webHint} onClick={() => void openMail()}>{t.mail.openWeb}<ArrowUpRight size={14} strokeWidth={1.8} /></button>
      </header>
      {actionError && <p className="qq-panel__error" role="alert">{actionError}</p>}
      <div className="qq-mail-reader" ref={readerRef} tabIndex={-1} aria-label={t.mail.body} aria-busy={reading}>
        <h2 className="qq-mail-reader__subject">{selectedMail.subject}</h2>
        <div className="qq-mail-reader__meta"><span>{selectedMail.sender}</span>{selectedMail.receivedAt !== null && <time dateTime={new Date(selectedMail.receivedAt).toISOString()}>{formatMailTime(selectedMail.receivedAt, t.localeTag)}</time>}</div>
        {reading ? <div className="qq-mail-reader__state" role="status"><LoaderCircle size={19} className="qq-mail-spinning" />{t.mail.loading}</div>
          : readError ? <div className="qq-mail-reader__state"><p className="qq-panel__error" role="alert">{readError}</p><button className="message-action" type="button" onClick={() => void readMail(selectedMail)}><RefreshCw size={14} />{t.common.retry}</button></div>
          : content?.contentType === "text/html" ? (html ? <MailHtmlFrame html={html} onOpenLink={(href) => void openLink(href)} onHeight={() => requestAnimationFrame(reportReaderHeight)} /> : <div className="qq-mail-body qq-mail-body--text">{t.mail.emptyHtml}</div>)
          : <div className="qq-mail-body qq-mail-body--text">{content?.content || t.mail.emptyText}</div>}
      </div>
      <p className="qq-mail-reader__notice">{t.mail.notice}</p>
    </section>
  );

  return (
    <section className="qq-panel qq-mail-panel" aria-label={t.messages.qqMail}>
      <header className="qq-panel__header">
        {navigation}
        <div className="qq-panel__toolbar">
          {snapshot.configured && <button className="icon-button message-receiver-toggle" type="button" role="switch" aria-checked={snapshot.enabled} aria-label={t.mail.receive} title={snapshot.enabled ? t.mail.pause : t.mail.resume} disabled={busy || snapshot.status === "authRequired"} onClick={() => void setEnabled(!snapshot.enabled)}><Power size={15} strokeWidth={1.8} /></button>}
          {showForm && <button className="icon-button" type="button" title={t.mail.help} aria-label={t.mail.helpLabel} onClick={() => void openHelp()}><CircleHelp size={16} strokeWidth={1.8} /></button>}
          <button className="icon-button" type="button" title={t.mail.open} aria-label={t.mail.openLabel} onClick={() => void openMail()}><ArrowUpRight size={16} strokeWidth={1.8} /></button>
          {snapshot.configured && (snapshot.unreadCount ?? 0) > 0 && <button className="icon-button" type="button" title={t.mail.markAllRead} aria-label={t.mail.markAllRead} disabled={busy || snapshot.syncing || !snapshot.enabled || snapshot.status === "authRequired"} onClick={() => void markAllRead()}><CheckCheck size={16} strokeWidth={1.8} /></button>}
          {snapshot.configured && <button className="icon-button" type="button" title={snapshot.lastSyncedAt === null ? t.mail.refresh : t.mail.lastSynced(formatMailTime(snapshot.lastSyncedAt, t.localeTag))} aria-label={t.mail.refreshLabel} disabled={busy || snapshot.syncing || !snapshot.enabled || snapshot.status === "authRequired"} onClick={() => void refresh()}><RefreshCw size={16} strokeWidth={1.8} className={snapshot.syncing ? "qq-mail-spinning" : undefined} /></button>}
          {snapshot.configured && <button className="icon-button" type="button" title={t.mail.disconnect} aria-label={t.mail.disconnectLabel} disabled={busy} onClick={() => void disconnect()}><Unplug size={16} strokeWidth={1.8} /></button>}
        </div>
      </header>
      {snapshot.configured && <div className="qq-mail-account" title={`${snapshot.email} · ${t.mail.status[snapshot.status]}`}><span className="message-status" data-state={snapshot.status} role="status" aria-label={t.mail.status[snapshot.status]} /><span className="qq-mail-account__email">{snapshot.email}</span></div>}
      {error && <p className="qq-panel__error" role="alert">{error}</p>}
      {showForm ? (
        <div className="qq-panel__empty" role="status"><span className="message-empty-icon"><MessageSourceIcon source="qqMail" email={snapshot.email} size={28} /></span><span>{t.mail.configureInSettings}</span></div>
      ) : (
        <>
          <div className="qq-panel__list qq-mail-list" ref={listRef} onScroll={(event) => { listScroll.current = event.currentTarget.scrollTop; }} role="list" aria-label={t.mail.inbox} aria-busy={snapshot.syncing}>
            {snapshot.items.length === 0 ? (
              <div className="qq-panel__empty" role="status"><span className="message-empty-icon">{snapshot.syncing ? <LoaderCircle size={26} strokeWidth={1.5} className="qq-mail-spinning" /> : <MessageSourceIcon source="qqMail" email={snapshot.email} size={28} />}</span><span>{snapshot.syncing ? t.mail.syncing : t.mail.empty}</span></div>
            ) : snapshot.items.map((item) => (
              <article className={`qq-panel__item qq-mail-item${item.unread ? " qq-mail-item--unread" : ""}`} key={item.id} role="listitem">
                <button type="button" data-mail-id={item.id} onClick={() => { if (onRead) onRead(item); else void readMail(item); }} aria-label={t.mail.readMessage(item.subject, item.unread)}>
                  <div className="qq-panel__item-heading"><strong title={item.sender}>{item.unread && <span className="qq-mail-unread-dot" aria-hidden="true" />}<span>{item.sender}</span></strong>{item.receivedAt !== null && <time dateTime={new Date(item.receivedAt).toISOString()}>{formatMailTime(item.receivedAt, t.localeTag)}</time>}</div>
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
