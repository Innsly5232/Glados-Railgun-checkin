"""Run the reviewed zzusec page module in an isolated cloud browser.

Only the official verification widget may supply its result. No CAPTCHA clicks,
browser fingerprint patches, token reuse, or retries after uncertain submission.
"""

import os
import math
from pathlib import Path
import re


def summarize(result):
    """Return fixed diagnostics only; discard account identity and page messages."""
    if not isinstance(result, dict):
        return {"client_error": "browser-no-result", "browser_stage": "response"}
    diagnostic = {
        "submitted": result.get("checkinAttempted") is True,
        "verification_required": result.get("verificationRequired") is True,
        "verification_error": "none",
    }
    error = result.get("verificationError")
    if isinstance(error, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,32}", error):
        diagnostic["verification_error"] = error
    if result.get("ok") is True and result.get("code") in (0, 1):
        award = result.get("checkinPoints", 0)
        if (not isinstance(award, (float, int)) or isinstance(award, bool)
                or not math.isfinite(award) or award < 0):
            award = 0
        return {"code": result["code"], "repeated": result.get("already") is True,
                "points": award, "message": "Cloud browser check-in acknowledged",
                "extension_diagnostic": diagnostic}
    if result.get("verificationRequired") is True and not diagnostic["submitted"]:
        return {"client_error": "human-verification-required",
                "extension_diagnostic": diagnostic}
    reason = result.get("reason")
    if reason not in ("turnstile", "device-mismatch"):
        reason = "browser-request-failed"
    code = result.get("code")
    if not isinstance(code, int) or isinstance(code, bool) or code in (0, 1):
        return {"client_error": "browser-no-result", "browser_stage": "response",
                "extension_diagnostic": diagnostic}
    return {"code": code,
            "reason": reason, "message": "Cloud browser check-in not confirmed",
            "extension_diagnostic": diagnostic}


def checkin(domain, cookie, user_agent):
    if domain != "glados.cloud":
        return {"client_error": "browser-unavailable", "browser_stage": "navigate"}
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return {"client_error": "browser-unavailable", "browser_stage": "import"}
    source = (Path(__file__).parent / "vendor/zzusec/page-api.js").read_text()
    source = source.replace("export async function pageAction", "async function pageAction", 1)
    cookies = []
    for part in cookie.split(";"):
        name, separator, value = part.strip().partition("=")
        if separator and name:
            cookies.append({"name": name, "value": value,
                            "url": "https://glados.cloud", "secure": True})
    stage = "launch"
    try:
        with sync_playwright() as runtime:
            headless = os.environ.get("GLADOS_BROWSER_HEADLESS", "true").lower() not in ("false", "0", "no")
            browser = runtime.chromium.launch(headless=headless)
            try:
                stage = "context"
                context = browser.new_context(user_agent=user_agent)
                context.add_cookies(cookies)
                page = context.new_page()
                stage = "navigate"
                page.goto("https://glados.cloud/console", wait_until="domcontentloaded", timeout=30000)
                # Observe the page's own interaction prompt, without inspecting
                # challenge internals or automating any verification controls.
                page.evaluate("""() => {
                    window.__gladosTrialInteractive = false;
                    new MutationObserver(() => {
                        const panel = document.getElementById('glados-checkin-verification');
                        if (panel?.textContent.includes('请在下方完成官网验证'))
                            window.__gladosTrialInteractive = true;
                    }).observe(document.body, {subtree:true, childList:true, characterData:true});
                }""")
                # Verify this context's current identity; do not enumerate or sign
                # any other account saved by the website's multi-account feature.
                stage = "identity"
                account = page.evaluate("""async () => {
                    const get = async path => {
                        const r = await fetch('/api/user/' + path, {
                            credentials:'include', signal:AbortSignal.timeout(15000)});
                        const d = await r.json();
                        if (!r.ok || d.code !== 0) throw new Error('Identity unavailable');
                        return d.data;
                    };
                    const current = await get('status');
                    const accounts = await get('accounts');
                    const target = accounts.filter(a => a.email === current.email);
                    if (!current.email || target.length !== 1) throw new Error('Identity mismatch');
                    return {email:current.email, userId:target[0].userId};
                }""")
                stage = "verification"
                # Visible official widget; if interaction is required, wait for
                # the module's bounded failure. Never click the CAPTCHA itself.
                result = page.evaluate("async input => {\n" + source +
                                       "\nreturn await pageAction(input); }",
                                       {"op": "checkin", "account": account, "interactive": True})
                raw = summarize(result)
                raw.setdefault("extension_diagnostic", {})["interactive_prompt"] = page.evaluate(
                    "window.__gladosTrialInteractive === true")
                return raw
            finally:
                browser.close()
    except Exception:
        return {"client_error": "browser-unavailable", "browser_stage": stage}
