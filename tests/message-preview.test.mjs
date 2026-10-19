import assert from "node:assert/strict";
import test from "node:test";
import { latestMessagePreview, mailBadgeCount } from "../src/messagePreview.ts";

test("QQ, WeChat and mail share the preview by most recent arrival", () => {
  const qq = { source: "qq", title: "QQ", body: "message", receivedAt: 100 };
  const wechat = { source: "wechat", title: "微信", body: "reminder", receivedAt: 200 };
  const mail = { source: "qqMail", title: "sender", body: "subject", receivedAt: 300 };
  assert.equal(latestMessagePreview([qq, wechat, mail]), mail);
  assert.equal(latestMessagePreview([mail, { ...qq, receivedAt: 400 }, wechat]).source, "qq");
  assert.equal(latestMessagePreview([qq, mail, { ...wechat, receivedAt: 500 }]).source, "wechat");
  assert.equal(latestMessagePreview([null, qq, null]), qq);
  assert.equal(latestMessagePreview([null, null, null]), null);
});

test("mail badges bound the width without changing actual unread counts", () => {
  assert.equal(mailBadgeCount(0), "0");
  assert.equal(mailBadgeCount(99), "99");
  assert.equal(mailBadgeCount(100), "99+");
  assert.equal(mailBadgeCount(12345), "99+");
});
