/*
 * Krakatoa — the pages served before anyone is signed in.
 *
 * Plain server-rendered HTML with no script, so they work before the app has
 * been built and cannot be served stale by the service worker the way a cached
 * app shell can. Same colours as the app.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d0f12">
<meta name="robots" content="noindex">
<link rel="icon" href="/favicon.ico" sizes="any">
<title>${esc(title)} · Krakatoa</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: #0d0f12; color: #e8eaee; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 380px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  p { color: #9aa1ad; margin: 0 0 20px; }
  label { display: block; font-size: 13px; color: #9aa1ad; margin: 14px 0 6px; }
  input { width: 100%; padding: 12px 14px; border-radius: 12px; border: 1px solid #2a2f38;
    background: #161a20; color: inherit; font: inherit; }
  input:focus { outline: 2px solid #f59e0b; outline-offset: 1px; border-color: transparent; }
  button { width: 100%; margin-top: 22px; padding: 13px; border: 0; border-radius: 12px;
    background: #f59e0b; color: #1a1205; font: inherit; font-weight: 600; line-height: 1; cursor: pointer; }
  .err { color: #fca5a5; background: #2a1414; border-radius: 10px; padding: 10px 12px; margin: 0 0 12px; }
  code { background: #161a20; padding: 2px 6px; border-radius: 6px; font-size: 14px; }
  .brand { font-weight: 700; letter-spacing: .02em; color: #f59e0b; margin-bottom: 18px; }
</style>
</head>
<body><main>
<div class="brand">Krakatoa</div>
${body}
</main></body>
</html>`
}

const error = (msg) => (msg ? `<div class="err" role="alert">${esc(msg)}</div>` : '')

function loginPage({ next = '/', message = '' } = {}) {
  return page('Sign in', `
<h1>Sign in</h1>
<p>Your food log.</p>
${error(message)}
<form method="post" action="/api/auth/login">
  <input type="hidden" name="next" value="${esc(next)}">
  <label for="u">Username</label>
  <input id="u" name="username" autocomplete="username" autocapitalize="none" required autofocus>
  <label for="p">Password</label>
  <input id="p" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
</form>`)
}

function setupPage({ token, message = '', username = '' }) {
  return page('Set up', `
<h1>Set up Krakatoa</h1>
<p>Create the owner account. This is the only account, and this link stops working once it exists.</p>
${error(message)}
<form method="post" action="/api/auth/setup">
  <input type="hidden" name="token" value="${esc(token)}">
  <label for="u">Username</label>
  <input id="u" name="username" value="${esc(username)}" autocomplete="username" autocapitalize="none" required autofocus>
  <label for="p">Password (at least 10 characters)</label>
  <input id="p" name="password" type="password" autocomplete="new-password" minlength="10" required>
  <label for="c">Password again</label>
  <input id="c" name="confirm" type="password" autocomplete="new-password" minlength="10" required>
  <button type="submit">Create account</button>
</form>`)
}

function notSetUpPage() {
  return page('Not set up', `
<h1>Not set up yet</h1>
<p>This install has no owner account. Open the setup link printed in the server's log. It looks like
<code>/setup?token=…</code>. Restarting the server prints a fresh one.</p>`)
}

function badSetupLinkPage() {
  return page('Setup link', `
<h1>That setup link has expired</h1>
<p>Setup links are single-use and change every time the server restarts. Use the newest one in the server's log, or
<a href="/login" style="color:#f59e0b">sign in</a> if the account already exists.</p>`)
}

module.exports = { loginPage, setupPage, notSetUpPage, badSetupLinkPage, esc }
