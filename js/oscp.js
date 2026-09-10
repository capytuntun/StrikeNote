/* oscp.js — exam / lab report template generator (OffSec, EC-Council, VHL) */
(function (global) {
  'use strict';

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // ---------------- template registry ----------------
  // kind drives which input fields the form shows and how findings are built.
  const TEMPLATES = [
    { id: 'oscp', org: 'OffSec', code: 'PEN-200', name: 'OSCP', kind: 'machines-ad' },
    { id: 'osep', org: 'OffSec', code: 'PEN-300', name: 'OSEP', kind: 'osep' },
    // CPENT and LPT (Master) share one exam / report structure — LPT (Master) is awarded
    // at a 90%+ CPENT score, so a single template covers both. The exam range is split
    // into five themed zones, and the report follows those rather than a flat host list.
    { id: 'cpent', org: 'EC-Council', code: 'CPENT / LPT (Master)', name: 'CPENT', kind: 'cpent' },
    { id: 'vhl', org: 'Virtual Hacking Labs', code: 'VHL', name: 'VHL', kind: 'vhl' }
  ];
  function byId(id) { return TEMPLATES.filter(function (t) { return t.id === id; })[0] || TEMPLATES[0]; }

  // The five CPENT exam ranges, in the order EC-Council presents them.
  const CPENT_RANGES = [
    { key: 'ad',       title: 'Active Directory Range',
      desc: 'AD 架構列舉、提權與橫向移動（Kerberoasting、Silver / Golden Ticket）。' },
    { key: 'binaries', title: 'Binaries Range',
      desc: '32 / 64-bit 二進位逆向、漏洞利用開發與記憶體分析。' },
    { key: 'iot',      title: 'IoT Range',
      desc: '找出 IoT 裝置、取得存取、抽取並逆向韌體，分析通訊協定。' },
    { key: 'web',      title: 'Web Range',
      desc: 'OWASP Top 10、WAF 繞過與 API 安全。' },
    { key: 'ctf',      title: 'Capture the Flag (CTF) Range',
      desc: 'Linux 基礎架構、進階列舉與提權。' }
  ];

  // fields shown per kind
  function fieldsFor(kind) {
    if (kind === 'machines-ad') return ['targets', 'adset'];
    if (kind === 'machines') return ['targets'];
    if (kind === 'osep') return ['external', 'adset'];
    if (kind === 'cpent') return ['adset', 'binaries', 'iot', 'webapps', 'ctf'];
    if (kind === 'vhl') return ['vhlnets', 'vhlhosts'];
    if (kind === 'web') return ['webapps'];
    if (kind === 'exploit') return ['binaries'];
    if (kind === 'wifi') return ['wifi'];
    if (kind === 'defensive') return ['items'];
    return ['targets'];
  }

  // ---------------- markdown building blocks ----------------
  function logoBlock(t) {
    return [
      '> [!NOTE]',
      '> **' + t.org + ' — ' + t.code + '**　官方 Logo 請貼在此（拖曳或貼上圖片）。基於著作權，本工具不內建官方標誌。',
      ''
    ];
  }
  function header(t, data) {
    const L = [];
    L.push('# ' + t.name + ' Exam / Lab Report');
    L.push('');
    L.push('**Certification:** ' + t.org + ' — ' + t.code + '  ');
    L.push('**Candidate ID:** ' + (data.candidate || 'ID-XXXXX') + '  ');
    if (data.name) L.push('**Candidate Name:** ' + data.name + '  ');
    L.push('**Date:** ' + (data.date || today()) + '  ');
    L.push('');
    logoBlock(t).forEach(function (x) { L.push(x); });
    return L;
  }
  function boilerplate() {
    return [
      '## Introduction',
      'This report documents the full penetration testing effort conducted in order to complete the examination. It is intended to be graded on correctness and completeness, demonstrating a sound understanding of penetration testing methodology together with the technical ability required to achieve the certification objectives.',
      '',
      '## Objective',
      'The objective of this assessment is to perform a structured, methodical security assessment against the in-scope targets, obtain the required proof of compromise, and thoroughly document every step so that the entire process is fully reproducible.',
      '',
      '## Requirements',
      'The candidate is required to complete this report and to include the following:',
      '',
      '- A high-level summary of the identified vulnerabilities and results.',
      '- A methodical, reproducible walkthrough with detailed steps for every objective.',
      '- Screenshots, commands, and sample code supporting each finding.',
      '- The contents of every required proof / flag obtained.',
      ''
    ];
  }
  function methodology() {
    return [
      '# Methodologies',
      'A widely-adopted penetration testing methodology was followed, consisting of the phases below.',
      '',
      '## Information Gathering',
      'Active and passive reconnaissance was performed against the in-scope environment to enumerate assets and exposed services.',
      '',
      '## Enumeration',
      'Each identified service was probed to determine version information and the potential attack surface.',
      '',
      '## Exploitation',
      'Identified vulnerabilities were exploited to gain access to the target systems.',
      '',
      '## Post-Exploitation',
      'Access was leveraged to collect proof, escalate privileges, and, where relevant, move laterally.',
      ''
    ];
  }

  function machineSection(label, ip, i) {
    return [
      '## ' + label + ' ' + (i + 1) + ' — ' + ip,
      '',
      '### Service Enumeration',
      '',
      '| Host | Ports Open |',
      '| --- | --- |',
      '| ' + ip + ' | **TCP:** <br> **UDP:** |',
      '',
      '```bash=',
      'nmap -sC -sV -p- -oN nmap_' + ip + '.txt ' + ip,
      '```',
      '',
      '### Initial Access',
      '*(說明取得初始存取的漏洞、指令與截圖。)*',
      '',
      '### local.txt',
      '```',
      '[ 在此貼上 local.txt 內容 ]',
      '```',
      '',
      '### Privilege Escalation',
      '*(說明提權過程與所用漏洞。)*',
      '',
      '### proof.txt',
      '```',
      '[ 在此貼上 proof.txt 內容 ]',
      '```',
      ''
    ];
  }

  function vhlSection(h, i) {
    const ip = h.ip || '';
    const name = h.name || ('Machine ' + (i + 1));
    return [
      '## ' + name + (ip ? ' — ' + ip : ''),
      '',
      '### Service Enumeration',
      '',
      '| Host | Ports Open |',
      '| --- | --- |',
      '| ' + ip + ' | **TCP:** <br> **UDP:** |',
      '',
      '```bash=',
      'nmap -sC -sV -p- -oN nmap_' + (ip || 'host') + '.txt ' + ip,
      '```',
      '',
      '### Initial Access',
      '*(說明取得初始存取的漏洞、指令與截圖。)*',
      '',
      '### local.txt',
      '```',
      '[ 在此貼上 local.txt 內容 ]',
      '```',
      '',
      '### Privilege Escalation',
      '*(說明提權過程與所用漏洞。)*',
      '',
      '### proof.txt',
      '```',
      '[ 在此貼上 proof.txt 內容 ]',
      '```',
      ''
    ];
  }

  // VHL：把機器歸到它填的 Level 底下（不分大小寫）。表單裡定義過的 Level 依
  // 定義順序排前面；機器上寫了但沒定義的 Level 接在後面；沒填的歸「未分類」。
  function groupVhl(nets, hosts) {
    const groups = [], byKey = {};
    function get(name, range) {
      const key = String(name || '').trim().toLowerCase() || '__none__';
      if (!byKey[key]) {
        byKey[key] = { name: String(name || '').trim() || '未分類', range: range || '', hosts: [] };
        groups.push(byKey[key]);
      }
      return byKey[key];
    }
    nets.forEach(function (n) { get(n.name, n.range); });
    hosts.forEach(function (h) { get(h.net).hosts.push(h); });
    // 沒填 Level 的機器放最後
    const none = byKey.__none__;
    if (none) { groups.splice(groups.indexOf(none), 1); groups.push(none); }
    return groups;
  }

  function webSection(app, i) {
    const name = app.name || ('Application ' + (i + 1));
    return [
      '## ' + name + (app.url ? ' — ' + app.url : ''),
      '',
      '### Overview',
      '*(描述應用程式、技術棧與測試範圍。)*',
      '',
      '### Vulnerability',
      '*(描述所發現的弱點類型，如 SQLi、SSTI、Deserialization、Auth Bypass 等。)*',
      '',
      '### Steps to Reproduce',
      '```http',
      'GET / HTTP/1.1',
      'Host: ' + (app.url || 'target') ,
      '```',
      '',
      '### Proof of Concept',
      '*(貼上 PoC 程式碼、payload 與截圖。)*',
      '',
      '### Proof / Flag',
      '```',
      '[ 在此貼上 proof / flag 內容 ]',
      '```',
      ''
    ];
  }

  function exploitSection(item, i) {
    const name = item.name || ('Target ' + (i + 1));
    return [
      '## ' + name + (item.ver ? ' (' + item.ver + ')' : ''),
      '',
      '### Vulnerability Analysis',
      '*(描述目標軟體、漏洞成因與觸發條件。)*',
      '',
      '### Crash / Root Cause',
      '```',
      '[ 崩潰資訊 / 暫存器狀態 ]',
      '```',
      '',
      '### Exploit Development',
      '*(說明控制流程、bad chars、ROP / shellcode 等。)*',
      '',
      '```python=',
      '#!/usr/bin/env python3',
      '# Proof-of-concept exploit for ' + name,
      '```',
      '',
      '### Proof',
      '```',
      '[ 在此貼上執行結果 / flag ]',
      '```',
      ''
    ];
  }

  function wifiSection(ssid, i) {
    return [
      '## Network ' + (i + 1) + ' — ' + (ssid || 'SSID'),
      '',
      '### Reconnaissance',
      '```bash=',
      'airodump-ng wlan0mon',
      '```',
      '',
      '### Attack',
      '*(描述所用攻擊：WPA handshake 捕獲、WEP、WPS 等。)*',
      '',
      '### Cracking',
      '```bash=',
      'aircrack-ng -w wordlist.txt capture.cap',
      '```',
      '',
      '### Recovered Key',
      '```',
      '[ 在此貼上金鑰 / flag ]',
      '```',
      ''
    ];
  }

  function defensiveSection(item, i) {
    const name = item || ('Alert ' + (i + 1));
    return [
      '## ' + name,
      '',
      '### Detection',
      '*(描述觸發的告警、資料來源與偵測邏輯。)*',
      '',
      '### Analysis',
      '*(時間軸、受影響資產、攻擊者行為 (TTPs / MITRE ATT&CK)。)*',
      '',
      '### Evidence',
      '```',
      '[ 相關日誌 / 查詢 / 截圖 ]',
      '```',
      '',
      '### Recommendation',
      '*(緩解與後續處置建議。)*',
      ''
    ];
  }

  function iotSection(dev, i) {
    const name = dev.name || ('IoT Device ' + (i + 1));
    const ip = dev.ip || '';
    return [
      '## ' + name + (ip ? ' — ' + ip : ''),
      '',
      '### Device Discovery',
      '*(說明如何在網段中找出此裝置，以及其型號 / 韌體版本。)*',
      '',
      '```bash=',
      'nmap -sV -p- ' + (ip || '[IP]'),
      '```',
      '',
      '### Access',
      '*(取得存取的方式：預設憑證、UART / SPI、開放服務等。)*',
      '',
      '### Firmware Extraction',
      '```bash=',
      'binwalk -e firmware.bin',
      '```',
      '',
      '### Firmware Analysis / Reverse Engineering',
      '*(檔案系統內容、寫死的憑證、金鑰、可利用的二進位。)*',
      '',
      '### Protocol Analysis',
      '*(裝置通訊協定的側錄與分析。)*',
      '',
      '### Proof / Flag',
      '```',
      '[ 在此貼上 proof / flag 內容 ]',
      '```',
      ''
    ];
  }

  function ctfSection(h, i) {
    const name = h.name || ('CTF Host ' + (i + 1));
    const ip = h.ip || '';
    return [
      '## ' + name + (ip ? ' — ' + ip : ''),
      '',
      '### Enumeration',
      '',
      '| Host | Ports Open |',
      '| --- | --- |',
      '| ' + (ip || '[IP]') + ' | **TCP:** <br> **UDP:** |',
      '',
      '```bash=',
      'nmap -sC -sV -p- -oN nmap_' + (ip || 'host') + '.txt ' + (ip || '[IP]'),
      '```',
      '',
      '### Exploitation',
      '*(說明取得初始存取的漏洞、指令與截圖。)*',
      '',
      '### Privilege Escalation',
      '*(說明提權過程與所用漏洞。)*',
      '',
      '### Flag',
      '```',
      '[ 在此貼上 flag 內容 ]',
      '```',
      ''
    ];
  }

  function adSet(data, heading) {
    const L = [];
    const domain = (data.ad && data.ad.domain) || 'corp.local';
    const hosts = (data.ad && data.ad.hosts || []).filter(function (h) { return (h.ip && h.ip.trim()) || (h.name && h.name.trim()); });
    L.push(heading || '# Active Directory Set');
    L.push('');
    L.push('**Domain:** `' + domain + '`');
    L.push('');
    L.push('## Overview');
    L.push('*(概述 AD 攻擊路徑：初始立足點 → 憑證收集 → 橫向移動 → 網域管理員。)*');
    L.push('');
    L.push('### Host Enumeration');
    L.push('| Hostname | IP | Ports Open |');
    L.push('| --- | --- | --- |');
    if (hosts.length) hosts.forEach(function (h) { L.push('| ' + (h.name || '') + ' | ' + (h.ip || '') + ' | **TCP:** |'); });
    else L.push('| *(尚未提供)* |  |  |');
    L.push('');
    hosts.forEach(function (h, i) {
      L.push('## AD Host ' + (i + 1) + ' — ' + (h.name || 'HOST') + ' (' + (h.ip || '') + ')');
      L.push('');
      L.push('### Enumeration');
      L.push('```bash=');
      L.push('nmap -sC -sV -oN nmap_' + (h.ip || 'host') + '.txt ' + (h.ip || ''));
      L.push('```');
      L.push('');
      L.push('### Exploitation / Access');
      L.push('*(說明取得此主機存取的方式。)*');
      L.push('');
      L.push('### Credentials Collected');
      L.push('*(此主機收集到的憑證 / 雜湊 / 票證，用於後續橫向移動。)*');
      L.push('');
      L.push('### Proof');
      L.push('```');
      L.push('[ 在此貼上 proof / flag 內容 ]');
      L.push('```');
      L.push('');
    });
    L.push('## Domain Compromise');
    L.push('*(說明如何取得 Domain Admin 權限，附上網域控制站上的證明截圖。)*');
    L.push('');
    return L;
  }

  // ---------------- top-level generator ----------------
  function generate(templateId, data) {
    const t = byId(templateId);
    let L = [];
    L = L.concat(header(t, data));
    L = L.concat(boilerplate());

    // high-level summary + scope
    L.push('# High-Level Summary');
    L.push('');
    L.push('I was tasked with performing a security assessment as part of the ' + t.org + ' ' + t.code + ' (' + t.name + ') examination. The scope and results are summarised below.');
    L.push('');

    const kind = t.kind;
    const targets = (data.targets || []).filter(function (x) { return x && x.trim(); });
    const webapps = (data.webapps || []).filter(function (a) { return (a.name && a.name.trim()) || (a.url && a.url.trim()); });
    const binaries = (data.binaries || []).filter(function (a) { return (a.name && a.name.trim()); });
    const wifi = (data.wifi || []).filter(function (x) { return x && x.trim(); });
    const items = (data.items || []).filter(function (x) { return x && x.trim(); });
    const vhlhosts = (data.vhlhosts || []).filter(function (h) { return (h.ip && h.ip.trim()) || (h.name && h.name.trim()); });
    const vhlnets = (data.vhlnets || []).filter(function (n) { return n.name && n.name.trim(); });
    const external = (data.external || []).filter(function (x) { return x && x.trim(); });
    const adHostsAll = (data.ad && data.ad.hosts || []).filter(function (h) { return (h.ip && h.ip.trim()) || (h.name && h.name.trim()); });
    const iot = (data.iot || []).filter(function (d) { return (d.name && d.name.trim()) || (d.ip && d.ip.trim()); });
    const ctf = (data.ctf || []).filter(function (h) { return (h.name && h.name.trim()) || (h.ip && h.ip.trim()); });

    L.push(kind === 'vhl' ? '## Machine Summary' : '## Scope');
    if (kind === 'cpent') {
      // One row per exam range, so the grader sees the whole range at a glance.
      const counts = { ad: adHostsAll.length, binaries: binaries.length, iot: iot.length, web: webapps.length, ctf: ctf.length };
      L.push('');
      L.push('本次考試涵蓋 CPENT 實作靶場的五個 Range：');
      L.push('');
      L.push('| # | Range | 範圍 | 目標數 |');
      L.push('| --- | --- | --- | --- |');
      CPENT_RANGES.forEach(function (r, i) {
        L.push('| ' + (i + 1) + ' | **' + r.title + '** | ' + r.desc + ' | ' + (counts[r.key] || 0) + ' |');
      });
      L.push('');
      L.push('**AD Domain:** `' + ((data.ad && data.ad.domain) || 'corp.local') + '`');
      L.push('');
    }
    else if (kind === 'osep') {
      L.push('');
      L.push('**External Network — 對外主機:**');
      if (external.length) external.forEach(function (ip) { L.push('- `' + ip.trim() + '`'); });
      else L.push('- *(尚未提供)*');
      L.push('');
      L.push('**Internal Network — Domain:** `' + ((data.ad && data.ad.domain) || 'corp.local') + '`');
      if (adHostsAll.length) adHostsAll.forEach(function (h) { L.push('- ' + (h.name || 'HOST') + ' — `' + (h.ip || '') + '`'); });
      else L.push('- *(尚未提供)*');
    }
    else if (kind === 'vhl') {
      L.push('');
      L.push('**Levels:**');
      if (vhlnets.length) vhlnets.forEach(function (n) { L.push('- **' + n.name + '**' + (n.range ? ' — `' + n.range + '`' : '')); });
      else L.push('- *(尚未提供)*');
      L.push('');
      L.push('| Level | IP | Hostname | local.txt | proof.txt |');
      L.push('| --- | --- | --- | --- | --- |');
      if (vhlhosts.length) vhlhosts.forEach(function (h) { L.push('| ' + (h.net || '—') + ' | `' + (h.ip || '') + '` | ' + (h.name || '') + ' | ☐ | ☐ |'); });
      else L.push('| *(尚未提供)* |  |  |  |  |');
    }
    else if (kind === 'web') { if (webapps.length) webapps.forEach(function (a) { L.push('- **' + (a.name || 'App') + '**' + (a.url ? ' — `' + a.url + '`' : '')); }); else L.push('- *(尚未提供)*'); }
    else if (kind === 'exploit') { if (binaries.length) binaries.forEach(function (a) { L.push('- **' + a.name + '**' + (a.ver ? ' (' + a.ver + ')' : '')); }); else L.push('- *(尚未提供)*'); }
    else if (kind === 'wifi') { if (wifi.length) wifi.forEach(function (s) { L.push('- `' + s + '`'); }); else L.push('- *(尚未提供)*'); }
    else if (kind === 'defensive') { if (items.length) items.forEach(function (s) { L.push('- ' + s); }); else L.push('- *(尚未提供)*'); }
    else { if (targets.length) targets.forEach(function (ip) { L.push('- `' + ip.trim() + '`'); }); else L.push('- *(尚未提供)*'); }
    L.push('');

    if (kind === 'machines-ad') {
      const hosts = (data.ad && data.ad.hosts || []).filter(function (h) { return (h.ip && h.ip.trim()) || (h.name && h.name.trim()); });
      L.push('**AD Domain:** `' + ((data.ad && data.ad.domain) || 'corp.local') + '`');
      L.push('');
      hosts.forEach(function (h) { L.push('- ' + (h.name || 'HOST') + ' — `' + (h.ip || '') + '`'); });
      L.push('');
    }

    L.push('## Recommendations');
    L.push('I recommend remediating the vulnerabilities identified during this assessment to prevent exploitation by a malicious actor. A follow-up review should confirm the issues are resolved and appropriate controls are in place.');
    L.push('');

    L = L.concat(methodology());

    // findings
    if (kind === 'cpent') {
      // One top-level section per exam range, in EC-Council's order.
      const empty = function (msg) { L.push('*(' + msg + ')*'); L.push(''); };
      const rangeHead = function (i) {
        const r = CPENT_RANGES[i];
        L.push('# Range ' + (i + 1) + ' — ' + r.title);
        L.push('');
        L.push(r.desc);
        L.push('');
      };

      rangeHead(0);
      L = L.concat(adSet(data, '## Active Directory Set'));

      rangeHead(1);
      if (!binaries.length) empty('尚未提供 Binaries 目標');
      binaries.forEach(function (a, i) { L = L.concat(exploitSection(a, i)); });

      rangeHead(2);
      if (!iot.length) empty('尚未提供 IoT 裝置');
      iot.forEach(function (d, i) { L = L.concat(iotSection(d, i)); });

      rangeHead(3);
      if (!webapps.length) empty('尚未提供 Web 應用');
      webapps.forEach(function (a, i) { L = L.concat(webSection(a, i)); });

      rangeHead(4);
      if (!ctf.length) empty('尚未提供 CTF 主機');
      ctf.forEach(function (h, i) { L = L.concat(ctfSection(h, i)); });
    } else if (kind === 'web') {
      L.push('# Findings');
      L.push('');
      if (!webapps.length) { L.push('*(尚未提供目標)*'); L.push(''); }
      webapps.forEach(function (a, i) { L = L.concat(webSection(a, i)); });
    } else if (kind === 'exploit') {
      L.push('# Findings');
      L.push('');
      if (!binaries.length) { L.push('*(尚未提供目標)*'); L.push(''); }
      binaries.forEach(function (a, i) { L = L.concat(exploitSection(a, i)); });
    } else if (kind === 'wifi') {
      L.push('# Findings');
      L.push('');
      if (!wifi.length) { L.push('*(尚未提供網路)*'); L.push(''); }
      wifi.forEach(function (s, i) { L = L.concat(wifiSection(s, i)); });
    } else if (kind === 'defensive') {
      L.push('# Findings');
      L.push('');
      if (!items.length) { L.push('*(尚未提供項目)*'); L.push(''); }
      items.forEach(function (s, i) { L = L.concat(defensiveSection(s, i)); });
    } else if (kind === 'osep') {
      L.push('# External Network（對外網路）');
      L.push('');
      L.push('此階段針對對外服務取得初始立足點，並在受限環境下規避防禦以建立通往內網的通道。');
      L.push('');
      if (!external.length) { L.push('*(尚未提供對外主機)*'); L.push(''); }
      external.forEach(function (ip, i) { L = L.concat(machineSection('External Host', ip.trim(), i)); });
      L.push('# Internal Network — Active Directory（內部網路）');
      L.push('');
      L.push('取得內網立足點後，於網域環境中進行列舉、憑證竊取、橫向移動與規避，最終取得網域控制權。');
      L.push('');
      L = L.concat(adSet(data, '## Active Directory Set'));
    } else if (kind === 'vhl') {
      // 機器依 Network 分組：先照表單裡 Network 的順序，沒填 Network 的放最後
      const groups = groupVhl(vhlnets, vhlhosts);
      if (!groups.length) { L.push('# Target Machines'); L.push(''); L.push('*(尚未提供機器)*'); L.push(''); }
      groups.forEach(function (g) {
        L.push('# Level — ' + g.name + (g.range ? ' (`' + g.range + '`)' : ''));
        L.push('');
        if (!g.hosts.length) { L.push('*(此 Level 尚未提供機器)*'); L.push(''); }
        g.hosts.forEach(function (h, i) { L = L.concat(vhlSection(h, i)); });
      });
    } else {
      L.push('# ' + (kind === 'machines-ad' ? 'Independent Challenges' : 'Target Machines'));
      L.push('');
      if (!targets.length) { L.push('*(尚未提供靶機)*'); L.push(''); }
      targets.forEach(function (ip, i) { L = L.concat(machineSection('Target', ip.trim(), i)); });
      if (kind === 'machines-ad') L = L.concat(adSet(data));
    }

    L.push('# Appendix — Proof Summary');
    L.push('*(彙整所有 proof / flag 內容，方便閱卷對照。)*');
    L.push('');

    return { title: t.name + ' Report — ' + (data.candidate || 'ID-XXXXX'), content: L.join('\n') };
  }

  // ---------------- form UI ----------------
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function field(labelText, inputEl) { const f = el('div', 'oscp-field'); f.appendChild(el('label', null, labelText)); f.appendChild(inputEl); return f; }
  function textRow(ph1, ph2, role1, role2) {
    const row = el('div', 'oscp-row');
    const a = el('input'); a.type = 'text'; a.placeholder = ph1; a.dataset.role = role1;
    row.appendChild(a);
    if (ph2 != null) { const b = el('input'); b.type = 'text'; b.placeholder = ph2; b.dataset.role = role2; row.appendChild(b); }
    const rm = el('button', 'oscp-x', '✕'); rm.type = 'button'; rm.addEventListener('click', function () { row.remove(); });
    row.appendChild(rm);
    return row;
  }
  // 三欄的版本（VHL 機器：主機名 / IP / 所屬 Network）
  function textRow3(ph1, ph2, ph3, role1, role2, role3) {
    const row = textRow(ph1, ph2, role1, role2);
    const c = el('input'); c.type = 'text'; c.placeholder = ph3; c.dataset.role = role3;
    row.insertBefore(c, row.lastChild);
    return row;
  }

  function showForm(onCreate) {
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal oscp-form');
    modal.appendChild(el('div', 'modal-title', '證照考試範本模式'));
    modal.appendChild(el('div', 'oscp-hint', '選擇考試 / 實驗室範本並填入範圍資訊，系統會生成含官方風格章節與罐頭訊息的報告骨架。'));

    // template selector
    const sel = el('select', 'oscp-select');
    TEMPLATES.forEach(function (t) {
      const o = document.createElement('option');
      o.value = t.id; o.textContent = t.org + ' — ' + t.code + '（' + t.name + '）';
      sel.appendChild(o);
    });
    modal.appendChild(field('報告範本', sel));

    // basic
    const cand = el('input'); cand.type = 'text'; cand.placeholder = 'ID / OSID / Candidate No.';
    const name = el('input'); name.type = 'text'; name.placeholder = '姓名（選填）';
    const dateInput = el('input'); dateInput.type = 'date'; dateInput.value = today();
    modal.appendChild(field('考生 / 學員編號', cand));
    modal.appendChild(field('姓名（選填）', name));
    modal.appendChild(field('日期', dateInput));

    const logoInput = el('input'); logoInput.type = 'file'; logoInput.accept = 'image/*';
    modal.appendChild(field('封面 Logo（選填，會顯示在 PDF 封面）', logoInput));

    // dynamic fields container
    const dyn = el('div');
    modal.appendChild(dyn);

    function renderFields() {
      dyn.innerHTML = '';
      const t = byId(sel.value);
      const fields = fieldsFor(t.kind);
      fields.forEach(function (f) {
        if (f === 'targets') {
          const list = el('div');
          list.dataset.list = 'targets';
          list.appendChild(textRow('10.10.10.5', null, 'ip'));
          list.appendChild(textRow('10.10.10.6', null, 'ip'));
          list.appendChild(textRow('10.10.10.7', null, 'ip'));
          const add = el('button', 'oscp-add', '＋ 新增靶機 IP'); add.type = 'button';
          add.addEventListener('click', function () { list.appendChild(textRow('10.10.10.x', null, 'ip')); });
          const wrap = el('div'); wrap.appendChild(list); wrap.appendChild(add);
          dyn.appendChild(field('靶機 IP', wrap));
        } else if (f === 'adset') {
          const domain = el('input'); domain.type = 'text'; domain.placeholder = 'corp.local'; domain.dataset.role = 'ad-domain';
          dyn.appendChild(field('AD 網域名稱', domain));
          const list = el('div'); list.dataset.list = 'adhosts';
          list.appendChild(textRow('主機名 (e.g. WEB01)', 'IP', 'host-name', 'host-ip'));
          list.appendChild(textRow('主機名', 'IP', 'host-name', 'host-ip'));
          list.appendChild(textRow('DC01', 'IP', 'host-name', 'host-ip'));
          const add = el('button', 'oscp-add', '＋ 新增 AD 主機'); add.type = 'button';
          add.addEventListener('click', function () { list.appendChild(textRow('主機名', 'IP', 'host-name', 'host-ip')); });
          const wrap = el('div'); wrap.appendChild(list); wrap.appendChild(add);
          dyn.appendChild(field('AD Set 主機（主機名 + IP）', wrap));
        } else if (f === 'external') {
          const list = el('div'); list.dataset.list = 'external';
          list.appendChild(textRow('192.168.x.x', null, 'ext-ip'));
          const add = el('button', 'oscp-add', '＋ 新增對外主機'); add.type = 'button';
          add.addEventListener('click', function () { list.appendChild(textRow('192.168.x.x', null, 'ext-ip')); });
          const wrap = el('div'); wrap.appendChild(list); wrap.appendChild(add);
          dyn.appendChild(field('External Network — 對外主機 IP', wrap));
        } else if (f === 'vhlnets') {
          const list = el('div'); list.dataset.list = 'vhlnets';
          list.appendChild(textRow('Level 名稱（如 Level 1）', '說明（選填）', 'net-name', 'net-range'));
          const add = el('button', 'oscp-add', '＋ 新增 Level'); add.type = 'button';
          add.addEventListener('click', function () { list.appendChild(textRow('Level 名稱', '說明（選填）', 'net-name', 'net-range')); });
          const wrap = el('div'); wrap.appendChild(list); wrap.appendChild(add);
          dyn.appendChild(field('Level（可新增多個；報告會依 Level 分章）', wrap));
        } else if (f === 'vhlhosts') {
          const list = el('div'); list.dataset.list = 'vhlhosts';
          list.appendChild(textRow3('主機名', 'IP', 'Level 名稱', 'vhl-name', 'vhl-ip', 'vhl-net'));
          list.appendChild(textRow3('主機名', 'IP', 'Level 名稱', 'vhl-name', 'vhl-ip', 'vhl-net'));
          const add = el('button', 'oscp-add', '＋ 新增機器'); add.type = 'button';
          add.addEventListener('click', function () { list.appendChild(textRow3('主機名', 'IP', 'Level 名稱', 'vhl-name', 'vhl-ip', 'vhl-net')); });
          const wrap = el('div'); wrap.appendChild(list); wrap.appendChild(add);
          dyn.appendChild(field('實驗室機器（主機名 + IP + 所屬 Level，可逐步新增）', wrap));
        } else if (f === 'webapps') {
          const list = el('div'); list.dataset.list = 'webapps';
          list.appendChild(textRow('應用名稱', 'URL', 'app-name', 'app-url'));
          list.appendChild(textRow('應用名稱', 'URL', 'app-name', 'app-url'));
          const add = el('button', 'oscp-add', '＋ 新增應用程式'); add.type = 'button';
          add.addEventListener('click', function () { list.appendChild(textRow('應用名稱', 'URL', 'app-name', 'app-url')); });
          const wrap = el('div'); wrap.appendChild(list); wrap.appendChild(add);
          dyn.appendChild(field('目標 Web 應用（名稱 + URL）', wrap));
        } else if (f === 'binaries') {
          const list = el('div'); list.dataset.list = 'binaries';
          list.appendChild(textRow('軟體 / 二進位名稱', '版本 / 架構', 'bin-name', 'bin-ver'));
          const add = el('button', 'oscp-add', '＋ 新增目標'); add.type = 'button';
          add.addEventListener('click', function () { list.appendChild(textRow('軟體 / 二進位名稱', '版本 / 架構', 'bin-name', 'bin-ver')); });
          const wrap = el('div'); wrap.appendChild(list); wrap.appendChild(add);
          dyn.appendChild(field('二進位目標（名稱 + 版本 / 架構，如 32-bit、64-bit）', wrap));
        } else if (f === 'iot') {
          const list = el('div'); list.dataset.list = 'iot';
          list.appendChild(textRow('裝置名稱 / 型號', 'IP', 'iot-name', 'iot-ip'));
          const add = el('button', 'oscp-add', '＋ 新增 IoT 裝置'); add.type = 'button';
          add.addEventListener('click', function () { list.appendChild(textRow('裝置名稱 / 型號', 'IP', 'iot-name', 'iot-ip')); });
          const wrap = el('div'); wrap.appendChild(list); wrap.appendChild(add);
          dyn.appendChild(field('IoT 裝置（名稱 + IP）', wrap));
        } else if (f === 'ctf') {
          const list = el('div'); list.dataset.list = 'ctf';
          list.appendChild(textRow('主機名', 'IP', 'ctf-name', 'ctf-ip'));
          list.appendChild(textRow('主機名', 'IP', 'ctf-name', 'ctf-ip'));
          const add = el('button', 'oscp-add', '＋ 新增 CTF 主機'); add.type = 'button';
          add.addEventListener('click', function () { list.appendChild(textRow('主機名', 'IP', 'ctf-name', 'ctf-ip')); });
          const wrap = el('div'); wrap.appendChild(list); wrap.appendChild(add);
          dyn.appendChild(field('CTF 主機（主機名 + IP）', wrap));
        } else if (f === 'wifi') {
          const list = el('div'); list.dataset.list = 'wifi';
          list.appendChild(textRow('SSID', null, 'ssid'));
          list.appendChild(textRow('SSID', null, 'ssid'));
          const add = el('button', 'oscp-add', '＋ 新增網路'); add.type = 'button';
          add.addEventListener('click', function () { list.appendChild(textRow('SSID', null, 'ssid')); });
          const wrap = el('div'); wrap.appendChild(list); wrap.appendChild(add);
          dyn.appendChild(field('目標無線網路 (SSID)', wrap));
        } else if (f === 'items') {
          const list = el('div'); list.dataset.list = 'items';
          list.appendChild(textRow('事件 / 告警名稱', null, 'item'));
          const add = el('button', 'oscp-add', '＋ 新增項目'); add.type = 'button';
          add.addEventListener('click', function () { list.appendChild(textRow('事件 / 告警名稱', null, 'item')); });
          const wrap = el('div'); wrap.appendChild(list); wrap.appendChild(add);
          dyn.appendChild(field('偵測 / 事件項目', wrap));
        }
      });
    }
    sel.addEventListener('change', renderFields);
    renderFields();

    const actions = el('div', 'modal-actions');
    const cancel = el('button', 'btn modal-cancel', '取消'); cancel.type = 'button';
    const submit = el('button', 'btn btn-primary', '產生報告'); submit.type = 'button';
    actions.appendChild(cancel); actions.appendChild(submit);
    modal.appendChild(actions);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    function close() { overlay.remove(); document.removeEventListener('keydown', onKey, true); }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    cancel.addEventListener('click', close);

    submit.addEventListener('click', function () {
      function vals(role) { return Array.prototype.map.call(dyn.querySelectorAll('input[data-role="' + role + '"]'), function (i) { return i.value; }); }
      const data = {
        candidate: cand.value.trim(),
        name: name.value.trim(),
        date: dateInput.value,
        targets: vals('ip'),
        external: vals('ext-ip'),
        wifi: vals('ssid'),
        items: vals('item'),
        webapps: Array.prototype.map.call(dyn.querySelectorAll('[data-list="webapps"] .oscp-row'), function (r) {
          return { name: r.querySelector('[data-role="app-name"]').value.trim(), url: r.querySelector('[data-role="app-url"]').value.trim() };
        }),
        binaries: Array.prototype.map.call(dyn.querySelectorAll('[data-list="binaries"] .oscp-row'), function (r) {
          return { name: r.querySelector('[data-role="bin-name"]').value.trim(), ver: r.querySelector('[data-role="bin-ver"]').value.trim() };
        }),
        vhlhosts: Array.prototype.map.call(dyn.querySelectorAll('[data-list="vhlhosts"] .oscp-row'), function (r) {
          return {
            name: r.querySelector('[data-role="vhl-name"]').value.trim(),
            ip: r.querySelector('[data-role="vhl-ip"]').value.trim(),
            net: (r.querySelector('[data-role="vhl-net"]') || { value: '' }).value.trim()
          };
        }),
        vhlnets: Array.prototype.map.call(dyn.querySelectorAll('[data-list="vhlnets"] .oscp-row'), function (r) {
          return { name: r.querySelector('[data-role="net-name"]').value.trim(), range: r.querySelector('[data-role="net-range"]').value.trim() };
        }),
        iot: Array.prototype.map.call(dyn.querySelectorAll('[data-list="iot"] .oscp-row'), function (r) {
          return { name: r.querySelector('[data-role="iot-name"]').value.trim(), ip: r.querySelector('[data-role="iot-ip"]').value.trim() };
        }),
        ctf: Array.prototype.map.call(dyn.querySelectorAll('[data-list="ctf"] .oscp-row'), function (r) {
          return { name: r.querySelector('[data-role="ctf-name"]').value.trim(), ip: r.querySelector('[data-role="ctf-ip"]').value.trim() };
        }),
        ad: {
          domain: (dyn.querySelector('[data-role="ad-domain"]') || {}).value ? dyn.querySelector('[data-role="ad-domain"]').value.trim() : '',
          hosts: Array.prototype.map.call(dyn.querySelectorAll('[data-list="adhosts"] .oscp-row'), function (r) {
            return { name: r.querySelector('[data-role="host-name"]').value.trim(), ip: r.querySelector('[data-role="host-ip"]').value.trim() };
          })
        }
      };
      const report = generate(sel.value, data);
      const logoFile = logoInput.files && logoInput.files[0];
      function finish(logoId) {
        let content = report.content;
        if (logoId) content = '![__cover_logo__](img:' + logoId + ')\n\n' + content;
        close();
        if (onCreate) onCreate(report.title, content);
      }
      if (logoFile && global.Store && global.Store.putImage) {
        global.Store.putImage(logoFile).then(finish).catch(function () { finish(null); });
      } else {
        finish(null);
      }
    });

    setTimeout(function () { cand.focus(); }, 30);
  }

  global.OSCP = { showForm: showForm, generate: generate, templates: TEMPLATES };
})(window);
