// ==UserScript==
// @name         Auto Refresh Page
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Automatically refresh the page every 5 minutes
// @author       Your Name
// @match        https://www.chiphell.com/*
// @match        https://www.javbus.com/forum*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // 设置刷新间隔时间，单位为毫秒
    var refreshInterval = 60 * 1000 * 10;
    // 使用 setInterval 每隔一段时间刷新页面
    setInterval(function() {
        const last = localStorage.getItem('last-flash-time');
        console.log(`check reflash @${Date.now()}`);
        if (last === null || Number.parseInt(last) + refreshInterval < Date.now()) {
            localStorage.setItem('last-flash-time', Date.now());
            location.reload();
        }
    }, 1800 * 1000);

})();
