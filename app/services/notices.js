// Messages that may be shown after a redirect. Each route file keeps its own
// table of notices; only keys in that table are honoured, so a crafted ?msg=
// can never put text of its own on the page.

export const noticeFrom = (notices, req) =>
  Object.hasOwn(notices, req.query.msg) ? notices[req.query.msg] : null;
