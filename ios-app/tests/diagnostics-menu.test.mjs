import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const source = await fs.readFile(new URL('../ios/App/App/SillyTavernViewController.swift', import.meta.url), 'utf8');
const match = source.match(/let diagnosticsScript = """\r?\n([\s\S]+?)\r?\n\s*"""/);
assert.ok(match, 'The native-injected diagnostic menu script must exist.');
const script = match[1].split(/\r?\n/).map(line => line.replace(/^ {12}/, '')).join('\n');
const marker = { deploymentId: 'a'.repeat(64), version: '1.19.0' };

function environment({ url = 'http://localhost:8000', native = marker, language = 'en', settings = true } = {}) {
    const messages = [];
    const observers = [];
    const elements = [];
    class Element {
        attributes = new Map();
        children = [];
        listeners = new Map();
        style = {};
        disabled = false;
        id = '';
        appendChild(child) { this.children.push(child); child.parentNode = this; }
        insertBefore(child, next) { const index = this.children.indexOf(next); this.children.splice(index < 0 ? this.children.length : index, 0, child); child.parentNode = this; }
        setAttribute(name, value) { this.attributes.set(name, value); }
        getAttribute(name) { return this.attributes.get(name); }
        addEventListener(name, callback) { this.listeners.set(name, callback); }
        click(isTrusted = true) { this.listeners.get('click')?.({ isTrusted }); }
    }
    const html = new Element();
    html.lang = language;
    const icon = new Element();
    icon.setAttribute('title', 'User Settings');
    const parent = new Element();
    const row = new Element();
    const content = new Element();
    parent.appendChild(row);
    parent.appendChild(content);
    row.nextSibling = content;
    const document = {
        documentElement: html,
        querySelector(selector) { return selector.includes('UserSettingsRowTwo') ? settings ? row : null : icon; },
        getElementById(id) { return elements.find(element => element.id === id); },
        createElement(type) { const element = new Element(); element.typeName = type; elements.push(element); return element; },
    };
    const window = { __ST_IOS_APP__: native, webkit: { messageHandlers: { stDiagnostics: { postMessage: body => messages.push(body) } } } };
    const context = vm.createContext({ window, document, location: new URL(url), MutationObserver: class {
        constructor(callback) { this.callback = callback; }
        observe(element, options) { observers.push({ element, options, callback: this.callback }); }
    } });
    vm.runInContext(script, context);
    return { window, messages, elements, html, icon, parent, context, button: document.getElementById('st-ios-export-diagnostics'),
        update(element, attribute) { for (const observer of observers) if (observer.element === element && observer.options.attributeFilter.includes(attribute)) observer.callback(); },
    };
}

test('the native settings entry does not appear on remote or unmarked web pages', () => {
    for (const options of [{ url: 'https://example.test' }, { url: 'http://localhost:9000' }, { native: undefined }, { native: { deploymentId: 1, version: '1.19.0' } }]) {
        // Explicit undefined uses the default argument; null represents no marker.
        if ('native' in options && options.native === undefined) options.native = null;
        const env = environment(options);
        assert.equal(env.button, undefined);
        assert.equal(env.messages.length, 0);
    }
});

test('the settings button uses a new layout row and preserves the existing header controls', () => {
    const env = environment();
    assert.ok(env.button);
    assert.equal(env.parent.children.length, 3);
    assert.equal(env.parent.children[1].children[0], env.button);
    assert.equal(env.button.style.minHeight, '44px');
    assert.equal(env.button.getAttribute('aria-label'), 'Export diagnostics');
    assert.equal(env.icon.getAttribute('role'), 'button');
    assert.equal(env.icon.id, 'st-ios-user-settings-toggle');
    assert.equal(env.icon.getAttribute('aria-label'), 'User Settings');
    vm.runInContext(script, env.context);
    assert.equal(env.elements.filter(element => element.id === 'st-ios-export-diagnostics').length, 1);
});

test('the export bridge requires a trusted click and releases its lock after native cancellation', () => {
    const env = environment();
    env.button.click(false);
    assert.equal(env.messages.filter(message => message.action === 'export').length, 0);
    env.button.click();
    env.button.click();
    assert.equal(env.messages.filter(message => message.action === 'export').length, 1);
    assert.equal(env.button.disabled, true);
    env.window.__ST_IOS_DIAGNOSTICS_FINISHED__();
    env.button.click();
    assert.equal(env.messages.filter(message => message.action === 'export').length, 2);
    const message = env.messages.at(-1);
    assert.deepEqual(Object.keys(message).sort(), ['action', 'deploymentId', 'language', 'version']);
    assert.equal(message.deploymentId, marker.deploymentId);
});

test('actual document language and localized settings title update both accessible labels', () => {
    const env = environment();
    env.html.lang = 'ko-kr';
    env.update(env.html, 'lang');
    env.icon.setAttribute('title', '사용자 설정');
    env.update(env.icon, 'title');
    assert.equal(env.button.getAttribute('aria-label'), '진단 로그 내보내기');
    assert.equal(env.icon.getAttribute('aria-label'), '사용자 설정');
    env.button.click();
    assert.equal(env.messages.at(-1).language, 'ko');
    assert.equal(env.messages.at(-1).action, 'export');
});

test('missing settings markup does not install a floating or duplicate export control', () => {
    const env = environment({ settings: false });
    assert.equal(env.button, undefined);
    assert.equal(env.elements.length, 0);
    assert.equal(env.messages.length, 0);
});
