"""Exercise the unchanged upstream extension through its actual popup button."""
import hashlib
import json
import logging
import os
from pathlib import Path
import tempfile
import time

import checkin

ROOT = Path(__file__).parent
EXTENSION = ROOT / 'vendor/zzusec'


def verify_upstream():
    expected = json.loads((EXTENSION / 'UPSTREAM_SHA256.json').read_text())
    return all(hashlib.sha256((EXTENSION / name).read_bytes()).hexdigest() == digest
               for name, digest in expected.items())


def safe_result(item):
    """Only fixed diagnostics and numeric evidence leave the extension context."""
    allowed_stages = {'accounts', 'switch', 'challenge', 'verification', 'checkin', 'points', 'restored'}
    error = str(item.get('verificationError', ''))
    error = error if error.isdigit() and len(error) <= 8 else None
    number = lambda value: value if isinstance(value, (int, float)) and not isinstance(value, bool) and abs(value) < 10**9 else None
    return {
        'ok': item.get('ok') is True, 'already': item.get('already') is True,
        'stage': item.get('stage') if item.get('stage') in allowed_stages else 'unknown',
        'submitted': item.get('checkinAttempted') is True,
        'verification_required': item.get('verificationRequired') is True,
        'verification_error': error,
        'reason': item.get('reason') if item.get('reason') in ('turnstile','device-mismatch') else None,
        'unknown': item.get('unknown') is True,
        'reward': number(item.get('checkinPoints')),
        'balance': number(item.get('points')),
        'days': number(item.get('leftDays')),
    }


def run_extension(runtime, entry, allowed_emails):
    stage = 'launch'
    evidence = {'extension_loaded': False, 'popup_run_clicked': False,
                'interactive_prompt': False, 'auto_redeem': False, 'automatic': False}
    with tempfile.TemporaryDirectory(prefix='glados-full-extension-') as profile:
        try:
            context = runtime.chromium.launch_persistent_context(
                profile, channel='chromium', headless=False,
                user_agent=entry.user_agent or checkin.PLATFORM_UA['macOS'],
                args=['--disable-extensions-except=' + str(EXTENSION),
                      '--load-extension=' + str(EXTENSION)])
        except Exception:
            return {'evidence': {**evidence, 'failure_stage': stage}, 'items': []}
        try:
            workers = context.service_workers
            worker = workers[0] if workers else context.wait_for_event('serviceworker', timeout=30000)
            evidence['extension_loaded'] = worker.url.endswith('/background.js')
            extension_id = worker.url.split('/')[2]
            # Set the extension's actual supported settings before loading any
            # account. Automatic schedules and spending remain off for the trial.
            worker.evaluate("chrome.storage.local.set({automatic:false, autoRedeem:false})")
            cookies = []
            for part in entry.cookie.split(';'):
                name, sep, value = part.strip().partition('=')
                if sep and name:
                    cookies.append({'name': name, 'value': value,
                                    'url': 'https://glados.cloud', 'secure': True})
            context.add_cookies(cookies)
            stage = 'identity'
            page = context.new_page()
            page.goto('https://glados.cloud/console', wait_until='domcontentloaded', timeout=30000)
            identities = page.evaluate("""async () => {
                const get = async path => {
                    const r = await fetch('/api/user/' + path, {
                        credentials:'include', signal:AbortSignal.timeout(15000)});
                    const d = await r.json();
                    if (!r.ok || d.code !== 0) throw new Error('Identity unavailable');
                    return d.data;
                };
                const [current, list] = await Promise.all([get('status'), get('accounts')]);
                if (!current.email || !Array.isArray(list) || !list.length)
                    throw new Error('Identity unavailable');
                return {current:current.email, accounts:list.map(a => ({email:a.email,userId:a.userId}))};
            }""")
            if (identities['current'] not in allowed_emails or
                    any(a['email'] not in allowed_emails for a in identities['accounts'])):
                return {'evidence': {**evidence, 'failure_stage': 'account-scope'}, 'items': []}
            evidence['account_count'] = len(identities['accounts'])
            popup = context.new_page()
            stage = 'popup-navigate'
            popup.goto(f'chrome-extension://{extension_id}/popup.html')
            # Opening the stock popup performs its native account refresh. Wait
            # for that to release the extension's own mutex before clicking.
            run_button = popup.get_by_role('button', name='全部签到', exact=True)
            stage = 'popup-button'
            run_button.wait_for(state='visible', timeout=30000)
            stage = 'popup-refresh'
            # Extension pages apply CSP to injected polling code. Read readiness
            # directly instead of wait_for_function's generated expression.
            ready_deadline = time.monotonic() + 100
            while time.monotonic() < ready_deadline:
                ready = popup.evaluate("""async () => {
                    const s = await chrome.storage.local.get(['lastRefresh','journal','accounts','lastError']);
                    return {ready:!!s.lastRefresh && !s.journal && s.accounts?.length > 0 &&
                        document.getElementById('run')?.disabled === false, failed:!!s.lastError};
                }""")
                if ready['ready']:
                    break
                if ready['failed']:
                    raise RuntimeError('Extension account refresh failed')
                popup.wait_for_timeout(250)
            else:
                raise RuntimeError('Extension account refresh timed out')
            stage = 'run'
            run_button.click(timeout=15000)
            evidence['popup_run_clicked'] = True
            deadline = time.monotonic() + 260
            while time.monotonic() < deadline:
                state = popup.evaluate("""async () => {
                    const {lastRun,lastError} = await chrome.storage.local.get(['lastRun','lastError']);
                    return {lastRun,lastError:!!lastError};
                }""")
                run = state.get('lastRun')
                if run and run.get('state') != 'running':
                    evidence['restored'] = run.get('restoration', {}).get('ok') is True
                    evidence['run_state'] = run.get('state') if run.get('state') in ('success','partial','failed','interrupted') else 'finished'
                    items = run.get('results') or []
                    if any(item.get('email') not in allowed_emails for item in items):
                        return {'evidence': {**evidence, 'failure_stage': 'result-identity'}, 'items': []}
                    return {'evidence': evidence, 'items': items}
                if state['lastError'] and not run:
                    return {'evidence': {**evidence, 'failure_stage': 'extension-run'}, 'items': []}
                for tab in context.pages:
                    if tab.url.startswith('https://glados.cloud/'):
                        try:
                            if tab.get_by_text('请在下方完成官网验证，成功后会自动继续签到。', exact=True).count():
                                evidence['interactive_prompt'] = True
                        except Exception:
                            pass
                popup.wait_for_timeout(500)
            return {'evidence': {**evidence, 'failure_stage': 'result-timeout'}, 'items': []}
        except Exception as error:
            evidence['failure_type'] = type(error).__name__
            evidence['failure_flags'] = [flag for flag in (
                'unsafe-eval','EvalError','Refused to evaluate','Target closed',
                'Execution context','Timeout','refresh failed','refresh timed out') if flag in str(error)]
            if 'popup' in locals():
                try:
                    evidence['popup_diagnostic'] = popup.evaluate("""async () => {
                        const s = await chrome.storage.local.get(['lastRefresh','journal','accounts','lastError']);
                        const m = String(s.lastError || document.getElementById('message')?.textContent || '');
                        return {button_present:!!document.getElementById('run'),
                            button_disabled:document.getElementById('run')?.disabled,
                            refresh_completed:!!s.lastRefresh, journal_present:!!s.journal,
                            discovered_accounts:s.accounts?.length || 0, error_present:!!s.lastError,
                            error_flags:['超时','没有权限','未返回','账号','code=','401','403','Failed to fetch','Cannot access','页面未返回有效执行结果'].filter(w => m.includes(w))};
                    }""")
                except Exception:
                    evidence['popup_diagnostic'] = {'unavailable': True}
            return {'evidence': {**evidence, 'failure_stage': stage}, 'items': []}
        finally:
            context.close()


