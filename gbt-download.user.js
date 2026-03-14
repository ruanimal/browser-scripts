// ==UserScript==
// @name         GBT小组游戏空间种子列表下载
// @namespace    http://tampermonkey.net/
// @version      0.5
// @description  GBT小组游戏空间种子列表下载。点击'开始下载'下载种子列表，根据文件列表的多少， 等待几十秒到几分钟不等。
// @author       You
// @match        http://renxufeng.ys168.com/*
// @match        http://gbtgame.ys168.com/*
// @match        http://gbtgame.ysepan.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

function sleep(ms){
    return new Promise(function (resolve, reject) {
        setTimeout(()=>{
            resolve();
        },ms);
    })
}

function download(filename, text) {
  var element = document.createElement('a');
  element.setAttribute('href', 'data:text/plain;charset=utf-8,' + text);
  element.setAttribute('download', filename);
  element.style.display = 'none';
  document.body.appendChild(element);
  element.click();
  document.body.removeChild(element);
}

async function main(){
    await sleep(1000)
    var jobs = document.querySelectorAll('.ml')
    for (let i of jobs) {
        i.click()
        await sleep(2000)
    }

    var content = ''
    var urls = document.querySelectorAll('.xwj a')
    for (let i of urls) {
        if (i.href.indexOf('http') < 0) { continue }
        content += i.href
        content += '\n'
        console.log(i.href)
    }
    download("ys168-files.txt", content)
}

var _btn = document.createElement('button')
_btn.style.position = 'fixed'
_btn.style.top = '20px'
_btn.style.right = '60px'
_btn.innerText = '开始下载'
_btn.onclick = async () => {
    await main()
    alert('下载完成！')
}
document.body.appendChild(_btn)
})();
