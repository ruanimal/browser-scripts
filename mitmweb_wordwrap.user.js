// ==UserScript==
// @name         mitmweb Word Wrap Toggle
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  为 mitmweb 的 request/response 内容添加自动换行切换按钮
// @match        http://127.0.0.1:8081/*
// @author       ruanimal
// @updateURL    https://github.com/ruanimal/browser-scripts/raw/master/mitmweb_wordwrap.user.js
// @downloadURL  https://github.com/ruanimal/browser-scripts/raw/master/mitmweb_wordwrap.user.js
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const STYLE_ID = 'mitmweb-wordwrap-style';
    const BTN_CLASS = 'mitmweb-wordwrap-btn';
    let wrapEnabled = false;

    const wrapCSS = `
        .contentview pre {
            white-space: pre-wrap !important;
            word-break: break-all !important;
        }
        .codeeditor .cm-editor .cm-content {
            white-space: pre-wrap !important;
            word-break: break-all !important;
        }
        .codeeditor .cm-editor .cm-line {
            word-break: break-all !important;
        }
    `;

    function applyWrap() {
        if (wrapEnabled) {
            if (!document.getElementById(STYLE_ID)) {
                const style = document.createElement('style');
                style.id = STYLE_ID;
                style.textContent = wrapCSS;
                document.head.appendChild(style);
            }
        } else {
            const el = document.getElementById(STYLE_ID);
            if (el) el.remove();
        }
        document.querySelectorAll('.' + BTN_CLASS).forEach(updateBtn);
    }

    function updateBtn(btn) {
        const icon = btn.querySelector('i');
        if (icon) icon.className = wrapEnabled ? 'fa fa-align-left' : 'fa fa-align-justify';
        const text = btn.querySelector('.wrap-label');
        if (text) text.textContent = wrapEnabled ? 'Wrap' : 'Wrap';
        btn.classList.toggle('btn-primary', wrapEnabled);
        btn.classList.toggle('btn-default', !wrapEnabled);
    }

    function injectBtn(controls) {
        if (controls.querySelector('.' + BTN_CLASS)) return;
        const copyBtn = controls.querySelector('button');
        if (!copyBtn) return;

        const btn = document.createElement('button');
        btn.className = 'btn-xs btn btn-default ' + BTN_CLASS;
        btn.innerHTML = '<i class="fa fa-align-justify"></i>&nbsp;<span class="wrap-label">Wrap</span>';
        btn.addEventListener('click', () => {
            wrapEnabled = !wrapEnabled;
            applyWrap();
        });
        // 插入到 Copy 按钮后面
        copyBtn.after(document.createTextNode('\u00a0'), btn);
        updateBtn(btn);
    }

    // 监听 DOM 变化，在 .controls 出现时注入按钮
    const observer = new MutationObserver(() => {
        document.querySelectorAll('.controls').forEach(injectBtn);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // 页面已加载的情况
    document.querySelectorAll('.controls').forEach(injectBtn);
})();