def main():
    from playwright.sync_api import sync_playwright
    checkin.init_logger()
    if not verify_upstream():
        print('Unchanged upstream extension verification failed')
        return 1
    config = checkin.Config()
    config.exchange_plan = 'none'
    identities = {}
    baselines = {}
    # Resolve the configured accounts first. The original extension may discover
    # multiple saved accounts; every discovered identity must be in this set.
    for entry in config.accounts:
        domain, days = entry._resolve_domain(config, checkin.RunBudget(60))
        entry.result.domain = domain or checkin.UNPROBED
        entry.result.days = days
        if domain != 'glados.cloud':
            continue
        with checkin.API(domain, entry.cookie, user_agent=entry.user_agent) as api:
            status = api.fetch_status()
            email = (status or {}).get('data', {}).get('email')
            if isinstance(email, str) and email:
                identities[email] = entry
                baselines[email] = api.get_points()
    evidence = {'upstream_unchanged': True, 'entrypoint': 'original popup 全部签到',
                'trials': [], 'business_success': False}
    completed = set()
    with sync_playwright() as runtime:
        for email, entry in identities.items():
            if email in completed:
                continue
            outcome = run_extension(runtime, entry, set(identities))
            trial = {'source_account_index': entry.index, **outcome['evidence'], 'results': []}
            for item in outcome['items']:
                target_email = item['email']
                target = identities[target_email]
                completed.add(target_email)
                raw = safe_result(item)
                raw['account_index'] = target.index
                raw['before_balance'] = baselines[target_email]
                if raw['balance'] is not None and raw['before_balance'] is not None:
                    raw['balance_change'] = raw['balance'] - raw['before_balance']
                trial['results'].append(raw)
                target.result.days = checkin.to_int(raw['days'])
                target.result.points_total = checkin.to_int(raw['balance'])
                if raw['ok']:
                    target.result.code = checkin.CheckinStatus.REPEAT if raw['already'] else checkin.CheckinStatus.SUCCESS
                    target.result.points = 0 if raw['already'] else checkin.to_int(raw['reward']) or 0
                else:
                    target.result.failure_reason = ('原版扩展报告登录设备不匹配' if raw['reason'] == 'device-mismatch' else
                                                    '原版扩展要求官网人工验证' if raw['verification_required']
                                                    else '原版扩展未确认签到成功')
            evidence['trials'].append(trial)
            print('FULL_EXTENSION_RESULT ' + json.dumps(trial, ensure_ascii=False))
            if trial.get('popup_run_clicked') and not outcome['items']:
                # A missing final result cannot prove that no account was signed.
                # Do not launch a second profile that could replay the same batch.
                break
    # This experiment targets only GLaDOS; Railgun is not submitted a second time.
    relevant = [entry for entry in config.accounts if entry.result.domain == 'glados.cloud']
    evidence['business_success'] = bool(relevant) and all(
        e.result.code in (checkin.CheckinStatus.SUCCESS, checkin.CheckinStatus.REPEAT) for e in relevant)
    output = ROOT / 'full-extension-result.json'
    output.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
    checkin.Report(checkin.Accounts(relevant)).emit_actions_annotations()
    return 0 if evidence['business_success'] else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print('FULL_EXTENSION_FAILURE ' + type(error).__name__)
        raise SystemExit(1)
