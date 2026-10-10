'use strict';

function parseUserAgent(value) {
  if (!value) return { browser: 'Unknown', os: 'Unknown', deviceType: 'Desktop' };
  const ua = String(value).toLowerCase();

  const os =
    /windows nt (\d+\.?\d*)/.exec(ua) ? `Windows ${RegExp.$1}` :
    /mac os x (\d+[._]\d+[._]?\d*)/.exec(ua) ? `macOS ${RegExp.$1.replace(/_/g, '.')}` :
    /iphone os (\d+[._]\d+)/.exec(ua) ? `iOS ${RegExp.$1.replace(/_/g, '.')}` :
    /ipad.*os (\d+[._]\d+)/.exec(ua) ? `iPadOS ${RegExp.$1.replace(/_/g, '.')}` :
    /android (\d+(?:[./]\d+)?)/.exec(ua) ? `Android ${RegExp.$1.replace(/\//, '.')}` :
    /cros/.test(ua) ? 'ChromeOS' :
    /linux/.test(ua) ? 'Linux' :
    'Unknown';

  const browser =
    /edg\/(\d+[.\d]*)/.exec(ua) ? `Edge ${RegExp.$1.split('.')[0]}` :
    /opr\/(\d+[.\d]*)/.exec(ua) ? `Opera ${RegExp.$1.split('.')[0]}` :
    /samsungbrowser\/(\d+)/.exec(ua) ? `Samsung ${RegExp.$1}` :
    /firefox\/(\d+[.\d]*)/.exec(ua) ? `Firefox ${RegExp.$1.split('.')[0]}` :
    /chrome\/(\d+[.\d]*)/.exec(ua) && !/edg|opr/.test(ua) ? `Chrome ${RegExp.$1.split('.')[0]}` :
    /safari\/(\d+[.\d]*)/.exec(ua) && !/chrome/.test(ua) ? `Safari ${RegExp.$1.split('.')[0]}` :
    /micromessenger\/(\d+)/.exec(ua) ? `WeChat ${RegExp.$1}` :
    /instagram/.test(ua) ? 'Instagram' :
    /tiktok/.test(ua) ? 'TikTok' :
    'Unknown';

  const deviceType =
    /tablet|ipad|playbook|silk|(android(?!.*mobile))/.test(ua) ? 'Tablet' :
    /mobile|android|iphone|ipod|blackberry|mini|windows\s+phone|silk/.test(ua) ? 'Mobile' :
    'Desktop';

  return { os, browser, deviceType };
}

module.exports = { parseUserAgent };
