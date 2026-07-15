// ===== 物掌柜 · StuffManage · 主逻辑（纯前端 · 纯个人免费版） =====
// 模块：首页 / 物品 / 资金 / 借贷 / 盘点 / 打码 / 设置
// 说明：无云端、无账号、无私物口令；所有数据存于本机浏览器（IndexedDB）。
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  // ---- 常量 ----
  const CATEGORIES = ['电子', '衣物', '证件', '书籍', '厨具', '家具', '数码', '其他'];
  const DEFAULT_UNITS = ['个', '件', '瓶', '盒', '台', '套', '袋', '支', '条', '双', '本', '张', '箱', '其他'];
  const LOAN_KINDS = ['借入', '借出', '贷款']; // 借入/贷款=负债，借出=债权
  const LIMITS = { items: 500, custom: 50 }; // 免费版宽额度
  const RING_COLORS = ['#4f8cff', '#2dd4a7', '#ffb454', '#ff5d6c', '#a78bfa', '#34d399'];

  // 模块定义（顺序即 Tab 顺序；home/settings 常驻，其余受开关控制）
  const MODULES = [
    { key: 'home', label: '首页', always: true },
    { key: 'items', label: '物品', setting: 'items' },
    { key: 'funds', label: '资金', setting: 'funds' },
    { key: 'loans', label: '借贷', setting: 'loans' },
    { key: 'feature', label: '特色', always: true },
    { key: 'inventory', label: '盘点', setting: 'inventory' },
    { key: 'locate', label: '打码', setting: 'locate' },
    { key: 'guide', label: '使用指南', always: true },
    { key: 'settings', label: '设置', always: true },
  ];

  const state = {
    tab: 'home',
    stockView: null,        // null | 'in' | 'out'
    invMode: '',            // '' 概览 | 'items' 物品盘点 | 'funds' 资金盘点
    editItemId: '',
    editAccId: '',
    accAddOpen: false,
    editLoanId: '',
    loanAddOpen: false,
    loanClosedOpen: false,  // 已结清借贷分组是否展开
    contact: '',
    serviceWx: '',
    barcodePrefix: 'WM',
    modules: { items: true, funds: true, loans: true, inventory: true, locate: true },
    rewardQR: '',
    updateUrl: '',
    lastUpdateId: '',
    lastUpdateContent: '',
    addresses: [],          // 设置页维护的多个地址
    zones: [],              // 设置页维护的多个分区位置
    categories: [],         // 设置页维护的多个物品分类（可自定义持久化）
    activeSnapshot: null,
    locateFilter: { cat: '', addr: '', period: '' },
    backupReady: false,     // 备份数据是否已准备就绪
    lastBackupAt: 0,        // 上次备份时间戳
    pendingBackup: null,    // 待导出的备份数据 { meta, stores }
    editFavorId: '',
    favorView: 'event',
    favorRecipOf: '',
    favorRecipName: '',
    favorAddOpen: false,
    featureTab: '',         // '' 默认概览 | 'favor' 人情往来 | 'pot' 存钱罐
    persons: [],
    items: [], accounts: [], loans: [], snapshots: [], stockLogs: [], accountLogs: [], favors: [],
  };

  // ================= 初始化 =================
  // 读取上次停留的页面（tab + 物品页子视图），刷新后保持当前页而非跳回首页
  function restoreView() {
    try {
      const raw = localStorage.getItem('sm_view');
      if (!raw) return;
      const v = JSON.parse(raw);
      if (v && v.tab && MODULES.some(m => m.key === v.tab)) {
        // 若该模块已被关闭，则回退到首页
        const mod = MODULES.find(m => m.key === v.tab);
        if (mod.always || state.modules[v.tab]) {
          state.tab = v.tab;
          if (v.tab === 'items' && (v.stockView === 'in' || v.stockView === 'out')) state.stockView = v.stockView;
        }
      }
    } catch (_) { /* 忽略损坏数据 */ }
  }

  function saveView() {
    try { localStorage.setItem('sm_view', JSON.stringify({ tab: state.tab, stockView: state.stockView })); }
    catch (_) {}
  }

  async   function init() {
    await DB.open();
    await ensureDefaults();
    restoreView();
    await refresh();
    await migrateLoanLogs();
    await migrateFavorsV2();
    await migrateFavorsV3();
    await migrateFavorsV4();
    render();
    bindEvents();
    // 申请持久存储，减少浏览器自动清除数据的风险
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().then(function(granted) {
        if (!granted) console.log('持久存储未授权，数据可能被浏览器清理');
      });
    }
    // 数据安全提示：关闭页面时弹窗提醒（仅一次）
    var warned = sessionStorage.getItem('sm_close_warn') === '1';
    if (!warned && state.items.length + state.accounts.length > 0) {
      window.addEventListener('beforeunload', function(e) {
        sessionStorage.setItem('sm_close_warn', '1');
      });
    }
  }

  async function ensureDefaults() {
    const defs = {
      modules: state.modules,
      contact: '',
      barcodePrefix: 'WM',
      rewardQR: '',
      updateUrl: '',
      lastUpdateId: '',
      lastUpdateContent: '',
      serviceWx: '',
      addresses: [],
      zones: [],
      categories: CATEGORIES,
    };
    const s = await DB.getAll('settings');
    for (const k in defs) {
      const rec = s.find(x => x.key === k);
      if (!rec) { await DB.put('settings', { key: k, value: defs[k] }); state[k] = defs[k]; }
      else state[k] = rec.value;
    }
    if (!Array.isArray(state.addresses)) state.addresses = [];
    if (!Array.isArray(state.zones)) state.zones = [];
  }

  async function refresh() {
    [state.items, state.accounts, state.loans, state.snapshots, state.stockLogs, state.accountLogs, state.favors, state.feedbacks, state.persons] = await Promise.all([
      DB.getAll('items'), DB.getAll('accounts'), DB.getAll('loans'), DB.getAll('snapshots'), DB.getAll('stockLogs'), DB.getAll('accountLogs'), DB.getAll('favors'), DB.getAll('feedbacks'), DB.getAll('persons'),
    ]);
    // 检查上次备份时间
    try { state.lastBackupAt = JSON.parse(localStorage.getItem('sm_last_backup') || '0'); } catch(e){ state.lastBackupAt = 0; }
  }

  function warnClearCache() {
    // 有数据且超过7天未备份 → 显示提醒
    var hasData = state.items.length + state.accounts.length + state.favors.length + state.loans.length > 0;
    var daysSince = state.lastBackupAt ? Math.floor((Date.now() - state.lastBackupAt)/(86400000)) : 999;
    if (!hasData) return '';
    if (daysSince < 7) return '';
    return '<div class="card" style="background:rgba(255,93,108,.08);border:1px solid rgba(255,93,108,.25);margin-bottom:10px"><div style="display:flex;align-items:center;gap:10px"><span style="font-size:22px">⚠️</span><div style="flex:1;font-size:12px;line-height:1.6;color:#ff8e9e"><b>数据安全提醒</b><br>所有数据存在本机浏览器缓存中，<b>清除浏览器数据会丢失全部资料</b>。请前往「设置 → 一键备份」导出备份。</div><button class="btn sm" data-tab="settings">去备份 ›</button></div></div>';
  }

  // ================= 渲染入口 =================
  function render() {
    renderTabs();
    const view = $('#view');
    try {
      if (state.tab === 'home') view.innerHTML = renderHome();
      else if (state.tab === 'items') {
        if (state.stockView === 'in') view.innerHTML = stockInForm();
        else if (state.stockView === 'out') view.innerHTML = stockOutForm();
        else if (state.editItemId) view.innerHTML = stockInForm(state.editItemId);
        else view.innerHTML = viewItems();
      }
      else if (state.tab === 'funds') view.innerHTML = viewFunds();
      else if (state.tab === 'loans') view.innerHTML = viewLoans();
      else if (state.tab === 'feature') view.innerHTML = viewFeature();
      else if (state.tab === 'favors') view.innerHTML = viewFeature();
      else if (state.tab === 'inventory') view.innerHTML = viewInventory();
      else if (state.tab === 'locate') view.innerHTML = viewLocate();
      else if (state.tab === 'settings') view.innerHTML = viewSettings();
      else if (state.tab === 'guide') view.innerHTML = viewGuide();
      else view.innerHTML = renderHome();
    } catch (err) {
      console.error(err);
      view.innerHTML = '<div class="card empty">页面渲染出错：' + esc(err.message) + '</div>';
    }
    // 渲染所有一维条码，并初始化入库表单的总价显示
    view.querySelectorAll('svg.barcode[data-code]').forEach(renderOneBarcode);
    if ($('#itemForm')) updatePriceTotal();
  }

  function renderTabs() {
    const tabs = $('#tabs');
    const list = MODULES.filter(m => m.always || state.modules[m.key]);
    tabs.innerHTML = list.map(m =>
      `<button data-tab="${m.key}" class="${state.tab === m.key ? 'active' : ''}">${m.label}</button>`
    ).join('');
  }

  // ================= 首页（物品管家 · 信息密集） =================
  function renderHome() {
    const f = computeFinance();
    const inStock = state.items.filter(i => (i.status || '在库') === '在库');
    const base = inStock.length ? inStock : state.items;
    const itemCount = inStock.reduce((s, i) => s + (Number(i.stock) || 0), 0);
    const overdueCount = state.loans.filter(l => l.status !== '已结清' && loanMetrics(l).overdue).length;
    const activeLoans = state.loans.filter(l => l.status !== '已结清');

    // ---- 顶部概览条（紧凑，不空散） ----
    const summaryHTML = `
      <div class="home-summary">
        <div class="hs-item"><span>总资产</span><b>¥${fmtCompact(f.asset)}</b></div>
        <div class="hs-item"><span>净资产</span><b class="pos">¥${fmtCompact(f.net)}</b></div>
        <div class="hs-item"><span>总负债</span><b class="neg">¥${fmtCompact(f.debt)}</b></div>
      </div>`;

    // ---- 趣味入口：一键生成资产卡片（增加首页趣味性） ----
    const funHTML = `
      <div class="home-fun" data-action="open-asset-card">
        <span class="hf-ico">🎴</span>
        <span class="hf-txt">想秀一下？一键生成你的专属「资产卡片」，发给朋友看</span>
        <span class="hf-btn">📊 生成 ›</span>
      </div>`;

    // ---- 第二行：我的物品（按 数量×金额 排序；6 格预设，不足补位，超出横滑） ----
    const SHOW = 6;
    const PH = ['ph1', 'ph2', 'ph3', 'ph4', 'ph5', 'ph6'];
    const ranked = base.slice().sort((a, b) => ((Number(b.value) || 0) * (Number(b.stock) || 0)) - ((Number(a.value) || 0) * (Number(a.stock) || 0)));
    const real = ranked.slice(0, SHOW);
    let itemsBody;
    if (ranked.length > SHOW) {
      itemsBody = `<div class="item-hscroll">${ranked.map(it => itemCardHTML(it)).join('')}</div>`;
    } else {
      let cells = real.map(it => itemCardHTML(it)).join('');
      for (let i = 0; i < SHOW - real.length; i++) {
        cells += `<div class="item-card item-ph-card" data-action="stock-in">
          <img class="ph-img" src="assets/ph/${PH[i % PH.length]}.svg" alt="">
          <span class="ph-label">＋ 添加物品</span>
        </div>`;
      }
      itemsBody = `<div class="item-grid">${cells}</div>`;
    }
    const itemsHTML = `
      <div class="sec">
        <div class="sec-head">
          <span class="sec-title">📦 我的物品</span>
          <span class="sec-meta">${itemCount} 件 · 估值 ¥${fmtCompact(f.itemVal)}</span>
          <button class="sec-more" data-tab="items">全部 ›</button>
        </div>
        ${state.items.length ? itemsBody : `<div class="sec-empty">还没有物品，<button class="link-btn" data-action="stock-in">点此入库第一件</button></div>`}
        ${ranked.length > SHOW ? `<div class="sec-foot"><button class="btn ghost sm" data-tab="items">查看全部 ${state.items.length} 件 ›</button></div>` : ''}
      </div>`;

    // ---- 第三行：资金账户（含占比条，一眼看清结构） ----
    let fundChartHTML = '';
    let maxBal = 0;
    if (state.accounts.length) {
      const total = state.accounts.reduce((s, a) => s + (Number(a.balance) || 0), 0);
      maxBal = Math.max(...state.accounts.map(a => Math.abs(Number(a.balance)) || 0), 1);
      if (total > 0) {
        const segs = state.accounts.map(a => {
          const ic = accountIcon(a.name);
          const pct = (Number(a.balance) || 0) / total * 100;
          return `<span class="fund-seg" style="width:${pct.toFixed(2)}%;background:${ic.color}" title="${esc(a.name)} ¥${fmt(a.balance)}"></span>`;
        }).join('');
        fundChartHTML = `<div class="fund-chart"><div class="fund-chart-bar">${segs}</div></div>`;
      }
    }
    const fundsHTML = `
      <div class="sec">
        <div class="sec-head">
          <span class="sec-title">💰 资金账户</span>
          <span class="sec-meta">${state.accounts.length} 个 · ¥${fmtCompact(f.cash)}</span>
          <button class="sec-more" data-tab="funds">详情 ›</button>
        </div>
        ${fundChartHTML}
        ${state.accounts.length
          ? `<div class="fund-list">${state.accounts.map(a => {
              const ic = accountIcon(a.name);
              const bal = Number(a.balance) || 0;
              const barW = maxBal > 0 ? (Math.abs(bal) / maxBal * 100) : 0;
              return `<div class="fund-row" data-tab="funds">
                <span class="fund-ico" style="color:${ic.color};background:${ic.bg}">${ic.emoji}</span>
                <div class="fund-main"><div class="fund-name">${esc(a.name)}</div><div class="fund-sub">${esc(a.note || '—')}</div></div>
                <div class="row-bar"><div class="row-fill" style="width:${barW.toFixed(1)}%;background:${ic.color}"></div></div>
                <b class="fund-bal">¥${fmtCompact(a.balance)}</b>
              </div>`;
            }).join('')}</div>`
          : `<div class="sec-empty">还没有账户，<button class="link-btn" data-tab="funds">去资金页添加</button></div>`}
      </div>`;

    // ---- 功能全景：产品故事 + 思维导图功能树 ----
    const FUNCS = [
      { tab: 'items',   icon: '📦', name: '物品管理', desc: '每件东西在哪·多少钱·有条码' },
      { tab: 'funds',   icon: '💰', name: '资金管理', desc: '多账户余额·一眼看清分布' },
      { tab: 'loans',   icon: '🤝', name: '借贷管理', desc: '谁欠我·我欠谁·月还款提醒' },
      { tab: 'feature', icon: '🎁', name: '随礼管理', desc: '人情往来·份子钱不糊涂' },
      { tab: 'stock',   icon: '📋', name: '物品盘点', desc: '定期清点·库存对得上' },
      { tab: 'code',    icon: '🔖', name: '生成条码', desc: '打码贴纸·手机一扫即知' },
    ];
    const funcHTML = `
      <div class="sec story-sec">
        <div class="sec-head"><span class="sec-title">📖 产品故事</span></div>
        <div class="story-card">
          <div class="story-text">
            搬家时翻箱倒柜，才惊觉东西多到理不清——哪些该搬、哪些该扔、装箱后又忘了放哪。<br>
            明明记得买过的东西，转头就找不到放哪了。<br>
            谁借了我的钱、收过什么礼、给过什么份子钱……日子久了全凭模糊的记忆。
          </div>
          <div class="story-punch">所以做了物掌柜——帮自己管清家当的小工具。<br>长期免费、纯本地、不联网，自己的数据自己管。</div>
          <div class="story-footer">如果您有其他需求，欢迎找作者定制 💬</div>
        </div>
        <div class="mmap-title">🎯 对症下药 —— 点哪个进哪个</div>
        <div class="mmap-grid">${FUNCS.map(x => `
          <button class="mmap-btn" data-tab="${x.tab}">
            <span class="mmap-ico">${x.icon}</span>
            <span class="mmap-r"><span class="mmap-name">${x.name}</span><span class="mmap-desc">${x.desc}</span></span>
          </button>`).join('')}</div>
      </div>`;

    // ---- 第四行：借贷（含占比条，一眼看清债权债务） ----
    let loanChartHTML = '';
    if (activeLoans.length) {
      const out = activeLoans.filter(l => l.kind === '借出').reduce((s, l) => s + loanMetrics(l).rem, 0);
      const inn = activeLoans.filter(l => l.kind === '借入').reduce((s, l) => s + loanMetrics(l).rem, 0);
      const loan = activeLoans.filter(l => l.kind === '贷款').reduce((s, l) => s + loanMetrics(l).rem, 0);
      const tot = out + inn + loan;
      if (tot > 0) {
        const seg = (val, color) => val > 0 ? `<span class="loan-seg" style="width:${(val / tot * 100).toFixed(2)}%;background:${color}"></span>` : '';
        loanChartHTML = `<div class="loan-chart">
          <div class="loan-chart-bar">${seg(out, 'var(--accent-2)') + seg(inn, 'var(--danger)') + seg(loan, 'var(--warn)')}</div>
          <div class="loan-legend">
            <span><i style="background:var(--accent-2)"></i>借出 ¥${fmtCompact(out)}</span>
            <span><i style="background:var(--danger)"></i>借入 ¥${fmtCompact(inn)}</span>
            ${loan > 0 ? `<span><i style="background:var(--warn)"></i>贷款 ¥${fmtCompact(loan)}</span>` : ''}
          </div>
        </div>`;
      }
    }
    const loansHTML = `
      <div class="sec">
        <div class="sec-head">
          <span class="sec-title">🤝 借贷</span>
          <span class="sec-meta">${activeLoans.length} 笔进行中${overdueCount ? ` · <em class="bad">${overdueCount}笔逾期</em>` : ''}</span>
          <button class="sec-more" data-tab="loans">全部 ›</button>
        </div>
        ${loanChartHTML}
        ${activeLoans.length
          ? (() => {
              const maxRem = Math.max(...activeLoans.map(l => loanMetrics(l).rem), 1);
              const kindColor = k => k === '借出' ? 'var(--accent-2)' : k === '借入' ? 'var(--danger)' : 'var(--warn)';
              return `<div class="kv-list">${activeLoans.map(l => {
                const mm = loanMetrics(l);
                const barW = maxRem > 0 ? (mm.rem / maxRem * 100) : 0;
                return `<div class="kv" data-tab="loans">
                  <span>${esc(l.name)} · ${l.kind}${mm.overdue ? ' <em class="bad">逾期</em>' : ''}</span>
                  <div class="row-bar"><div class="row-fill" style="width:${barW.toFixed(1)}%;background:${kindColor(l.kind)}"></div></div>
                  <b>¥${fmtCompact(mm.rem)}</b>
                </div>`;
              }).join('')}</div>`})()
          : `<div class="sec-empty">暂无进行中的借贷</div>`}
      </div>`;

    // ---- 末尾：打赏支持 ----
    const rewardHTML = `
      <div class="sec reward-sec">
        <div class="reward-card">
          <div class="reward-title">☕ 支持一下</div>
          <div class="reward-desc">物掌柜长期免费，如果觉得好用，可以请作者喝杯咖啡 ☕</div>
          <div class="reward-qr-box">
            <img class="reward-qr-img" src="assets/reward-qr.jpg" alt="微信收款码">
          </div>
          <div class="reward-contact-wrap">
            <div class="reward-contact">
              <span class="rc-label">微信</span>
              <span class="rc-value">qq382554626</span>
            </div>
          </div>
        </div>
      </div>`;

    return summaryHTML + warnClearCache() + funHTML + funcHTML + itemsHTML + fundsHTML + loansHTML + rewardHTML;
  }

  function itemCardHTML(it) {
    const total = (Number(it.value) || 0) * (Number(it.stock) || 0);
    const thumb = it.photo
      ? `<img class="item-thumb" src="${it.photo}" alt="">`
      : `<div class="item-thumb item-ph">📦</div>`;
    return `<div class="item-card" data-action="open-item" data-id="${it.id}">
      <div class="item-top">
        ${thumb}
        <div class="item-head">
          <div class="item-name">${esc(it.name)}</div>
          <span class="item-cat">${esc(it.category || '其他')}</span>
        </div>
      </div>
      <div class="item-loc">📍 ${esc((it.address || '—') + '·' + (it.zone || '—'))}</div>
      <div class="item-foot">
        <b>¥${fmtCompact(total)}</b>
        <span>${it.stock || 0}${esc(it.unit || '件')} · ${esc(it.status || '在库')}</span>
      </div>
    </div>`;
  }

  function homeMetrics() {
    const active = state.loans.filter(l => l.status !== '已结清');
    return {
      debtCount: active.filter(l => l.kind === '借入').length,
      loanCount: active.filter(l => l.kind === '借出').length,
    };
  }

  // ================= 物品页 =================
  function viewItems() {
    if (!state.items.length) {
      return `<div class="card empty"><div class="big">📦</div>还没有物品。<div style="margin-top:10px"><button class="btn" data-action="stock-in">📥 入库第一件</button></div></div>`;
    }
    const rows = state.items.map(it => {
      const total = (Number(it.value) || 0) * (Number(it.stock) || 0);
      const thumbHTML = it.photo ? `<span class="item-thumb"><img src="${it.photo}"></span>` : '';
      return `<tr>
        <td data-label="名称">${thumbHTML}${esc(it.name)}</td>
        <td data-label="分类">${esc(it.category || '—')}</td>
        <td data-label="地址·分区">${esc((it.address || '—') + ' · ' + (it.zone || '—'))}</td>
        <td class="num" data-label="单价">¥${fmt(it.value)}</td>
        <td class="num" data-label="数量">${it.stock || 0} ${esc(it.unit || '件')}</td>
        <td class="num" data-label="总价">¥${fmt(total)}</td>
        <td data-label="状态">${esc(it.status || '在库')}</td>
        <td class="mono" data-label="条码">${esc(it.barcode || '—')}</td>
        <td class="op-col op-detail" data-label="明细"><button class="btn-detail" data-action="open-item" data-id="${it.id}">明细</button></td>
        <td class="op-col op-edit" data-label="修改"><button class="btn-edit" data-action="edit-item" data-id="${it.id}">修改</button></td>
        <td class="op-col op-del" data-label="删除"><button type="button" class="link-del" data-action="del-item" data-id="${it.id}">删除</button></td>
      </tr>`;
    }).join('');

    return `
      <div class="action-row">
        <button class="btn secondary" data-action="stock-in">📥 入库</button>
        <button class="btn secondary" data-action="stock-out">📤 出库</button>
      </div>
      <div class="card">
        <h3>📋 物品明细表</h3>
        <div class="table-scroll">
          <table class="grid items-grid">
            <thead><tr>
              <th>名称</th><th>分类</th><th>地址·分区</th><th class="num">单价</th>
              <th class="num">数量</th><th class="num">总价</th><th>状态</th><th class="mono">条码</th>
              <th class="op-h">明细</th><th class="op-h">修改</th><th class="op-h">删除</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }

  // ---- 入库 / 修改 表单 ----
  function opts(list, current, withNew, allowEmpty) {
    const set = new Set(list || []);
    if (current && !set.has(current)) set.add(current);
    let h = '';
    if (allowEmpty) h += `<option value="">（不选）</option>`;
    h += [...set].map(o => `<option value="${esc(o)}" ${o === current ? 'selected' : ''}>${esc(o)}</option>`).join('');
    if (withNew) h += `<option value="__new__">✏️ 自定义…</option>`;
    return h;
  }

  function stockInForm(editingId) {
    const it = editingId ? state.items.find(x => x.id === editingId) : null;
    const isEdit = !!it;
    const title = isEdit ? '✏️ 修改物品' : '📥 入库';
    const hasPhoto = isEdit && it.photo;

    const photoHTML = `
      <div class="photo-upload">
        <input name="photo" id="photoFile" type="file" accept="image/*" style="display:none">
        <input type="hidden" name="deletePhoto" id="deletePhoto" value="0">
        <div id="photoPreviewWrap" class="photo-preview-wrap" style="display:${hasPhoto ? '' : 'none'}">
          <img id="photoPreview" class="photo-preview-img" src="${hasPhoto ? it.photo : ''}">
          <button type="button" class="link-del photo-del" id="photoDelBtn">✕ 删除照片</button>
        </div>
        <div class="photo-btns">
          <label class="btn photo-cam-btn" id="photoCamBtn">
            📸 拍照
            <input type="file" accept="image/*" capture="environment" data-cam="1">
          </label>
          <label class="btn photo-cam-btn" id="photoPickBtn">
            🖼️ 相册
            <input type="file" accept="image/*">
          </label>
        </div>
        <div class="hint" style="margin-top:4px">可选，拍照或从相册选择（自动压缩到 800px / JPEG）</div>
      </div>`;

    return `<div class="card"><h3>${title}</h3>
      <form id="itemForm" data-edit="${editingId || ''}" onsubmit="return false">
        <label>名称<input name="name" value="${esc(it?.name || '')}" placeholder="如：戴森吹风机"></label>
        ${photoHTML}
        <div class="row">
          <label>单价(¥)<input name="value" type="number" min="0" step="0.01" value="${it ? it.value : ''}" placeholder="0.00"></label>
          <label>数量<input name="stock" type="number" min="0" step="1" value="${it ? it.stock : 1}"></label>
          <label>单位<select name="unit" data-custom="unitNewWrap">${opts(DEFAULT_UNITS, it?.unit, true)}</select></label>
        </div>
        <div id="unitNewWrap" class="row" style="display:none"><label>自定义单位<input name="unitNew" placeholder="如：箱"></label></div>

        <label>分类<select name="category" data-custom="categoryNewWrap">${opts(state.categories, it?.category, true)}</select></label>
        <div id="categoryNewWrap" class="row" style="display:none"><label>自定义分类<input name="categoryNew" placeholder="如：母婴 / 工具"></label></div>

        <div class="row">
          <label>地址<select name="addressSel" data-custom="addressNew">${opts(state.addresses, it?.address, true, true)}</select></label>
          <label>分区位置<select name="zoneSel" data-custom="zoneNew">${opts(state.zones, it?.zone, true, true)}</select></label>
        </div>
        <div id="addressNew" class="row" style="display:none"><label>自定义地址<input name="addressNew" placeholder="如：成都家"></label></div>
        <div id="zoneNew" class="row" style="display:none"><label>自定义分区<input name="zoneNew" placeholder="如：主卧衣柜"></label></div>

        <div class="row" style="align-items:flex-end">
          <label style="flex:2">生成条码（可选）<input type="checkbox" name="genBarcode" style="width:auto;margin-right:6px"></label>
          <label style="flex:1">前缀<input name="prefix" value="${esc(state.barcodePrefix)}" maxlength="6"></label>
          <label style="flex:1">位数<input name="digits" type="number" min="2" max="10" value="6"></label>
        </div>
        <div class="hint">生成后可在「打码」页打印成贴纸，贴在物品上扫码查物。${it && it.barcode ? '当前条码：' + esc(it.barcode) : ''}</div>

        <label>入库原因（可选）<input name="inReason" placeholder="如：自购 / 礼赠 / 报销"></label>

        <label>备注<textarea name="note" placeholder="购买渠道、保修信息等">${esc(it?.note || '')}</textarea></label>

        <div class="kv"><span>总价（单价 × 数量）</span><b id="priceTotal">¥0.00</b></div>

        <div class="modal-actions">
          <button class="btn ghost" data-action="cancel-stock">返回</button>
          <button class="btn" data-action="save-item">${isEdit ? '保存修改' : '确认入库'}</button>
        </div>
      </form></div>`;
  }

  // 出库：搜索自动识别（支持海量物品，避免下拉卡顿）
  function stockOutResultsHTML(q) {
    const items = state.items.filter(i => (Number(i.stock) || 0) > 0).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const list = q
      ? items.filter(i => {
          const s = q.toLowerCase();
          return (i.name || '').toLowerCase().includes(s)
            || (i.code || '').toLowerCase().includes(s)
            || (i.barcode || '').toLowerCase().includes(s);
        })
      : items;
    const top = list.slice(0, 50);
    if (!top.length) return '<div class="note-muted">没有可出库或匹配的物品</div>';
    return top.map(i => `<div class="search-item" data-action="select-stockout-item" data-id="${i.id}">
        <span class="si-name">${esc(i.name)}</span>
        <span class="si-meta">库存 ${i.stock}${esc(i.unit || '件')}${i.address ? ' · ' + esc(i.address) : ''}${i.zone ? ' · ' + esc(i.zone) : ''}</span>
      </div>`).join('');
  }

  function stockOutForm() {
    return `<div class="card"><h3>📤 出库</h3>
      <form id="stockOutForm" onsubmit="return false">
        <label>搜索物品<input id="stockOutSearch" placeholder="输入名称 / 编码 / 条码搜索（支持海量物品）" autocomplete="off"></label>
        <div id="stockOutResults" class="search-results">${stockOutResultsHTML('')}</div>
        <input type="hidden" name="itemId" id="stockOutItemId">
        <div id="stockOutSelected" class="hint" style="display:none"></div>
        <div class="row" id="stockOutDetail" style="display:none">
          <label>数量<input name="qty" type="number" min="1" value="1"></label>
          <label>状态<select name="status"><option>已出库</option><option>已卖出</option><option>已丢弃</option></select></label>
        </div>
        <label id="stockOutReason" style="display:none">原因/去向（可选）<input name="reason" placeholder="如：借出 / 赠予 / 损坏"></label>
        <div class="modal-actions" id="stockOutActions" style="display:none">
          <button class="btn ghost" data-action="cancel-stock">返回</button>
          <button class="btn" data-action="save-stock-out">确认出库</button>
        </div>
      </form></div>`;
  }

  function selectStockOutItem(id) {
    const it = state.items.find(x => x.id === id);
    if (!it) return;
    const hid = $('#stockOutItemId'); if (hid) hid.value = id;
    const sel = $('#stockOutSelected');
    if (sel) { sel.style.display = ''; sel.textContent = `已选：${it.name}（库存 ${it.stock || 0} ${it.unit || '件'}）`; }
    const d = $('#stockOutDetail'); if (d) d.style.display = '';
    const r = $('#stockOutReason'); if (r) r.style.display = '';
    const a = $('#stockOutActions'); if (a) a.style.display = '';
    const box = $('#stockOutResults'); if (box) box.innerHTML = '';
    const s = $('#stockOutSearch'); if (s) s.value = '';
  }

  // ---- 入库 / 出库 保存 ----
  async function saveItem(form) {
    const fd = new FormData(form);
    const editingId = form.dataset.edit || '';
    const name = (fd.get('name') || '').trim();
    if (!name) return toast('请输入物品名称');

    const value = Number(fd.get('value')) || 0;
    const stock = Math.max(0, Number(fd.get('stock')) || 0);

    let unit = fd.get('unit');
    if (unit === '__new__') unit = (fd.get('unitNew') || '').trim() || '个';

    let category = fd.get('category') || '其他';
    if (category === '__new__') { category = (fd.get('categoryNew') || '').trim() || '其他'; addToSettingList('categories', category); }

    const inReason = (fd.get('inReason') || '').trim();

    let address = fd.get('addressSel');
    if (address === '__new__') { address = (fd.get('addressNew') || '').trim(); if (!address) return toast('请输入地址'); addToSettingList('addresses', address); }
    else if (!address) address = '';

    let zone = fd.get('zoneSel');
    if (zone === '__new__') { zone = (fd.get('zoneNew') || '').trim(); if (!zone) return toast('请输入分区位置'); addToSettingList('zones', zone); }
    else if (!zone) zone = '';

    const note = (fd.get('note') || '').trim();
    const gen = fd.get('genBarcode') === 'on';
    const prefix = (fd.get('prefix') || state.barcodePrefix || 'WM').toString().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'WM';
    const digits = Math.min(10, Math.max(2, Number(fd.get('digits')) || 6));

    let photo = '';
    const deletePhoto = fd.get('deletePhoto') === '1';
    if (fd.get('photo') && fd.get('photo').size) {
      photo = await downscaleImage(fd.get('photo'), 800);
    }

    if (editingId) {
      const it = state.items.find(x => x.id === editingId);
      if (!it) return toast('物品不存在');
      const prevStock = it.stock || 0;
      it.name = name; it.value = value; it.stock = stock; it.unit = unit;
      it.category = category; it.address = address; it.zone = zone; it.note = note; it.updatedAt = Date.now();
      if (photo) it.photo = photo;
      else if (deletePhoto) it.photo = '';
      if (gen) { const seq = await nextBarcodeSeq(); it.barcode = prefix + String(seq).padStart(digits, '0'); it.barcodeFmt = prefix + ' +' + digits + '位'; }
      await DB.put('items', it);
      if (stock !== prevStock) {
        const d = stock - prevStock;
        await DB.put('stockLogs', logRec(it, d > 0 ? 'in' : 'out', Math.abs(d), '编辑调整'));
      }
      state.editItemId = '';
      await refresh(); render(); toast('已保存修改');
      return;
    }

    // 新建入库
    const id = 'it_' + Date.now() + Math.random().toString(36).slice(2, 6);
    const code = genCode();
    let barcode = '', barcodeFmt = '';
    if (gen) { const seq = await nextBarcodeSeq(); barcode = prefix + String(seq).padStart(digits, '0'); barcodeFmt = prefix + ' +' + digits + '位'; }
    const it = {
      id, name, photo, value, stock, unit, category, address, zone, code,
      barcode, barcodeFmt, note, status: '在库', createdAt: Date.now(), updatedAt: Date.now(),
    };
    await DB.put('items', it);
    await DB.put('stockLogs', logRec(it, 'in', stock, inReason || '入库'));
    state.stockView = null;
    await refresh(); render(); toast('已入库：' + code);
  }

  async function saveStockOut(form) {
    const id = form.itemId.value;
    const it = state.items.find(x => x.id === id);
    if (!it) return toast('请先搜索并选择物品');
    const qty = Math.max(1, Number(form.qty.value) || 1);
    if (qty > (it.stock || 0)) return toast('出库数量不能超过当前库存');
    const reason = (form.reason.value || '').trim();
    const prev = it.stock;
    it.stock = prev - qty;
    if (it.stock <= 0) { it.stock = 0; it.status = form.status.value; }
    await DB.put('items', it);
    await DB.put('stockLogs', logRec(it, 'out', qty, reason || '出库'));
    state.stockView = null;
    await refresh(); render(); toast(`已出库 ${qty}${reason ? '：' + reason : ''}`);
  }

  function logRec(it, type, qty, reason) {
    return {
      id: 'sl_' + Date.now() + Math.random().toString(36).slice(2, 5),
      t: Date.now(), itemId: it.id, itemName: it.name, code: it.code,
      qty, type, reason: reason || '', prevStock: null, nowStock: it.stock,
    };
  }

  // 资金增减明细记录：type 见 ACC_LOG_LABELS
  const ACC_LOG_LABELS = {
    init: '开户', edit: '修改余额', in: '存入', out: '取出',
    loan_in: '借入入账', loan_out: '借出出账',
    loan_in_undo: '撤销借入入账', loan_out_undo: '撤销借出出账',
    repay_in: '收款', repay_out: '还款', inventory: '盘点调整', favor: '人情账',
  };
  function accLogRec(a, type, amount, note, loanId) {
    return {
      id: 'al_' + Date.now() + Math.random().toString(36).slice(2, 6),
      t: Date.now(), accountId: a.id, accountName: a.name,
      type, amount, balanceAfter: Number(a.balance) || 0, note: note || '',
      loanId: loanId || '',
    };
  }

  // 兼容旧数据：为没有 loanId 的还款/收款流水按借款名称补打标签，
  // 否则在 loanId 改动前建立的借贷，其明细会只显示标题、看不到历史变动。
  async function migrateLoanLogs() {
    const byName = {};
    state.loans.forEach(l => { const n = (l.name || '').trim(); if (n) (byName[n] = byName[n] || []).push(l); });
    if (!Object.keys(byName).length) return;
    const tagged = ['loan_in', 'loan_out', 'loan_in_undo', 'loan_out_undo', 'repay_in', 'repay_out'];
    let dirty = 0;
    for (const log of state.accountLogs) {
      if (log.loanId) continue;
      if (!tagged.includes(log.type)) continue;
      let hit = null;
      for (const name in byName) {
        if (log.note && log.note.indexOf(name) >= 0) { hit = byName[name][0]; break; }
      }
      if (hit) { log.loanId = hit.id; dirty++; await DB.put('accountLogs', log); }
    }
    if (dirty) await refresh();
  }

  // 旧版人情（6 类 cat 格式）与新人情往来（kind 格式）结构不兼容，按用户要求清除旧数据
  async function migrateFavorsV2() {
    const old = state.favors.filter(f => f.cat && !f.kind);
    if (!old.length) return;
    await Promise.all(old.map(f => DB.del('favors', f.id)));
    await refresh();
    toast('已按新版「人情往来」重置旧的人情数据');
  }  // 旧版人情（6 类 cat 格式）已按用户要求清除
  // dir: 资金方向，>0 进账 <0 出账（涉及金额且关联资金账户才联动「资金」页）
  const FAVOR_KINDS = {
    give: { label: '我随礼', dir: -1, color: 'var(--warn)' },
    get:  { label: '他人随礼', dir: +1, color: 'var(--accent-2)' },
  };

  // 人员解析：按名称查找或新建 persons 记录；返回带 id 的人员对象（同名著同一人）
  async function resolvePerson(name) {
    const nm = (name || '').trim() || '未记名';
    let p = state.persons.find(x => (x.name || '').trim() === nm);
    if (!p) {
      p = { id: 'ps_' + Date.now() + Math.random().toString(36).slice(2, 6), name: nm, relation: '', photo: '' };
      await DB.put('persons', p); state.persons.push(p);
    }
    return p;
  }
  // 返回某笔随礼对应的人员对象（优先 personId，退化用 party 名）
  function personOf(f) {
    if (f && f.personId) { const p = state.persons.find(x => x.id === f.personId); if (p) return p; }
    return null;
  }
  function favorPersonName(f) {
    const p = personOf(f);
    return (p && p.name) || (f && (f.party || '').trim()) || '未记名';
  }
  // 待初次回礼：仅当某笔「他人随礼」是该人员唯一一笔往来记录（首次互动、尚未回礼、未手动清账）
  // 一旦发生第 2 次往来（无论谁先开始、我回礼或对方再随），即不再提示待初次回礼 / 回礼
  function isPendingGet(f) {
    if (!f || f.kind !== 'get' || f.reciprocated) return false;
    const pid = f.personId;
    if (!pid) return false;
    return state.favors.filter(x => x.personId === pid).length === 1;
  }

  // “我”的显示名（账本主体，存于 settings.meName，默认“我”）
  function getMeName() {
    const s = (state.settings || []).find(x => x.key === 'meName');
    return (s && s.value) ? s.value : '我';
  }
  // “我”的总账汇总（所有随礼均涉及我）
  function favorMeSummary() {
    const name = getMeName();
    const gives = state.favors.filter(f => f.kind === 'give');
    const gets = state.favors.filter(f => f.kind === 'get');
    const giveSum = gives.reduce((s, f) => s + (Number(f.amount) || 0), 0);
    const getSum = gets.reduce((s, f) => s + (Number(f.amount) || 0), 0);
    return { name, giveCount: gives.length, getCount: gets.length, giveSum, getSum, diff: giveSum - getSum };
  }

  // 资金联动：主记录 sign=+1 应用 / -1 撤销（涉及金额且关联账户才写资金页）
  async function applyFavorFund(fv, sign) {
    const k = FAVOR_KINDS[fv.kind]; if (!k) return;
    const dir = k.dir, amt = Number(fv.amount) || 0;
    if (!amt || amt <= 0 || !fv.accountId) return;
    const a = state.accounts.find(x => x.id === fv.accountId);
    if (!a) return;
    const delta = dir * amt * sign;
    a.balance = Number(a.balance) + delta;
    await DB.put('accounts', a);
    await DB.put('accountLogs', accLogRec(a, 'favor', delta,
      '随礼·' + k.label + (fv.party ? '(' + fv.party + ')' : '')));
  }

  // 旧版人情记录兼容性迁移：title→event、get 按旧回礼/清账状态标记 reciprocated
  async function migrateFavorsV3() {
    if (!state.favors.length) return;
    let changed = false;
    for (const f of state.favors) {
      if (!f) continue;
      if (f.title !== undefined && f.event === undefined) { f.event = f.title || '未命名事项'; delete f.title; changed = true; }
      if (f.kind === 'get' && f.reciprocated === undefined) {
        const recs = f.reciprocals || [];
        const total = recs.reduce((s, r) => s + (Number(r.amount) || 0), 0);
        f.reciprocated = !!(f.cleared || total > 0);
        changed = true;
      }
      if (f.reciprocated === undefined) f.reciprocated = false;
    }
    if (changed) { await Promise.all(state.favors.map(f => DB.put('favors', f))); await refresh(); }
  }

  // 人员化迁移：为每笔随礼补 personId，并按 party 名建立 persons 记录（含关系/照片占位）
  async function migrateFavorsV4() {
    const byName = {};
    state.persons.forEach(p => { byName[(p.name || '').trim()] = p; });
    const upd = [];
    for (const f of state.favors) {
      if (f.personId) continue;
      const nm = (f.party || '').trim() || '未记名';
      let p = byName[nm];
      if (!p) {
        p = { id: 'ps_' + Date.now() + Math.random().toString(36).slice(2, 6), name: nm, relation: '', photo: '' };
        byName[nm] = p; await DB.put('persons', p); state.persons.push(p);
      }
      f.personId = p.id;
      upd.push(f);
    }
    if (upd.length) { await Promise.all(upd.map(f => DB.put('favors', f))); }
  }


  // ---- 物品明细 ----
  function itemDetail(id) {
    const it = state.items.find(x => x.id === id);
    if (!it) return;
    const total = (Number(it.value) || 0) * (Number(it.stock) || 0);
    const logs = state.stockLogs.filter(l => l.itemId === id).sort((a, b) => b.t - a.t).slice(0, 30);
    const logsHTML = logs.length
      ? logs.map(l => `<div class="kv"><span>${l.type === 'in' ? '📥 入库' : '📤 出库'} · ${new Date(l.t).toLocaleString('zh-CN')}</span><b>${l.type === 'in' ? '+' : '-'}${l.qty}${esc(it.unit || '件')}${l.reason ? ' · ' + esc(l.reason) : ''}</b></div>`).join('')
      : '<div class="note-muted">暂无出入库记录</div>';

    const photoHTML = it.photo ? `<img class="detail-photo" src="${it.photo}">` : '';
    const barcodeHTML = it.barcode
      ? `<div class="detail-barcode">
           <div class="muted">条码：${esc(it.barcode)}（${esc(it.barcodeFmt || '')}）</div>
           <svg class="barcode" data-code="${esc(it.barcode)}"></svg>
           <button class="btn secondary sm mt" data-action="print-barcode" data-code="${esc(it.barcode)}" data-name="${esc(it.name)}">🖨️ 打印条码</button>
         </div>`
      : '';

    const html = `
      <button class="modal-close" data-action="close-modal">×</button>
      <h3>${esc(it.name)}</h3>
      ${photoHTML}
      <div class="kv-list">
        <div class="kv"><span>单价</span><b>¥${fmt(it.value)}</b></div>
        <div class="kv"><span>数量</span><b>${it.stock || 0} ${esc(it.unit || '件')}</b></div>
        <div class="kv"><span>总价（单价×数量）</span><b>¥${fmt(total)}</b></div>
        <div class="kv"><span>状态</span><b>${esc(it.status || '在库')}</b></div>
        <div class="kv"><span>分类</span><b>${esc(it.category || '—')}</b></div>
        <div class="kv"><span>地址</span><b>${esc(it.address || '—')}</b></div>
        <div class="kv"><span>分区位置</span><b>${esc(it.zone || '—')}</b></div>
        <div class="kv"><span>编码</span><b>${esc(it.code)}</b></div>
        <div class="kv"><span>备注</span><b>${esc(it.note || '—')}</b></div>
      </div>
      ${barcodeHTML}
      <div class="group-title">出入库记录</div>
      ${logsHTML}
      <div class="modal-actions">
        <button class="btn ghost" data-action="edit-item" data-id="${it.id}">修改</button>
        <button class="btn" data-action="close-modal">关闭</button>
      </div>`;
    openModal(html, { itemId: id });
    if (it.barcode) renderOneBarcode($('#modalMask .barcode'));
  }

  // ================= 资金页 =================
  function viewFunds() {
    const total = state.accounts.reduce((s, a) => s + (Number(a.balance) || 0), 0);
    const ed = state.editAccId ? state.accounts.find(x => x.id === state.editAccId) : null;
    const rows = state.accounts.map(a => `
      <tr>
        <td data-label="名称">${esc(a.name || '现金')}</td>
        <td class="num" data-label="余额">¥${fmt(a.balance)}</td>
        <td data-label="备注">${esc(a.note || '—')}</td>
        <td class="op-col op-detail" data-label="明细"><button class="btn-detail" data-action="open-acc-detail" data-id="${a.id}">明细</button></td>
        <td class="op-col op-edit" data-label="修改"><button class="btn-edit" data-action="edit-acc" data-id="${a.id}">修改</button></td>
        <td class="op-col op-del" data-label="删除"><button type="button" class="link-del" data-action="del-acc" data-id="${a.id}">删除</button></td>
      </tr>`).join('');

    const formCard = (ed || state.accAddOpen)
      ? `<div class="card">
          <h3>${ed ? '✏️ 修改账户' : '➕ 添加账户'}</h3>
          <form id="accForm" data-edit="${ed ? ed.id : ''}" onsubmit="return false">
            <div class="row">
              <label>名称<input name="name" value="${esc(ed ? ed.name : '')}" placeholder="如：钱包现金 / 支付宝"></label>
              <label>余额(¥)<input name="balance" type="number" step="0.01" value="${ed ? ed.balance : ''}" placeholder="0.00"></label>
            </div>
            <label>备注（可选）<input name="note" value="${esc(ed ? ed.note : '')}" placeholder="如：日常零花"></label>
            <div class="modal-actions">
              ${ed ? '<button class="btn ghost" data-action="cancel-edit-acc">取消</button>' : (state.accAddOpen ? '<button class="btn ghost" data-action="cancel-add-acc">取消</button>' : '')}
              <button class="btn" data-action="save-acc">${ed ? '保存修改' : '保存账户'}</button>
            </div>
          </form>
        </div>`
      : '';

    return `
      <div class="card">
        <div class="summary summary-two-row">
          <div class="box"><div class="k">账户总数</div><div class="v">${state.accounts.length}</div></div>
          <button class="btn" style="flex:0 0 auto;align-self:center" data-action="acc-add">➕ 添加账户</button>
          <div class="box box-full"><div class="k">资金余额合计</div><div class="v">¥${fmt(total)}</div></div>
        </div>
      </div>
      ${formCard}
      <div class="card">
        <div class="table-scroll">
          <table class="grid funds-grid">
            <thead><tr><th>名称</th><th class="num">余额</th><th>备注</th><th class="op-h">明细</th><th class="op-h">修改</th><th class="op-h">删除</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${!state.accounts.length ? '<div class="note-muted" style="padding:10px 4px">还没有账户，点「添加账户」开始记账。</div>' : ''}
      </div>`;
  }

  async function saveAcc(form) {
    const fd = new FormData(form);
    const name = (fd.get('name') || '').trim() || '现金';
    const balance = Number(fd.get('balance')) || 0;
    const note = (fd.get('note') || '').trim();
    const editingId = form.dataset.edit || '';
    if (editingId) {
      const a = state.accounts.find(x => x.id === editingId);
      if (!a) return toast('账户不存在');
      const oldBal = Number(a.balance) || 0;
      a.name = name; a.balance = balance; a.note = note;
      await DB.put('accounts', a);
      if (balance !== oldBal) await DB.put('accountLogs', accLogRec(a, 'edit', balance - oldBal, '修改余额'));
    } else {
      const a = { id: 'acc_' + Date.now() + Math.random().toString(36).slice(2, 6), name, balance, note, createdAt: Date.now() };
      await DB.put('accounts', a);
      if (balance !== 0) await DB.put('accountLogs', accLogRec(a, 'init', balance, '开户/初始余额'));
    }
    state.editAccId = '';
    state.accAddOpen = false;
    await refresh(); render(); toast('已保存');
  }

  // ---- 账户明细：资金增减明细 + 资金变动 ----
  function accountDetail(id) {
    const a = state.accounts.find(x => x.id === id);
    if (!a) return;
    const logs = state.accountLogs.filter(l => l.accountId === id).sort((a, b) => b.t - a.t).slice(0, 60);
    const logHTML = logs.length
      ? logs.map(l => {
          const sign = l.amount > 0 ? '+' : '';
          const color = l.amount > 0 ? 'var(--accent-2)' : 'var(--danger)';
          return `<div class="kv"><span>${ACC_LOG_LABELS[l.type] || l.type} · ${new Date(l.t).toLocaleString('zh-CN')}</span><b style="color:${color}">${sign}¥${fmt(l.amount)}</b></div>
                  <div class="note-muted" style="margin:-2px 0 6px">余额 ¥${fmt(l.balanceAfter)}${l.note ? (' · ' + esc(l.note)) : ''}</div>`;
        }).join('')
      : '<div class="note-muted">暂无资金变动记录</div>';

    closeModal();
    openModal(`
      <button class="modal-close" data-action="close-modal">×</button>
      <h3>${esc(a.name)}</h3>
      <div class="kv-list">
        <div class="kv"><span>当前余额</span><b>¥${fmt(a.balance)}</b></div>
        <div class="kv"><span>备注</span><b>${esc(a.note || '—')}</b></div>
      </div>
      <div class="group-title">资金变动</div>
      <div class="row">
        <select id="accChgType" style="flex:1"><option value="in">存入</option><option value="out">取出</option></select>
        <input id="accChgAmt" type="number" step="0.01" placeholder="金额" style="flex:1">
        <input id="accChgNote" placeholder="备注" style="flex:2">
      </div>
      <button class="btn sm mt" data-action="acc-change" data-id="${a.id}">记录变动</button>
      <div class="group-title" style="margin-top:16px">资金增减明细</div>
      ${logHTML}
      <div class="modal-actions">
        <button class="btn sm secondary" data-action="edit-acc" data-id="${a.id}">修改账户</button>
        <button class="btn ghost" data-action="close-modal">关闭</button>
      </div>
    `);
  }

  async function accChange(id) {
    const a = state.accounts.find(x => x.id === id);
    if (!a) return;
    const type = $('#accChgType').value;
    const amt = Number($('#accChgAmt').value) || 0;
    const note = ($('#accChgNote').value || '').trim();
    if (!(amt > 0)) return toast('请输入有效金额');
    const delta = type === 'in' ? amt : -amt;
    a.balance = Number(a.balance) + delta;
    await DB.put('accounts', a);
    await DB.put('accountLogs', accLogRec(a, type, delta, note || (type === 'in' ? '存入' : '取出')));
    await refresh();
    accountDetail(id);
    toast('已记录');
  }

  // ================= 借贷页 =================
  function loanFormHTML(ed) {
    const name = ed ? ed.name : '';
    const kind = ed ? ed.kind : '借入';
    const accOpts = ['<option value="">不关联</option>'].concat(
      state.accounts.map(a => `<option value="${a.id}" ${ed && ed.accountId === a.id ? 'selected' : ''}>${esc(a.name)}</option>`)
    ).join('');
    const amount = ed ? ed.amount : '';
    const due = ed ? (loanDueDay(ed) || '') : '';
    const party = ed ? ed.party : '';
    const note = ed ? ed.note : '';
    const rate = ed ? ed.rate : '';
    const periods = ed ? ed.periods : '';
    const paidPeriods = ed ? ed.paidPeriods : '';
    const showLoan = kind === '贷款';
    return `<form id="loanForm" data-edit="${ed ? ed.id : ''}" onsubmit="return false">
      <label>名称<input name="name" value="${esc(name)}" placeholder="如：借老王 / 借给小李 / 房贷"></label>
      <div class="row">
        <label>类型<select name="kind">${LOAN_KINDS.map(k => `<option ${k === kind ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
        <label>关联账户（可选）<select name="accountId">${accOpts}</select></label>
      </div>
      <div class="row">
        <label>本金/金额(¥)<input name="amount" type="number" step="0.01" value="${amount}" placeholder="0.00"></label>
        <label>每月还款日(可选)<input name="due" type="number" min="1" max="31" value="${due}" placeholder="1-31"></label>
      </div>
      <div id="loanDetailWrap" ${showLoan ? '' : 'style="display:none"'}>
        <div class="row">
          <label>年利率(%)<input name="rate" type="number" step="0.01" value="${rate}" placeholder="如：4.9"></label>
          <label>分期期数(月)<input name="periods" type="number" min="1" value="${periods}" placeholder="如：12"></label>
          <label>已还期数<input name="paidPeriods" type="number" min="0" value="${paidPeriods}" placeholder="0"></label>
        </div>
        <div class="hint">贷款按等额本息计算每期应还；保存时本金入账关联账户，点「还一期」按每期金额扣款并自动累加已还期数。</div>
      </div>
      <label>对方（可选）<input name="party" value="${esc(party)}" placeholder="如：老王 / 银行"></label>
      <label>备注（可选）<input name="note" value="${esc(note)}" placeholder="如：买房借款"></label>
      <div class="modal-actions">
        ${ed ? '<button class="btn ghost" data-action="cancel-edit-loan">取消</button>' : (state.loanAddOpen ? '<button class="btn ghost" data-action="cancel-add-loan">取消</button>' : '')}
        <button class="btn" data-action="save-loan">${ed ? '保存修改' : '保存'}</button>
      </div>
    </form>`;
  }

  function viewLoans() {
    const ed = state.editLoanId ? state.loans.find(x => x.id === state.editLoanId) : null;
    const sum = { inAmt: 0, outAmt: 0, loanAmt: 0, debt: 0, asset: 0, interest: 0 };
    state.loans.filter(l => l.status !== '已结清').forEach(l => {
      const m = loanMetrics(l);
      if (l.kind === '借入') { sum.inAmt += Number(l.amount) || 0; sum.debt += m.rem; }
      else if (l.kind === '借出') { sum.outAmt += Number(l.amount) || 0; sum.asset += m.rem; }
      else if (l.kind === '贷款') { sum.loanAmt += Number(l.amount) || 0; sum.debt += m.rem; sum.interest += m.totalInterest; }
    });
    const summaryHTML = `
      <div class="summary">
        <div class="box" style="flex:0 0 auto"><div class="k">借贷笔数</div><div class="v">${state.loans.length}</div></div>
        <button class="btn" style="flex:0 0 auto;align-self:center" data-action="loan-add">➕ 添加借贷</button>
        <div style="flex-basis:100%;height:0;margin:0"></div>
        <div class="box"><div class="k">借入合计</div><div class="v">¥${fmt(sum.inAmt)}</div></div>
        <div class="box"><div class="k">借出合计</div><div class="v">¥${fmt(sum.outAmt)}</div></div>
        <div class="box"><div class="k">贷款本金</div><div class="v">¥${fmt(sum.loanAmt)}</div></div>
        <div class="box"><div class="k">总负债</div><div class="v">¥${fmt(sum.debt)}</div></div>
        <div class="box"><div class="k">总债权</div><div class="v">¥${fmt(sum.asset)}</div></div>
        <div class="box"><div class="k">利息总额</div><div class="v">¥${fmt(sum.interest)}</div></div>
      </div>`;
    // 拆分为「进行中」与「已结清（金额0）」两组，已结清默认折叠不占位置
    const isClosed = l => loanMetrics(l).rem <= 0;
    const active = state.loans.filter(l => !isClosed(l));
    const closed = state.loans.filter(l => isClosed(l));

    const activeHTML = active.length
      ? active.map(renderLoanRow).join('')
      : '<div class="note-muted" style="padding:10px 4px">还没有进行中的借贷，点「添加借贷」开始。</div>';

    let closedHTML = '';
    if (closed.length) {
      closedHTML = `
      <div class="collapsed-bar" data-action="loan-toggle-closed">
        <span>📦 已结清 · ${closed.length} 笔</span>
        <span class="chev">${state.loanClosedOpen ? '▲' : '▼'}</span>
      </div>`;
      if (state.loanClosedOpen) {
        closedHTML += `<div class="card">${closed.map(renderLoanRow).join('')}</div>`;
      }
    }

    return `
      <div class="card">
        <h3>🤝 借贷</h3>
        <div class="hint">借入/贷款=你欠（负债），借出=别人欠你（债权）。关联账户自动入账/出账；贷款按等额本息分期。</div>
        ${summaryHTML}
      </div>
      ${(ed || state.loanAddOpen) ? `<div class="card">${loanFormHTML(ed)}</div>` : ''}
      <div class="card">${activeHTML}</div>
      ${closedHTML}`;
  }

  // 单条借贷卡片（进行中与已结清共用）
  function renderLoanRow(l) {
    const m = loanMetrics(l);
    let extra = '';
    if (l.kind === '贷款') {
      extra = `<div class="lmeta">年利率 ${Number(l.rate) || 0}% · ${m.periods} 期 · 每期 ¥${fmt(m.payment)} · 已还 ${m.paidPeriods}/${m.periods} 期 · 剩余本金 ¥${fmt(m.rem)}</div>`;
    }
    const repayBtn = l.kind === '贷款'
      ? `<button class="btn sm secondary" data-action="loan-pay-period" data-id="${l.id}">还一期</button>`
      : `<button class="btn sm secondary" data-action="repay-loan" data-id="${l.id}" data-repay="${l.kind === '借入'}">${l.kind === '借入' ? '还款' : '收款'}</button>`;
    return `<div class="loan-card ${m.overdue ? 'due' : ''}">
      <div class="lh">
        <span class="lname">${esc(l.name)} · ${l.kind}</span>
        <span class="lbal">¥${fmt(m.rem)}</span>
        <span class="loan-ops">
          <button class="btn-detail" data-action="open-loan-detail" data-id="${l.id}">明细</button>
          ${repayBtn}
          <button class="btn sm secondary" data-action="edit-loan" data-id="${l.id}">修改</button>
          <button type="button" class="link-del" data-action="del-loan" data-id="${l.id}">删除</button>
        </span>
      </div>
      <div class="lmeta">${l.party ? ('对方：' + esc(l.party) + ' · ') : ''}${m.dueText || '无还款日'}${l.note ? (' · ' + esc(l.note)) : ''}</div>
      ${extra}
    </div>`;
  }

  function loanDetail(id) {
    const l = state.loans.find(x => x.id === id);
    if (!l) return;
    loanDetailId = id; // 标记当前明细对应的借贷，供还一期后刷新
    const m = loanMetrics(l);
    const info = `
      <div class="kv-list">
        <div class="kv"><span>类型</span><b>${esc(l.kind)}</b></div>
        <div class="kv"><span>本金</span><b>¥${fmt(Number(l.amount) || 0)}</b></div>
        <div class="kv"><span>剩余${l.kind === '贷款' ? '本金' : ''}</span><b style="color:var(--danger)">¥${fmt(m.rem)}</b></div>
        ${l.party ? `<div class="kv"><span>对方</span><b>${esc(l.party)}</b></div>` : ''}
        ${loanDueDay(l) ? `<div class="kv"><span>还款日</span><b>每月${loanDueDay(l)}号</b></div>` : ''}
        ${l.note ? `<div class="kv"><span>备注</span><b>${esc(l.note)}</b></div>` : ''}
        ${l.kind === '贷款' ? `
        <div class="kv"><span>年利率</span><b>${Number(l.rate) || 0}%</b></div>
        <div class="kv"><span>分期</span><b>${m.periods} 期</b></div>
        <div class="kv"><span>每期应还</span><b>¥${fmt(m.payment)}</b></div>
        <div class="kv"><span>已还期数</span><b>${m.paidPeriods}/${m.periods}</b></div>
        <div class="kv"><span>利息总额</span><b>¥${fmt(m.totalInterest)}</b></div>` : ''}
      </div>`;
    const logs = state.accountLogs.filter(x => x.loanId === id).sort((a, b) => b.t - a.t);
    const logHTML = logs.length
      ? logs.map(x => {
          const isIn = x.amount > 0;
          const sign = isIn ? '+' : '';
          const color = isIn ? 'var(--accent-2)' : 'var(--danger)';
          const icon = isIn ? '💰' : '💸';
          const label = ACC_LOG_LABELS[x.type] || x.type;
          return `<div class="kv"><span>${icon} ${label} · ${new Date(x.t).toLocaleString('zh-CN')}</span><b style="color:${color}">${sign}¥${fmt(x.amount)}</b></div>
                  <div class="note-muted" style="margin:-2px 0 6px">账户：${esc(x.accountName || '—')} · 余额 ¥${fmt(x.balanceAfter)}${x.note ? (' · ' + esc(x.note)) : ''}</div>`;
        }).join('')
      : '<div class="note-muted">暂无资金变动记录</div>';

    const repayBtn = l.kind === '贷款'
      ? `<button class="btn sm" data-action="loan-pay-period" data-id="${l.id}">还一期</button>`
      : `<button class="btn sm" data-action="repay-loan" data-id="${l.id}" data-repay="${l.kind === '借入'}">${l.kind === '借入' ? '还款' : '收款'}</button>`;

    openModal(`
      <button class="modal-close" data-action="close-modal">×</button>
      <h3>${esc(l.name)} · ${esc(l.kind)} 明细</h3>
      ${info}
      <div class="group-title">资金变动记录</div>
      ${logHTML}
      <div class="modal-actions">
        ${repayBtn}
        <button class="btn sm secondary" data-action="edit-loan" data-id="${l.id}">修改</button>
        <button class="btn ghost" data-action="close-modal">关闭</button>
      </div>
    `);
  }

  async function saveLoan(form) {
    const fd = new FormData(form);
    const kind = fd.get('kind');
    const amount = Number(fd.get('amount')) || 0;
    const accountId = fd.get('accountId') || '';
    const name = (fd.get('name') || '').trim() || kind;
    const party = (fd.get('party') || '').trim();
    const dueRaw = (fd.get('due') || '').toString().trim();
    let due = '';
    if (dueRaw) { const n = parseInt(dueRaw, 10); if (n >= 1 && n <= 31) due = n; }
    const note = (fd.get('note') || '').trim();
    const rate = kind === '贷款' ? (Number(fd.get('rate')) || 0) : 0;
    const periods = kind === '贷款' ? (Number(fd.get('periods')) || 0) : 0;
    const paidPeriods = kind === '贷款' ? (Number(fd.get('paidPeriods')) || 0) : 0;
    const editingId = form.dataset.edit || '';

    const cashDelta = (kind === '借入' || kind === '贷款') ? amount : -amount;

    if (editingId) {
      const l = state.loans.find(x => x.id === editingId);
      if (!l) return toast('借贷不存在');
      // 撤销旧的账户联动
      const oldAcc = state.accounts.find(a => a.id === l.accountId);
      if (oldAcc) {
        const oldDelta = (l.kind === '借入' || l.kind === '贷款') ? -l.amount : l.amount;
        oldAcc.balance = Number(oldAcc.balance) + oldDelta; await DB.put('accounts', oldAcc);
        await DB.put('accountLogs', accLogRec(oldAcc, l.kind === '借出' ? 'loan_out_undo' : 'loan_in_undo', oldDelta, '撤销原借贷入账', l.id));
      }
      l.name = name; l.kind = kind; l.accountId = accountId; l.amount = amount;
      l.remaining = amount; l.party = party; l.due = due; l.note = note;
      l.rate = rate; l.periods = periods; l.paidPeriods = paidPeriods;
      setLoanStatus(l);
      const na = state.accounts.find(a => a.id === accountId);
      if (na) {
        na.balance = Number(na.balance) + cashDelta; await DB.put('accounts', na);
        await DB.put('accountLogs', accLogRec(na, kind === '借出' ? 'loan_out' : 'loan_in', cashDelta, '借贷入账', l.id));
      }
      await DB.put('loans', l);
      state.editLoanId = '';
      state.loanAddOpen = false;
      await refresh(); render(); toast('已保存');
      return;
    }

    const base = {
      id: 'loan_' + Date.now() + Math.random().toString(36).slice(2, 6),
      name, kind, accountId, amount, remaining: amount, party, due, note,
      rate, periods, paidPeriods, status: '进行中', createdAt: Date.now(),
    };
    setLoanStatus(base);
    const acc = state.accounts.find(a => a.id === accountId);
    if (acc) {
      acc.balance = Number(acc.balance) + cashDelta; await DB.put('accounts', acc);
      await DB.put('accountLogs', accLogRec(acc, kind === '借出' ? 'loan_out' : 'loan_in', cashDelta, '借贷入账', base.id));
    }
    await DB.put('loans', base);
    state.loanAddOpen = false;
    await refresh(); render(); toast(`已保存${kind}：¥${fmt(amount)}`);
    form.reset();
  }

  function setLoanStatus(l) {
    if (l.kind === '贷款') {
      const k = Number(l.paidPeriods) || 0, n = Number(l.periods) || 0;
      l.status = (n > 0 && k >= n) ? '已结清' : '进行中';
    } else {
      const rem = Number(l.remaining != null ? l.remaining : l.amount) || 0;
      l.status = rem <= 0 ? '已结清' : '进行中';
    }
  }

  // 本地日期 YYYY-MM-DD（用本地时区，避免 UTC 跨日误差）
  function ymd(ts) {
    const d = ts ? new Date(ts) : new Date();
    const p = n => (n < 10 ? '0' : '') + n;
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // 还一期：先弹确认框，不直接执行。检测「同一天同一笔借贷重复还」
  async function confirmPayLoanPeriod(id) {
    const l = state.loans.find(x => x.id === id);
    if (!l) return;
    const m = loanMetrics(l);
    if (m.periods <= 0) return toast('请先在修改中设置分期期数');
    if (m.paidPeriods >= m.periods) return toast('已全部还完');

    const today = ymd();
    const sameDay = state.accountLogs.filter(x =>
      x.loanId === id && x.type === 'loan_out' &&
      typeof x.note === 'string' && x.note.indexOf('贷款还第') === 0 &&
      ymd(x.t) === today
    ).length;
    const dup = sameDay >= 1;

    const next = Number(l.paidPeriods || 0) + 1;
    const pay = m.payment || 0;
    const acc = state.accounts.find(a => a.id === l.accountId);
    const remAfter = m.periods - next;

    const warn = dup
      ? `<div class="warn-box">⚠️ 今天已为「${esc(l.name)}」还过 <b>${sameDay}</b> 期，是否重复操作？请确认不是误点。</div>`
      : '';
    const info = `
      <div class="kv-list">
        <div class="kv"><span>借贷</span><b>${esc(l.name)} · ${esc(l.kind)}</b></div>
        <div class="kv"><span>本次归还</span><b style="color:var(--danger)">第 ${next} 期 · ¥${fmt(pay)}</b></div>
        <div class="kv"><span>扣款账户</span><b>${esc(acc ? acc.name : '—')}</b></div>
        <div class="kv"><span>还款后</span><b>已还 ${next}/${m.periods} 期，剩余 ${remAfter} 期</b></div>
      </div>`;

    openModal(`
      <button class="modal-close" data-action="close-modal">×</button>
      <h3>${dup ? '⚠️ 重复操作确认' : '确认还一期'}</h3>
      ${warn}
      ${info}
      <div class="modal-actions">
        <button class="btn ghost" data-action="close-modal">取消</button>
        <button class="btn ${dup ? 'danger' : ''}" data-action="confirm-pay-period" data-id="${id}">${dup ? '仍要还一期' : '确认还款'}</button>
      </div>
    `);
  }

  // 执行「还一期」：扣款、累加期数、提示已还/剩余期数
  async function doPayLoanPeriod(id) {
    const l = state.loans.find(x => x.id === id);
    if (!l) return;
    const m = loanMetrics(l);
    if (m.periods <= 0) return toast('请先在修改中设置分期期数');
    if (m.paidPeriods >= m.periods) return toast('已全部还完');
    const pay = m.payment || 0;
    const acc = state.accounts.find(a => a.id === l.accountId);
    if (acc) {
      acc.balance = Number(acc.balance) - pay;
      await DB.put('accounts', acc);
      await DB.put('accountLogs', accLogRec(acc, 'loan_out', -pay, '贷款还第' + (Number(l.paidPeriods || 0) + 1) + '期', l.id));
    }
    l.paidPeriods = Number(l.paidPeriods || 0) + 1;
    setLoanStatus(l);
    await DB.put('loans', l);
    await refresh(); render();
    const remaining = m.periods - l.paidPeriods;
    toast(`已还第 ${l.paidPeriods}/${m.periods} 期 ¥${fmt(pay)}，剩余 ${remaining} 期`);
    // 若是从明细里点出来的，刷新明细以反映最新期数；否则关掉确认框回到列表
    if (loanDetailId === id) loanDetail(id);
    else closeModal();
  }

  // 还款/收款：弹窗选择账户 + 输入金额（替代原生 prompt，iOS PWA 中 prompt 常失效）
  function repayLoanModal(id, isRepay) {
    const l = state.loans.find(x => x.id === id);
    if (!l) return;
    const m = loanMetrics(l);
    const accOpts = state.accounts.length
      ? state.accounts.map(a => `<option value="${a.id}">${esc(a.name)}（余额 ¥${fmt(a.balance)}）</option>`).join('')
      : '<option value="">（暂无账户，请先去「资金」添加）</option>';
    openModal(`
      <button class="modal-close" data-action="close-modal">×</button>
      <h3>${isRepay ? '💸 还款' : '💰 收款'}</h3>
      <div class="kv-list">
        <div class="kv"><span>借贷</span><b>${esc(l.name)} · ${l.kind}</b></div>
        <div class="kv"><span>剩余</span><b>¥${fmt(m.rem)}</b></div>
      </div>
      <form id="repayForm" onsubmit="return false">
        <label>${isRepay ? '从以下账户还款' : '收款到以下账户'}<select name="accId">${accOpts}</select></label>
        <label>金额(¥)<input name="amt" type="number" step="0.01" value="${m.rem}" placeholder="0.00"></label>
        <label>备注（可选）<input name="note" placeholder="如：本月还款 / 收回借款"></label>
        <div class="modal-actions">
          <button class="btn ghost" data-action="close-modal">取消</button>
          <button class="btn" data-action="confirm-repay" data-id="${id}" data-repay="${isRepay}">确认${isRepay ? '还款' : '收款'}</button>
        </div>
      </form>`);
  }

  async function confirmRepay(id, isRepay) {
    const l = state.loans.find(x => x.id === id);
    if (!l) return;
    const form = $('#repayForm');
    if (!form) return;
    const accId = form.accId.value;
    const amt = Number(form.amt.value) || 0;
    const note = (form.note.value || '').trim();
    if (!(amt > 0)) return toast('请输入有效金额');
    const rem = loanMetrics(l).rem;
    if (amt > rem) return toast('金额不能超过剩余 ¥' + fmt(rem));
    const acc = state.accounts.find(a => a.id === accId);
    if (!acc) return toast('请选择账户');
    const delta = isRepay ? -amt : amt;
    acc.balance = Number(acc.balance) + delta;
    await DB.put('accounts', acc);
    await DB.put('accountLogs', accLogRec(acc, isRepay ? 'repay_out' : 'repay_in', delta, (isRepay ? '还款' : '收款') + ' · ' + (l.name || '') + (note ? ' · ' + note : ''), l.id));
    l.remaining = Math.max(0, rem - amt);
    if (l.remaining <= 0) l.status = '已结清';
    else l.status = '进行中';
    await DB.put('loans', l);
    closeModal();
    await refresh(); render(); toast(isRepay ? `已还款 ¥${fmt(amt)}` : `已收款 ¥${fmt(amt)}`);
  }

  // 还款日统一理解为「每月几号」(1-31)。兼容旧数据：旧版存的是具体日期，
  // 这里一律取其中的「日」；新版直接存数字。无 / 非法返回 0。
  function loanDueDay(l) {
    if (l == null || l.due === '' || l.due == null) return 0;
    const s = String(l.due).trim();
    if (/^\d{1,2}$/.test(s)) {
      const n = parseInt(s, 10);
      return (n >= 1 && n <= 31) ? n : 0;
    }
    const m = s.match(/(\d{1,2})$/); // 旧日期形如 2026-07-15
    if (m) { const n = parseInt(m[1], 10); return (n >= 1 && n <= 31) ? n : 0; }
    return 0;
  }

  function loanMetrics(l) {
    let rem = 0, isDebt = (l.kind !== '借出');
    let dueText = '', overdue = false, days = 0;
    let payment = 0, periods = 0, paidPeriods = 0, totalInterest = 0;
    if (l.kind === '贷款') {
      const P = Number(l.amount) || 0;
      const rate = Number(l.rate) || 0;
      const n = Number(l.periods) || 0;
      const k = Number(l.paidPeriods) || 0;
      const r = rate / 100 / 12; // 月利率
      if (n > 0) {
        if (r > 0) payment = P * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
        else payment = P / n;
        let bal;
        if (k <= 0) bal = P;
        else if (r > 0) bal = P * Math.pow(1 + r, k) - payment * ((Math.pow(1 + r, k) - 1) / r);
        else bal = P - payment * k;
        bal = Math.max(0, bal);
        rem = bal;
        periods = n; paidPeriods = k;
        totalInterest = payment * n - P;
      } else {
        rem = P;
      }
    } else {
      rem = Number(l.remaining != null ? l.remaining : l.amount) || 0;
    }
    const day = loanDueDay(l);
    if (day) {
      const now = new Date(); now.setHours(0, 0, 0, 0);
      const tDay = now.getDate();
      if (tDay > day) {
        overdue = true;
        days = -(tDay - day);
        dueText = `每月${day}号（已逾期${tDay - day}天）`;
      } else if (tDay === day) {
        overdue = false; days = 0;
        dueText = `每月${day}号（今天还款）`;
      } else {
        overdue = false; days = day - tDay;
        dueText = `每月${day}号（剩${day - tDay}天）`;
      }
    }
    return { rem, isDebt, dueText, overdue, days, payment, periods, paidPeriods, totalInterest };
  }

  // ================= 财务计算 =================
  function computeFinance() {
    let cash = 0, itemVal = 0, debt = 0, loanAsset = 0;
    state.accounts.forEach(a => { cash += Number(a.balance) || 0; });
    state.items.forEach(i => {
      if (i.status === '在库') {
        const v = Number(i.value) || 0;
        const q = Number(i.stock) || 0;
        itemVal += v * q;
      }
    });
    state.loans.filter(l => l.status !== '已结清').forEach(l => {
      const amt = loanMetrics(l).rem;
      if (l.kind === '借入' || l.kind === '贷款') debt += amt;
      else if (l.kind === '借出') loanAsset += amt;
    });
    const asset = cash + itemVal + loanAsset;
    const net = asset - debt;
    return { cash, itemVal, debt, loanAsset, asset, net };
  }

  // ================= 盘点页 =================
  function viewInventory() {
    const mode = state.invMode || '';
    const seg = `
      <div class="inv-seg" style="margin-bottom:12px">
        <button class="${mode === 'items' ? 'active' : ''}" data-action="inv-mode" data-mode="items">🧮 物品盘点</button>
        <button class="${mode === 'funds' ? 'active' : ''}" data-action="inv-mode" data-mode="funds">💵 资金盘点</button>
      </div>`;

    const byKind = (k) => state.snapshots.filter(s => (s.kind || 'items') === k).sort((a, b) => b.t - a.t);
    const itemSnaps = byKind('items');
    const fundSnaps = byKind('funds');

    // ===== 默认：显示最近物品 + 资金盘点差异 =====
    if (mode === '') {
      const lastItemSnap = itemSnaps[0];
      let itemDiffHTML = '<div class="note-muted">暂无物品盘点记录</div>';
      if (lastItemSnap) {
        if (lastItemSnap.itemDiffs && lastItemSnap.itemDiffs.length) {
          itemDiffHTML = `<div class="note-muted" style="margin-bottom:6px">📅 ${new Date(lastItemSnap.t).toLocaleString('zh-CN')}</div>`;
          itemDiffHTML += lastItemSnap.itemDiffs.map(d =>
            `<div class="kv"><span>${esc(d.name || d.code)}</span><b class="${d.diff >= 0 ? 'pos' : 'neg'}">${d.diff >= 0 ? '+' : ''}${d.diff} ${esc(d.unit || '件')}</b></div>`
          ).join('');
        } else {
          itemDiffHTML = `<div class="note-muted">📅 ${new Date(lastItemSnap.t).toLocaleString('zh-CN')} · 无差异</div>`;
        }
      }
      const lastFundSnap = fundSnaps[0];
      let fundDiffHTML = '<div class="note-muted">暂无资金盘点记录</div>';
      if (lastFundSnap) {
        if (lastFundSnap.accountDiffs && lastFundSnap.accountDiffs.length) {
          fundDiffHTML = `<div class="note-muted" style="margin-bottom:6px">📅 ${new Date(lastFundSnap.t).toLocaleString('zh-CN')}</div>`;
          fundDiffHTML += lastFundSnap.accountDiffs.map(d =>
            `<div class="kv"><span>${esc(d.name)}</span><b class="${d.diff >= 0 ? 'pos' : 'neg'}">${d.diff >= 0 ? '+' : ''}¥${fmt(d.diff)}</b></div>`
          ).join('');
        } else {
          fundDiffHTML = `<div class="note-muted">📅 ${new Date(lastFundSnap.t).toLocaleString('zh-CN')} · 无差异</div>`;
        }
      }
      return seg + `
        <div class="card">
          <h3>🧮 最近物品盘点差异</h3>
          ${itemDiffHTML}
          ${lastItemSnap ? `<button class="btn sm secondary mt" data-action="view-snapshot" data-id="${lastItemSnap.id}">查看详情 ›</button>` : ''}
        </div>
        <div class="card">
          <h3>💵 最近资金盘点差异</h3>
          ${fundDiffHTML}
          ${lastFundSnap ? `<button class="btn sm secondary mt" data-action="view-snapshot" data-id="${lastFundSnap.id}">查看详情 ›</button>` : ''}
        </div>`;
    }

    const itemHistory = itemSnaps.length
      ? itemSnaps.map(s =>
          `<div class="kv"><span>${new Date(s.t).toLocaleString('zh-CN')} · ${s.itemDiffs ? s.itemDiffs.length : 0} 项物品差异</span><b><button class="btn sm secondary" data-action="view-snapshot" data-id="${s.id}">查看</button></b></div>`
        ).join('')
      : '<div class="note-muted">暂无物品盘点记录</div>';
    const fundHistory = fundSnaps.length
      ? fundSnaps.map(s =>
          `<div class="kv"><span>${new Date(s.t).toLocaleString('zh-CN')} · ${s.accountDiffs ? s.accountDiffs.length : 0} 项资金差异</span><b><button class="btn sm secondary" data-action="view-snapshot" data-id="${s.id}">查看</button></b></div>`
        ).join('')
      : '<div class="note-muted">暂无资金盘点记录</div>';
    const history = mode === 'funds'
      ? `<div class="card"><h3>💵 资金盘点历史</h3>${fundHistory}</div>`
      : `<div class="card"><h3>🧮 物品盘点历史</h3>${itemHistory}</div>`;

    // ===== 物品盘点面板 =====
    if (mode === 'items') {
      if (!state.items.length) {
        return seg + `<div class="card empty"><div class="big">🧮</div>还没有物品，先去「物品」入库。</div>` + history;
      }
      const rows = state.items.map(it => {
        const total = (Number(it.value) || 0) * (Number(it.stock) || 0);
      return `<tr>
        <td data-label="名称">${esc(it.name)}</td>
        <td data-label="地址·分区">${esc((it.address || '—') + ' · ' + (it.zone || '—'))}</td>
        <td class="num" data-label="在库">${it.stock || 0} ${esc(it.unit || '件')}</td>
        <td class="num" data-label="盘点数量"><input class="icount" type="number" min="0" data-id="${it.id}" value="${it.stock || 0}"></td>
        <td class="num" data-label="单价">¥${fmt(it.value)}</td>
        <td class="num" data-label="总价">¥${fmt(total)}</td>
        <td class="op-col" data-label="明细"><button class="btn-detail" data-action="open-item" data-id="${it.id}">明细</button></td>
      </tr>`;
      }).join('');
      return seg + `
        <div class="card">
          <h3>🧮 物品盘点</h3>
          <div class="hint">逐项核对实物数量，在「盘点数量」填入实盘数；与原库存不同的会在记录中标记为差异。核对后点下方按钮记录。</div>
          <div class="table-scroll">
            <table class="grid">
              <thead><tr>
                <th>名称</th><th>地址·分区</th><th class="num">在库</th><th class="num">盘点数量</th>
                <th class="num">单价</th><th class="num">总价</th><th class="op-h">明细</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
          <button class="btn full mt" data-action="commit-inventory-items">📝 记录物品盘点</button>
        </div>` + history;
    }

    // ===== 资金盘点面板 =====
    const accRows = state.accounts.map(a =>
      `<tr>
        <td data-label="账户">${esc(a.name)}</td>
        <td class="num" data-label="账面余额">¥${fmt(a.balance)}</td>
        <td class="num" data-label="盘点余额"><input class="acount" type="number" step="0.01" data-acc="${a.id}" value="${a.balance}"></td>
        <td class="op-col" data-label="明细"><button class="btn-detail" data-action="open-acc-detail" data-id="${a.id}">明细</button></td>
      </tr>`
    ).join('');
    return seg + `
      <div class="card">
        <h3>💵 资金盘点</h3>
        <div class="hint">逐项核对各账户余额，填入实盘余额；与原余额不同的会记录差异并更新账户。</div>
        ${state.accounts.length
          ? `<div class="table-scroll"><table class="grid">
              <thead><tr><th>账户</th><th class="num">账面余额</th><th class="num">盘点余额</th><th class="op-h">明细</th></tr></thead>
              <tbody>${accRows}</tbody></table></div>
             <button class="btn full mt" data-action="commit-inventory-funds">📝 记录资金盘点</button>`
          : '<div class="note-muted">暂无账户，去「资金」添加</div>'}
      </div>` + history;
  }

  // 仅盘点物品
  async function commitInventoryItems() {
    const itemDiffs = [];
    for (const inp of $$('#view input[data-id]')) {
      const id = inp.dataset.id;
      const it = state.items.find(x => x.id === id);
      if (!it) continue;
      const now = Math.max(0, Number(inp.value) || 0);
      const prev = it.stock || 0;
      if (now !== prev) {
        it.stock = now;
        await DB.put('items', it);
        await DB.put('stockLogs', logRec(it, now > prev ? 'in' : 'out', Math.abs(now - prev), '盘点调整'));
        itemDiffs.push({ id, name: it.name, code: it.code, prev, now, diff: now - prev });
      }
    }
    await refresh();
    const snap = buildSnapshot(itemDiffs, [], 'items');
    await DB.put('snapshots', snap);
    await refresh();
    render();
    toast(itemDiffs.length ? `已记录物品盘点（${itemDiffs.length} 项差异）` : '物品盘点无差异，已记录');
  }

  // 仅盘点资金
  async function commitInventoryFunds() {
    const accDiffs = [];
    for (const inp of $$('#view input[data-acc]')) {
      const id = inp.dataset.acc;
      const a = state.accounts.find(x => x.id === id);
      if (!a) continue;
      const now = Number(inp.value) || 0;
      const prev = Number(a.balance) || 0;
      if (now !== prev) {
        a.balance = now;
        await DB.put('accounts', a);
        await DB.put('accountLogs', accLogRec(a, 'inventory', now - prev, '盘点调整'));
        accDiffs.push({ id, name: a.name, prev, now, diff: now - prev });
      }
    }
    await refresh();
    const snap = buildSnapshot([], accDiffs, 'funds');
    await DB.put('snapshots', snap);
    await refresh();
    render();
    toast(accDiffs.length ? `已记录资金盘点（${accDiffs.length} 项差异）` : '资金盘点无差异，已记录');
  }

  function buildSnapshot(itemDiffs, accDiffs, kind) {
    const f = computeFinance();
    const itemStates = state.items.map(i => ({
      id: i.id, name: i.name || i.code, code: i.code, stock: i.stock || 0,
      value: i.value, unit: i.unit, address: i.address, zone: i.zone,
    }));
    const accountStates = state.accounts.map(a => ({ id: a.id, name: a.name, balance: a.balance }));
    const loanState = state.loans.filter(l => l.status !== '已结清').map(l => {
      const m = loanMetrics(l); return { id: l.id, kind: l.kind, rem: m.rem, isDebt: m.isDebt };
    });
    return {
      id: 'sn_' + Date.now(), t: Date.now(),
      kind: kind || (accDiffs && accDiffs.length ? 'funds' : 'items'),
      net: f.net, asset: f.asset, debt: f.debt, cash: f.cash, itemVal: f.itemVal, loanAsset: f.loanAsset,
      itemStates, accountStates, loanState, itemDiffs: itemDiffs || [], accountDiffs: accDiffs || [], diffNotes: {},
      counts: { items: state.items.length, accounts: state.accounts.length },
    };
  }

  function viewSnapshotDetail(id) {
    const s = state.snapshots.find(x => x.id === id);
    if (!s) return;
    state.activeSnapshot = s.id;
    const isFund = (s.kind || 'items') === 'funds';

    const realRows = (s.itemStates || []).map(i =>
      `<div class="kv"><span>${esc(i.name || i.code)}</span><b>实盘 ${i.stock || 0} ${esc(i.unit || '件')} · ¥${fmt((Number(i.value) || 0) * (Number(i.stock) || 0))}</b></div>`
    ).join('') || '<div class="note-muted">无</div>';
    const realAccRows = (s.accountStates || []).map(a =>
      `<div class="kv"><span>${esc(a.name)}</span><b>实盘 ¥${fmt(a.balance)}</b></div>`
    ).join('') || '<div class="note-muted">无</div>';

    const diffRows = (s.itemDiffs && s.itemDiffs.length)
      ? s.itemDiffs.map(d => {
          const key = s.id + ':' + d.id;
          return `<div class="kv"><span>${esc(d.name)}：原 ${d.prev} → 实盘 ${d.now}</span><b style="color:${d.diff > 0 ? 'var(--accent-2)' : 'var(--danger)'}">${d.diff > 0 ? '+' : ''}${d.diff}</b></div>
                  <input class="diffnote" data-key="${key}" value="${esc((s.diffNotes && s.diffNotes[key]) || '')}" placeholder="差异原因（可选）">`;
        }).join('')
      : '<div class="note-muted">本次无物品差异</div>';

    const accDiffRows = (s.accountDiffs && s.accountDiffs.length)
      ? s.accountDiffs.map(d => {
          const key = s.id + ':acc:' + d.id;
          return `<div class="kv"><span>${esc(d.name)}：原 ¥${fmt(d.prev)} → 实盘 ¥${fmt(d.now)}</span><b style="color:${d.diff > 0 ? 'var(--accent-2)' : 'var(--danger)'}">${d.diff > 0 ? '+' : ''}¥${fmt(d.diff)}</b></div>
                  <input class="diffnote" data-key="${key}" value="${esc((s.diffNotes && s.diffNotes[key]) || '')}" placeholder="差异原因（可选）">`;
        }).join('')
      : '<div class="note-muted">本次无资金差异</div>';

    let body;
    if (isFund) {
      body = `
        <div class="chart-title">资金差异表</div>${accDiffRows}
        <div class="chart-title" style="margin-top:12px">资金实盘表</div>${realAccRows}`;
    } else {
      body = `
        <div class="chart-title">物品差异表</div>${diffRows}
        <div class="chart-title" style="margin-top:12px">物品实盘表</div>${realRows}`;
    }

    openModal(`
      <button class="modal-close" data-action="close-modal">×</button>
      <h3>🧾 ${isFund ? '资金盘点明细' : '物品盘点明细'}</h3>
      ${body}
      <div class="modal-actions"><button class="btn" data-action="close-modal">关闭</button></div>
    `, { snapshotId: s.id });
  }

  // ================= 条码 / 打印 =================
  async function nextBarcodeSeq() {
    const s = await DB.getAll('settings');
    const rec = s.find(x => x.key === 'barcodeSeq');
    let seq = (rec && rec.value) || 0;
    seq += 1;
    await DB.put('settings', { key: 'barcodeSeq', value: seq });
    return seq;
  }

  async function genBarcode(id) {
    const it = state.items.find(x => x.id === id);
    if (!it) return;
    const prefix = (state.barcodePrefix || 'WM').toString().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'WM';
    const seq = await nextBarcodeSeq();
    it.barcode = prefix + String(seq).padStart(6, '0');
    it.barcodeFmt = prefix + ' +6位';
    await DB.put('items', it);
    await refresh(); render(); toast('已生成条码：' + it.barcode);
  }

  // ================= 人情账视图 =================
  // 资金账户下拉（批量行 / 弹窗复用）
  function favorAccOpts(selectedId) {
    const arr = ['<option value="">不关联资金</option>'].concat(
      state.accounts.map(a => `<option value="${a.id}" ${selectedId && a.id === selectedId ? 'selected' : ''}>${esc(a.name)}</option>`)
    );
    return arr.join('');
  }

  // 一行：对方 / 金额 / 关联账户（可批量，recipOf 用于回礼关联）
  function favorRowHTML(row, accOpts, single) {
    const party = row ? (row.party || '') : '';
    const amount = row ? (row.amount || '') : '';
    const accountId = row ? (row.accountId || '') : '';
    const recipOf = row ? (row.recipOf || '') : '';
    const delBtn = (!single) ? `<button type="button" class="link-del sm" data-action="favor-del-row">✕</button>` : '';
    return `<div class="favor-row">
      <input name="party" placeholder="对方名称" value="${esc(party)}">
      <input name="amount" type="number" min="0" step="0.01" placeholder="金额" value="${esc(amount)}">
      <select name="accountId">${accOpts}</select>
      <input type="hidden" name="recipOf" value="${esc(recipOf)}">
      ${delBtn}
    </div>`;
  }

  // 添加 / 修改 / 回礼 共用表单（支持事项+日期批量添加多人）
  function favorFormHTML() {
    const editing = state.editFavorId ? state.favors.find(x => x.id === state.editFavorId) : null;
    const recip = (!editing && state.favorRecipOf) ? state.favors.find(x => x.id === state.favorRecipOf) : null;
    const recipName = (!editing && !recip && state.favorRecipName) ? state.favorRecipName : '';
    const single = !!(editing || recip || recipName);
    const kind = editing ? editing.kind : 'give';
    const event = editing ? (editing.event || '') : (recip ? (recip.event || '') : '');
    const date = editing ? (editing.date || '') : (recip ? new Date().toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10));
    const note = editing ? (editing.note || '') : '';
    let party0 = '', amount0 = '', acc0 = '', recipOf0 = recip ? recip.id : '';
    if (editing) { party0 = editing.party || ''; amount0 = editing.amount || ''; acc0 = editing.accountId || ''; recipOf0 = editing.recipOf || ''; }
    else if (recip) { party0 = recip.party || ''; }
    else if (recipName) { party0 = recipName; }
    const rowHTML = favorRowHTML({ party: party0, amount: amount0, accountId: acc0, recipOf: recipOf0 }, favorAccOpts(acc0), single);
    const title = editing ? '✏️ 修改随礼' : (recip ? '🔁 回礼 · 我随礼给「' + (recip.party || '') + '」' : (recipName ? '🔁 回礼 · 我随礼给「' + recipName + '」' : '➕ 添加随礼'));
    const addRowBtn = single ? '' : `<button type="button" class="btn ghost sm mt" data-action="favor-add-row">+ 加一行</button>`;
    return `<div class="card"><h3>${title}</h3>
      <form id="favorForm" data-edit="${editing ? editing.id : ''}" onsubmit="return false">
        <div class="row">
          <label>类型<select name="kind">
            <option value="give" ${kind === 'give' ? 'selected' : ''}>我随礼（日后他人回礼）</option>
            <option value="get" ${kind === 'get' ? 'selected' : ''}>他人随礼（日后我回礼）</option>
          </select></label>
          <label>日期<input name="date" type="date" value="${esc(date)}"></label>
        </div>
        <label>事项<input name="event" value="${esc(event)}" placeholder="如：升学宴 / 婚礼 / 生日 / 乔迁"></label>
        <label>备注（可选）<input name="note" value="${esc(note)}" placeholder="如：同学聚会 / 答谢"></label>
        ${!single ? '<div class="hint">同「事项 + 日期」可批量添加多人：下面每行填一个对方、金额、关联账户，点「+ 加一行」继续。</div>' : ''}
        <div id="favorRows">${rowHTML}</div>
        ${addRowBtn}
        <div class="modal-actions">
          <button class="btn ghost" data-action="favor-add">取消</button>
          <button class="btn" data-action="save-favor">保存</button>
        </div>
      </form></div>`;
  }

  // 单条随礼条目（按事项 / 按人员 视图复用）
  function favorEntryHTML(f) {
    const k = FAVOR_KINDS[f.kind] || { label: f.kind, dir: 0, color: 'var(--muted)' };
    const amt = Number(f.amount) || 0;
    const amtStr = amt > 0
      ? `<b style="color:${k.dir > 0 ? 'var(--accent-2)' : 'var(--danger)'}">${k.dir > 0 ? '+' : '−'}¥${fmt(amt)}</b>`
      : '<span class="muted">无金额</span>';
    const acc = f.accountId ? state.accounts.find(a => a.id === f.accountId) : null;
    const accTag = (amt > 0 && acc) ? `<span class="tag loc">${esc(acc.name)}</span>` : '';
    const noteTag = f.note ? `<span class="tag">${esc(f.note)}</span>` : '';
    const pending = isPendingGet(f);
    const pendBadge = pending ? '<span class="tag warn">待初次回礼</span>' : '';
    const recipBtn = pending ? `<button class="btn sm secondary" data-action="favor-recip" data-person="${esc(f.personId || '')}">回礼</button>` : '';
    return `<div class="recip-row">
      <span><b>${esc(favorPersonName(f))}</b> · <span style="color:${k.color}">${k.label}</span> · ${amtStr}${f.date ? (' · ' + esc(f.date)) : ''} ${accTag}${noteTag}${pendBadge}</span>
      <span class="row-ops">${recipBtn}<button class="btn sm secondary" data-action="edit-favor" data-id="${f.id}">修改</button><button type="button" class="link-del sm" data-action="del-favor" data-id="${f.id}">删除</button></span>
    </div>`;
  }

  // 按事项整体查看
  function favorByEventHTML() {
    if (!state.favors.length) return '<div class="empty"><div class="big">🤝</div>还没有随礼记录</div>';
    const groups = {};
    state.favors.forEach(f => {
      const ev = (f.event || '').trim() || '未命名事项';
      (groups[ev] = groups[ev] || []).push(f);
    });
    const evs = Object.keys(groups).sort((a, b) => {
      const da = groups[a][0].date || '', db = groups[b][0].date || '';
      if (db !== da) return (db || '').localeCompare(da || '');
      return a.localeCompare(b);
    });
    return evs.map(ev => {
      const list = groups[ev].slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.t - a.t);
      const giveSum = list.filter(f => f.kind === 'give').reduce((s, f) => s + (Number(f.amount) || 0), 0);
      const getSum = list.filter(f => f.kind === 'get').reduce((s, f) => s + (Number(f.amount) || 0), 0);
      const dates = uniq(list.map(f => f.date).filter(Boolean)).sort().reverse();
      const datesStr = dates.length ? dates.join('、') : '无日期';
      return `<div class="loan-card">
        <div class="lh"><span class="lname">${esc(ev)}</span><span class="lbal">${list.length} 笔</span></div>
        <div class="lmeta">我随 ¥${fmt(giveSum)} · 收 ¥${fmt(getSum)} · ${esc(datesStr)}</div>
        ${list.map(favorEntryHTML).join('')}
      </div>`;
    }).join('');
  }

  // 按人员查看：首行 人名/随礼笔数/回礼笔数/明细/修改；次行 汇总信息 + 待初次回礼/回礼
  // 列表最前固定放置“我”（账本主体）总账卡
  function favorByPersonHTML() {
    const me = favorMeSummary();
    const meCard = `
      <div class="loan-card person-card me-card">
        <div class="person-row1">
          <span class="person-name"><span class="person-ava">👤</span>${esc(me.name)}</span>
          <span class="person-stat" title="我随出的笔数">随出 <b>${me.giveCount}</b></span>
          <span class="person-stat" title="我收礼的笔数">收礼 <b>${me.getCount}</b></span>
          <span class="loan-ops">
            <button class="btn-detail" data-action="favor-person-detail" data-person="__me__">明细</button>
            <button class="btn sm secondary" data-action="favor-me-edit">修改</button>
          </span>
        </div>
        <div class="person-row2">
          <span class="lmeta">我随出 ¥${fmt(me.giveSum)} · 我收礼 ¥${fmt(me.getSum)} · 净 ${me.diff >= 0 ? '我多付' : '我多收'} ¥${fmt(Math.abs(me.diff))}</span>
        </div>
      </div>`;
    if (!state.favors.length) return meCard + '<div class="empty"><div class="big">🤝</div>还没有往来对象记录</div>';
    const groups = {};
    state.favors.forEach(f => {
      const pid = f.personId || ('__' + (f.party || '').trim());
      (groups[pid] = groups[pid] || []).push(f);
    });
    const pids = Object.keys(groups);
    if (!pids.length) return meCard + '<div class="empty"><div class="big">🤝</div>还没有往来对象记录</div>';
    return meCard + pids.map(pid => {
      const list = groups[pid];
      const p = state.persons.find(x => x.id === pid) || null;
      const name = (p && p.name) || (list[0].party || '').trim() || '未记名';
      const gives = list.filter(f => f.kind === 'give');   // 我随礼给对方
      const gets = list.filter(f => f.kind === 'get');     // 对方随礼给我
      const giveSum = gives.reduce((s, f) => s + (Number(f.amount) || 0), 0);
      const getSum = gets.reduce((s, f) => s + (Number(f.amount) || 0), 0);
      const diff = giveSum - getSum; // 我回礼 − 对方随礼
      const diffStr = (Math.abs(diff) < 0.005) ? '两清'
        : (diff > 0 ? `我多随 ¥${fmt(diff)}` : `对方多随 ¥${fmt(-diff)}`);
      const pend = gets.find(isPendingGet);
      const pending = !!pend;
      const photo = (p && p.photo)
        ? `<img class="person-ava" src="${esc(p.photo)}" alt="">`
        : `<span class="person-ava">${esc((name.slice(0, 1)) || '?')}</span>`;
      const pendBadge = pending ? '<span class="tag warn">待初次回礼</span>' : '';
      const recipAvail = pending || (getSum - giveSum > 0.005); // 对方多随（总额）也开通回礼
      const recipBtn = recipAvail ? `<button class="btn sm secondary" data-action="favor-recip" data-person="${esc(pid)}">回礼</button>` : '';
      const statusStr = pending ? '待初次回礼' : (list.length > 1 ? '有来有往' : '单次往来');
      return `<div class="loan-card person-card">
        <div class="person-row1">
          <span class="person-name">${photo}${esc(name)}</span>
          <span class="person-stat" title="对方随礼给我的笔数">随礼 <b>${gets.length}</b></span>
          <span class="person-stat" title="我回礼给 TA 的笔数">回礼 <b>${gives.length}</b></span>
          <span class="loan-ops">
            <button class="btn-detail" data-action="favor-person-detail" data-person="${esc(pid)}">明细</button>
            <button class="btn sm secondary" data-action="favor-person-edit" data-person="${esc(pid)}">修改</button>
          </span>
        </div>
        <div class="person-row2">
          <span class="lmeta">对方随礼 ¥${fmt(getSum)} · 我回礼 ¥${fmt(giveSum)} · 合计 ¥${fmt(diff)}（${diffStr}）· ${statusStr}</span>
          ${pendBadge}${recipBtn}
        </div>
      </div>`;
    }).join('');
  }

  // 某人员往来明细（仿物品明细：头像/关系 + 汇总 + 往来记录列表 + 修改/删除 + 回礼）
  // pid 为 '__me__' 时展示“我”参与的全部往来（总账）
  function favorPersonDetail(pid) {
    let name, list, photo = '', relStr = '', isMe = false;
    if (pid === '__me__') {
      isMe = true;
      name = getMeName();
      list = state.favors.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.t - a.t);
    } else {
      const p = state.persons.find(x => x.id === pid);
      if (!p) return;
      name = p.name || '未记名';
      list = state.favors.filter(f => (f.personId || ('__' + (f.party || '').trim())) === pid)
        .sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.t - a.t);
      if (!list.length) return;
      photo = (p.photo) ? `<img class="person-ava" style="width:42px;height:42px" src="${esc(p.photo)}" alt="">` : '';
      relStr = p.relation ? (' · ' + esc(p.relation)) : '';
    }
    if (!list.length) return;
    const gives = list.filter(f => f.kind === 'give');
    const gets = list.filter(f => f.kind === 'get');
    const giveSum = gives.reduce((s, f) => s + (Number(f.amount) || 0), 0);
    const getSum = gets.reduce((s, f) => s + (Number(f.amount) || 0), 0);
    const diff = giveSum - getSum;
    const pend = gets.find(isPendingGet);
    const titleName = isMe ? (name + ' · 全部往来明细') : (name + relStr + ' · 往来明细');
    const logsHTML = list.length ? list.map(favorEntryHTML).join('')
      : '<div class="note-muted">暂无往来记录</div>';
    let editBtn;
    if (isMe) editBtn = `<button class="btn secondary" data-action="favor-me-edit">✏️ 修改昵称</button>`;
    else editBtn = `<button class="btn secondary" data-action="favor-person-edit" data-person="${esc(pid)}">✏️ 修改人员</button>`;
    const recipBtn = (!isMe && (pend || (getSum - giveSum > 0.005))) ? `<button class="btn secondary" data-action="favor-recip" data-person="${esc(pid)}">🔁 回礼</button>` : '';
    const html = `
      <button class="modal-close" data-action="close-modal">×</button>
      <h3>💝 ${esc(titleName)}</h3>
      <div style="margin:-4px 0 8px">${photo}</div>
      <div class="kv-list">
        ${isMe
          ? `<div class="kv"><span>我随出（给他人）</span><b>${gives.length} 笔 · ¥${fmt(giveSum)}</b></div>
             <div class="kv"><span>我收礼（他人随我）</span><b>${gets.length} 笔 · ¥${fmt(getSum)}</b></div>
             <div class="kv"><span>净差额</span><b>${diff >= 0 ? '我多付' : '我多收'} ¥${fmt(Math.abs(diff))}</b></div>`
          : `<div class="kv"><span>${esc(name)}随礼（给我）</span><b>${gets.length} 笔 · ¥${fmt(getSum)}</b></div>
             <div class="kv"><span>我回礼（给 TA）</span><b>${gives.length} 笔 · ¥${fmt(giveSum)}</b></div>
             <div class="kv"><span>合计（我回礼 − TA随礼）</span><b>${diff >= 0 ? '我多付' : 'TA多付'} ¥${fmt(Math.abs(diff))}</b></div>
             <div class="kv"><span>状态</span><b>${pend ? '待初次回礼' : (list.length > 1 ? '有来有往' : '单次往来')}</b></div>`}
      </div>
      <div class="group-title">往来记录${isMe ? '（我参与的全部）' : ''}</div>
      ${logsHTML}
      <div class="modal-actions">
        ${recipBtn}
        ${editBtn}
        <button class="btn ghost" data-action="close-modal">关闭</button>
      </div>`;
    openModal(html);
  }

  // 修改人员：人名 / 关系 / 照片（改名后名下记录自动归并到新名字）
  function favorPersonEdit(pid) {
    const p = state.persons.find(x => x.id === pid);
    if (!p) return;
    personPhotoTemp = null;
    const photo = (p.photo)
      ? `<img class="person-edit-photo" src="${esc(p.photo)}" alt="">`
      : `<div class="person-edit-photo person-edit-photo--empty">无照片</div>`;
    openModal(`
      <button class="modal-close" data-action="close-modal">×</button>
      <h3>✏️ 修改人员 · ${esc(p.name || '未记名')}</h3>
      <div class="hint">可修改人名、关系，并为该人员添加照片（用于往来识别）。改名后，其名下所有随礼记录会自动归到新名字。</div>
      <div class="person-edit-photo-wrap">
        ${photo}
        <label class="btn ghost sm" style="cursor:pointer">📷 选择照片<input type="file" id="personPhoto" accept="image/*" style="display:none"></label>
      </div>
      <form id="personForm" onsubmit="return false">
        <label>人名<input name="name" value="${esc(p.name || '')}" placeholder="如：老王 / 表姐"></label>
        <label>关系（可选）<input name="relation" value="${esc(p.relation || '')}" placeholder="如：同事 / 邻居 / 亲戚"></label>
        <div class="modal-actions">
          <button class="btn ghost" data-action="close-modal">取消</button>
          <button class="btn" data-action="save-person" data-person="${esc(pid)}">保存</button>
        </div>
      </form>
    `);
  }

  async function savePerson(pid) {
    const p = state.persons.find(x => x.id === pid);
    if (!p) return;
    const form = $('#personForm'); if (!form) return;
    const fd = new FormData(form);
    const nm = (fd.get('name') || '').trim() || p.name;
    p.name = nm;
    p.relation = (fd.get('relation') || '').trim();
    if (personPhotoTemp) { p.photo = personPhotoTemp; personPhotoTemp = null; }
    await DB.put('persons', p);
    state.persons = await DB.getAll('persons');
    closeModal(); render(); toast('已保存人员信息');
  }

  // 修改“我”的昵称（账本主体，存于 settings.meName）
  function favorMeEdit() {
    const cur = getMeName();
    openModal(`
      <button class="modal-close" data-action="close-modal">×</button>
      <h3>✏️ 修改「我」的昵称</h3>
      <div class="hint">「我」是账本主体，用于按人员视图的总览。可改为你想显示的称呼（如：我自己 / 小光）。</div>
      <form id="meForm" onsubmit="return false">
        <label>昵称<input name="name" value="${esc(cur)}" placeholder="如：我自己"></label>
        <div class="modal-actions">
          <button class="btn ghost" data-action="close-modal">取消</button>
          <button class="btn" data-action="save-me">保存</button>
        </div>
      </form>
    `);
  }
  async function saveMeName() {
    const form = $('#meForm'); if (!form) return;
    const fd = new FormData(form);
    const nm = (fd.get('name') || '').trim();
    if (!nm) return toast('昵称不能为空');
    await saveSetting('meName', nm);
    state.settings = await DB.getAll('settings');
    closeModal(); render(); toast('已保存');
  }

  function viewFeature() {
    const tab = state.featureTab || '';

    // ---- 人情往来完整视图 ----
    if (tab === 'favor') {
      const view = state.favorView || 'event';
      const total = state.favors.length;
      const seg = `
        <div class="inv-seg" style="margin-bottom:12px">
          <button class="${view === 'event' ? 'active' : ''}" data-action="favor-view" data-view="event">📋 按事项</button>
          <button class="${view === 'person' ? 'active' : ''}" data-action="favor-view" data-view="person">👤 按人员</button>
        </div>`;
      const form = (state.editFavorId || state.favorRecipOf || state.favorAddOpen) ? favorFormHTML() : '';

      return `
        <div class="inv-seg" style="margin-bottom:12px">
          <button class="active" data-action="feature-tab" data-ftab="favor">💝 人情往来</button>
          <button data-action="feature-tab" data-ftab="pot">🐷 存钱罐</button>
        </div>
        <div class="card">
          <h3>💝 人情往来 · 随礼</h3>
          <div class="hint">记下随礼往来：我随礼（对方日后回礼）、他人随礼（我日后回礼）。涉及金额自动同步进「资金」页对应账户。</div>
        </div>
        ${seg}
        <div class="summary">
          <div class="box" style="flex:0 0 auto"><div class="k">随礼笔数</div><div class="v">${total}</div></div>
          ${form ? '' : `<button class="btn" style="flex:0 0 auto;align-self:center" data-action="favor-add">➕ 添加随礼</button>`}
        </div>
        ${form}
        <div class="card">${view === 'person' ? favorByPersonHTML() : favorByEventHTML()}</div>`;
    }

    // ---- 存钱罐视图（待开发） ----
    if (tab === 'pot') {
      return `
        <div class="inv-seg" style="margin-bottom:12px">
          <button data-action="feature-tab" data-ftab="favor">💝 人情往来</button>
          <button class="active" data-action="feature-tab" data-ftab="pot">🐷 存钱罐</button>
        </div>
        <div class="card">
          <h3>🐷 存钱罐</h3>
          <div class="hint">设立存钱目标，积少成多。功能开发中，敬请期待 ✨</div>
        </div>
        <div class="empty">
          <div class="big">🚧</div>
          <div>功能开发中，敬请期待</div>
        </div>`;
    }

    // ---- 默认页：功能键并排 + 最近随礼记录 + 存钱罐相关资金记录 ----
    const recentFavors = state.favors.slice().sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, 5);
    const favorRecentHTML = recentFavors.length
      ? recentFavors.map(f => {
          const giveGet = f.kind === 'give' ? '我随礼 →' : '他随礼 →';
          const amt = Number(f.amount) || 0;
          return `<div class="kv">
            <span>${esc(f.event || '未命名')} · ${esc(giveGet)} ${esc(f.party || '')} · ${esc(f.date || '')}</span>
            <b class="${f.kind === 'give' ? 'neg' : 'pos'}">${f.kind === 'give' ? '-' : '+'}¥${fmt(amt)}</b>
          </div>`;
        }).join('')
      : '<div class="note-muted">暂无人情往来记录</div>';

    // 最近资金变动记录（作为存钱罐相关记录）
    const recentLogs = state.accountLogs.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 5);
    const logRecentHTML = recentLogs.length
      ? recentLogs.map(l => {
          const acc = state.accounts.find(a => a.id === l.accId);
          const accName = acc ? esc(acc.name) : '已删除账户';
          const delta = Number(l.delta) || 0;
          return `<div class="kv">
            <span>${esc(l.note || l.type || '变动')} · ${accName} · ${l.date || ''}</span>
            <b class="${delta >= 0 ? 'pos' : 'neg'}">${delta >= 0 ? '+' : ''}¥${fmt(delta)}</b>
          </div>`;
        }).join('')
      : '<div class="note-muted">暂无资金变动记录</div>';

    return `
      <div class="inv-seg" style="margin-bottom:12px">
        <button data-action="feature-tab" data-ftab="favor">💝 人情往来</button>
        <button data-action="feature-tab" data-ftab="pot">🐷 存钱罐</button>
      </div>
      <div class="card">
        <h3>💝 最近随礼记录</h3>
        ${favorRecentHTML}
        ${state.favors.length > 5 ? `<button class="btn sm secondary mt" data-action="feature-tab" data-ftab="favor">查看全部 ›</button>` : ''}
      </div>
      <div class="card">
        <h3>🐷 存钱罐 · 最近资金变动</h3>
        ${logRecentHTML}
      </div>`;
  }

  async function saveFavor(form) {
    const fd = new FormData(form);
    const editingId = form.dataset.edit || '';
    const kind = fd.get('kind');
    const event = (fd.get('event') || '').trim() || '未命名事项';
    const date = fd.get('date') || new Date().toISOString().slice(0, 10);
    const note = (fd.get('note') || '').trim();

    // 单条修改
    if (editingId) {
      const old = state.favors.find(x => x.id === editingId); if (!old) return toast('记录不存在');
      const party = (fd.get('party') || '').trim();
      if (!party) return toast('请填写对方名称');
      const amount = Number(fd.get('amount')) || 0;
      const accountId = amount > 0 ? (fd.get('accountId') || '') : '';
      const person = await resolvePerson(party);
      await applyFavorFund(old, -1); // 撤销旧的资金联动
      old.kind = kind; old.event = event; old.date = date; old.party = person.name; old.personId = person.id;
      old.amount = amount > 0 ? amount : 0; old.accountId = amount > 0 ? accountId : '';
      old.note = note;
      if (old.amount <= 0) { old.amount = 0; old.accountId = ''; }
      await applyFavorFund(old, 1);
      await DB.put('favors', old);
      state.editFavorId = ''; state.favorAddOpen = false; state.favorRecipOf = ''; state.favorRecipName = '';
      await refresh(); render(); toast('已保存'); return;
    }

    // 批量添加（每行 = 一笔随礼）
    const rows = $$('#favorRows .favor-row');
    if (!rows.length) return toast('请至少填一行');
    let created = 0, skipped = 0;
    for (const row of rows) {
      const party = (row.querySelector('[name=party]').value || '').trim();
      const amount = Number(row.querySelector('[name=amount]').value) || 0;
      const recipOfEl = row.querySelector('[name=recipOf]');
      const recipOf = recipOfEl ? (recipOfEl.value || '') : '';
      if (!party) { skipped++; continue; }
      const accountId = amount > 0 ? (row.querySelector('[name=accountId]').value || '') : '';
      const person = await resolvePerson(party);
      const obj = {
        id: 'fv_' + Date.now() + Math.random().toString(36).slice(2, 6),
        kind, event, date, party: person.name, personId: person.id,
        amount: amount > 0 ? amount : 0, accountId: amount > 0 ? accountId : '',
        note, recipOf: recipOf || '', reciprocated: false, t: Date.now(),
      };
      if (obj.amount <= 0) { obj.amount = 0; obj.accountId = ''; }
      await applyFavorFund(obj, 1);
      await DB.put('favors', obj);
      created++;
    }
    if (!created) return toast('请至少填一行对方与金额');
    state.favorAddOpen = false; state.favorRecipOf = ''; state.favorRecipName = '';
    await refresh(); render(); toast('已记 ' + created + ' 笔随礼' + (skipped ? ('（跳过 ' + skipped + ' 空白行）') : ''));
  }

  async function delFavor(id) {
    const f = state.favors.find(x => x.id === id);
    if (!f) return;
    await applyFavorFund(f, -1); // 撤销资金联动
    await DB.del('favors', id);
    await refresh(); render(); toast('已删除');
  }

  // ============ 全量数据备份 / 恢复 ============
  const BACKUP_STORES = ['items', 'accounts', 'loans', 'snapshots', 'stockLogs', 'accountLogs', 'favors', 'feedbacks', 'settings'];
  let pendingImport = null;
  async function backupAllData() {
    toast('正在收集数据…');
    const stores = {};
    for (const n of BACKUP_STORES) stores[n] = await DB.getAll(n);
    const data = { meta: { app: '物掌柜 StuffManage', version: 5, exportedAt: new Date().toISOString() }, stores };
    state.pendingBackup = data;
    state.backupReady = true;
    state.lastBackupAt = Date.now();
    localStorage.setItem('sm_last_backup', JSON.stringify(state.lastBackupAt));
    render();
    // 统计总条数
    const total = Object.values(stores).reduce((s, arr) => s + arr.length, 0);
    toast(`✅ 备份已完毕！共 ${Object.keys(stores).length} 类数据 ${total} 条记录`);
  }

  function doExportBackup() {
    if (!state.pendingBackup) { toast('请先点击「一键备份」'); return; }
    const data = state.pendingBackup;
    // 用 application/octet-stream 强制浏览器触发下载，不内嵌展示 JSON
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/octet-stream' });
    const fileName = '物掌柜_全量备份_' + Date.now() + '.json';
    const file = new File([blob], fileName, { type: 'application/octet-stream' });
    // 优先系统分享
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: '物掌柜数据备份', text: '换手机请用物掌柜「导入备份」恢复' })
        .then(() => toast('已唤起系统分享'))
        .catch(e => { if (!e || e.name !== 'AbortError') downloadBackupFile(blob, fileName); });
      return;
    }
    downloadBackupFile(blob, fileName);
  }

  function downloadBackupFile(blob, fileName) {
    // 移动端：开新页面让用户长按保存
    if (/Mobi|Android|iPhone/i.test(navigator.userAgent)) {
      const url = URL.createObjectURL(blob);
      const w = window.open('', '_blank');
      if (w) {
        w.document.title = '物掌柜备份';
        w.document.body.innerHTML = `<div style="position:fixed;inset:0;background:#141826;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:20px;font-family:sans-serif;color:#eef2fb"><div style="font-size:18px;font-weight:700">💾 备份文件已生成</div><a href="${url}" download="${fileName}" style="color:#4f8cff;font-size:16px;text-decoration:underline">点击下载备份 (${(blob.size/1024).toFixed(1)} KB)</a><div style="font-size:13px;color:#8b93a3;text-align:center">长按链接保存到文件<br>再通过微信/云盘发送到其他设备</div></div>`;
        w.document.close();
        toast('已打开下载页面，长按链接保存');
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        return;
      }
      toast('弹窗被拦截，请允许弹窗后重试');
      return;
    }
    // 桌面端：直接下载
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('已下载备份文件到「下载」文件夹');
  }
  function importAllStart() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'application/json,.json';
    inp.onchange = async () => {
      const file = inp.files && inp.files[0]; if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (!data || !data.stores) throw new Error('不是有效的物掌柜备份');
        pendingImport = data;
        const t = data.meta && data.meta.exportedAt ? new Date(data.meta.exportedAt).toLocaleString('zh-CN') : '未知时间';
        const counts = Object.keys(data.stores).map(k => `${k} ${data.stores[k].length}`).join('  ');
        openModal(`
          <button class="modal-close" data-action="close-modal">×</button>
          <h3>📥 确认导入备份</h3>
          <div class="hint">该备份导出于 ${esc(t)}。<br>包含：${esc(counts)}</div>
          <div class="note-muted mb">导入按 ID 合并：同名记录被备份覆盖，本机独有记录保留。导入后页面自动刷新。</div>
          <div class="modal-actions">
            <button class="btn ghost" data-action="close-modal">取消</button>
            <button class="btn" data-action="confirm-import-all">确认导入</button>
          </div>`);
      } catch (e) { toast('导入失败：' + (e.message || '格式错误')); }
    };
    inp.click();
  }
  async function confirmImportAll() {
    if (!pendingImport) return;
    const stores = pendingImport.stores || {};
    let total = 0;
    for (const name of Object.keys(stores)) {
      const arr = stores[name] || [];
      for (const rec of arr) { await DB.put(name, rec); total++; }
    }
    pendingImport = null;
    closeModal();
    await refresh(); render();
    toast(`已导入 ${total} 条记录`);
  }

  function confirmClearAll() {
    openModal(`
      <button class="modal-close" data-action="close-modal">×</button>
      <h3 style="color:var(--danger)">⚠️ 清空所有数据</h3>
      <div class="hint">这将删除所有物品、账户、借贷、人情往来、出入库记录、资金变动和盘点记录。<br><b style="color:var(--danger)">此操作不可恢复！</b><br>建议先「导出备份」再清空。</div>
      <div class="modal-actions">
        <button class="btn ghost" data-action="close-modal">取消</button>
        <button class="btn" data-action="do-clear-all" style="background:var(--danger)">确认清空</button>
      </div>
    `);
  }
  async function doClearAll() {
    for (const name of BACKUP_STORES) {
      const all = await DB.getAll(name);
      for (const rec of all) await DB.del(name, rec.id);
    }
    closeModal();
    await refresh(); render();
    toast('所有数据已清空');
  }

  function viewLocate() {
    if (!state.items.length) {
      return `<div class="card empty"><div class="big">🏷️</div>还没有物品，先去「物品」入库吧。</div>`;
    }

    // 收集筛选项
    const cats = uniq(state.items.map(i => i.category).filter(Boolean)).sort();
    const addrs = uniq(state.items.map(i => i.address).filter(Boolean)).sort();
    // 按月份分组
    const periods = {};
    state.items.forEach(i => {
      const t = i.createdAt || i.updatedAt || Date.now();
      const ym = new Date(t).toISOString().slice(0, 7);
      periods[ym] = true;
    });
    const periodList = Object.keys(periods).sort().reverse();

    const flt = state.locateFilter || {};
    let filtered = state.items.slice();
    if (flt.cat) filtered = filtered.filter(i => i.category === flt.cat);
    if (flt.addr) filtered = filtered.filter(i => i.address === flt.addr);
    if (flt.period) filtered = filtered.filter(i => {
      const t = i.createdAt || i.updatedAt || Date.now();
      return new Date(t).toISOString().slice(0, 7) === flt.period;
    });

    // 按入库时间分组
    const groups = {};
    filtered.forEach(i => {
      const t = i.createdAt || i.updatedAt || Date.now();
      const ym = new Date(t).toISOString().slice(0, 7);
      (groups[ym] = groups[ym] || []).push(i);
    });
    const sortedGroups = Object.keys(groups).sort().reverse();

    const filterHTML = `
      <div class="card">
        <h3>🏷️ 条码打印</h3>
        <div class="hint">按入库时间分组显示，可按分类、地点、时间筛选。点击「打印」调用系统打印对话框。</div>
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <select id="fltCat" data-action="locate-filter" data-key="cat" style="flex:1;min-width:100px">
            <option value="">全部分类</option>
            ${cats.map(c => `<option value="${esc(c)}" ${flt.cat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
          </select>
          <select id="fltAddr" data-action="locate-filter" data-key="addr" style="flex:1;min-width:100px">
            <option value="">全部地点</option>
            ${addrs.map(a => `<option value="${esc(a)}" ${flt.addr === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}
          </select>
          <select id="fltPeriod" data-action="locate-filter" data-key="period" style="flex:1;min-width:100px">
            <option value="">全部时间</option>
            ${periodList.map(p => `<option value="${p}" ${flt.period === p ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
        </div>
        <div class="row mt" style="gap:8px">
          <button class="btn sm" data-action="print-all">🖨️ 批量打印</button>
          <button class="btn sm ghost" data-action="locate-filter-clear">清除筛选</button>
          <span class="note-muted" style="align-self:center">${filtered.length} 件物品</span>
        </div>
      </div>`;

    if (!filtered.length) {
      return filterHTML + `<div class="card empty"><div class="big">🔍</div>没有符合条件的物品</div>`;
    }

    const groupHTML = sortedGroups.map(ym => {
      const items = groups[ym];
      const cards = items.map(i => {
        const svg = i.barcode
          ? `<svg class="barcode" data-code="${esc(i.barcode)}"></svg>`
          : '<div class="note-muted">未生成条码</div>';
        const actions = i.barcode
          ? `<button class="btn secondary sm" data-action="print-barcode" data-code="${esc(i.barcode)}" data-name="${esc(i.name)}">🖨️ 打印</button>
             <button class="btn ghost sm" data-action="gen-barcode" data-id="${i.id}">重生成</button>`
          : `<button class="btn sm" data-action="gen-barcode" data-id="${i.id}">生成条码</button>`;
        return `<div class="barcode-card">
          <div class="name" style="font-weight:600;margin-bottom:6px">${esc(i.name)}</div>
          ${svg}
          <div class="muted" style="font-size:12px;margin:6px 0">${i.barcode ? esc(i.barcode) : ''}</div>
          ${actions}
        </div>`;
      }).join('');
      return `<div class="card">
        <h3 style="margin-bottom:8px">📅 ${ym}（${items.length} 件）</h3>
        <div class="barcode-grid">${cards}</div>
      </div>`;
    }).join('');

    return filterHTML + groupHTML;
  }

  function renderOneBarcode(svg) {
    if (!svg || !svg.dataset.code) return;
    try {
      JsBarcode(svg, svg.dataset.code, { format: 'CODE128', displayValue: true, fontSize: 14, margin: 4, height: 48, lineColor: '#000', background: '#fff' });
    } catch (e) { /* 忽略条码渲染异常 */ }
  }

  function printBarcode(code, name) {
    const area = $('#printArea');
    area.innerHTML = `<div class="print-sticker"><svg class="barcode" data-code="${esc(code)}"></svg><div class="print-name">${esc(name)}</div><div class="print-code">${esc(code)}</div></div>`;
    renderOneBarcode(area.querySelector('.barcode'));
    setTimeout(() => window.print(), 120);
  }

  function printAllBarcodes() {
    const items = state.items.filter(i => i.barcode);
    if (!items.length) return toast('暂无可打印的条码');
    const area = $('#printArea');
    area.innerHTML = items.map(i =>
      `<div class="print-sticker"><svg class="barcode" data-code="${esc(i.barcode)}"></svg><div class="print-name">${esc(i.name)}</div><div class="print-code">${esc(i.barcode)}</div></div>`
    ).join('');
    area.querySelectorAll('.barcode').forEach(renderOneBarcode);
    setTimeout(() => window.print(), 150);
  }

  // ================= 使用指南 =================
  function viewGuide() {
    const guideCSS = `<style>
*{box-sizing:border-box;margin:0;padding:0}
.g-guide{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#eef2fb;line-height:1.4;padding:0 12px 24px}
.g-guide h1{font-size:18px;margin:8px 0 2px}
.g-guide .sub{font-size:12px;color:#6b7280;margin-bottom:12px}
.g-sec{margin:14px 0}
.g-sec h2{font-size:14px;color:#4f8cff;margin-bottom:6px;padding-left:8px;border-left:3px solid #4f8cff}
.g-card{background:#1a1d28;border-radius:10px;overflow:hidden;margin-bottom:10px;border:1px solid #2a2e3a;display:flex}
.g-card img{width:100px;height:100px;object-fit:cover;flex-shrink:0;cursor:pointer;display:block}
.g-card img.full{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:90vw;height:auto;max-height:90vh;z-index:9999;border-radius:12px;box-shadow:0 0 0 9999px rgba(0,0,0,.75)}
.g-card .txt{padding:8px 10px;flex:1;min-width:0}
.g-card .txt h3{font-size:13px;margin-bottom:2px}
.g-card .txt p{font-size:11px;color:#a0a8c0;line-height:1.5}
.g-tags{font-size:10px;color:#6b7280;margin-top:3px;display:flex;flex-wrap:wrap;gap:2px}
.g-tags span{background:#141826;padding:1px 5px;border-radius:3px;border:1px solid #2a2e3a}
.g-back{display:block;width:100%;padding:12px;font-size:14px;background:#4f8cff;color:#fff;border:none;border-radius:10px;cursor:pointer;margin:16px 0;text-align:center}
.g-foot{text-align:center;padding:16px 0;font-size:11px;color:#6b7280}
</style>`;

    const card = (title, subtitle, img, desc, tags) => `
<div class="g-sec"><h2>${title}</h2>
<div class="g-card">
<img src="${img}" alt="${subtitle}" loading="lazy">
<div class="txt"><h3>${subtitle}</h3><p>${desc}</p><div class="g-tags">${tags.map(t => '<span>'+t+'</span>').join('')}</div></div>
</div></div>`;

    return guideCSS + `<div class="g-guide">
<h1>📦 物掌柜 · 使用指南</h1>
<div class="sub">快速上手，一图一文看懂所有功能</div>
${card('🏠 首页仪表盘','总览一切，一目了然','shot_home.png','首页集中展示资产总价值、资金余额、借贷状况等核心数据。<br>下方有「产品故事」和「功能全景图」，点击各模块可直接跳转。',['资产卡片','资金概览','借贷概览','功能导航'])}
${card('📦 物品管理','入库出库，条码追踪','shot_items.png','「📥 入库」录入新物品（名称、分类、地址、数量、价值、拍照可选），「📤 出库」减少库存。<br>表格展示所有物品明细，支持修改、删除、查看出入库记录。',['入库','出库','拍照','条码生成','明细查看'])}
${card('💵 资金账本','多账户管理，收支清晰','shot_funds.png','添加多个资金账户（银行卡、微信、支付宝等），记录每笔资金变动。<br>账户余额合计一目了然，支持按日期/类型筛选流水记录。',['多账户','收支记录','转账','余额统计'])}
${card('💳 借贷管理','借出借入，不糊涂账','shot_loans.png','记录每一笔借贷（对象、金额、期限、利率），支持分期还款。<br>还清后自动折叠到「已结清」区域，一目了然谁欠你多少钱。',['借出','借入','分期','利率计算','自动折叠'])}
${card('💝 人情往来','随礼往来，人情不丢','shot_feature.png','记录每一次随礼（你随礼 / 他人随礼），按事项或按人员分组查看。<br>涉及金额自动同步到资金账户，礼尚往来清清楚楚。',['我随礼','他人随礼','按事项','按人员','金额联动'])}
${card('🧮 盘点核账','定期盘点，账实相符','shot_inventory.png','物品盘点：逐项核对实物数量，自动计算差异。<br>资金盘点：核对每个账户实际余额，记录偏差。<br>每笔盘点生成快照，可随时回溯查看历史差异。',['物品盘点','资金盘点','差异记录','历史快照'])}
${card('🏷️ 打码贴标','一物一码，扫码即查','shot_locate.png','为每个物品生成一维条码，可打印成贴纸贴到实物上。<br>默认按入库时间分月展示，支持按分类/地点/时间筛选。<br>批量打印功能可一键打印所有条码。',['条码生成','按时间分组','分类筛选','批量打印'])}
${card('⚙️ 设置与备份','灵活配置，数据安全','shot_settings.png','功能模块开关、地址/分区/条码前缀自定义。<br>「🔧 一键备份」收集数据 →「💾 导出备份」下载 JSON 文件 →「📥 导入备份」在新设备恢复。<br>「🗑️ 清空数据」需二次确认，建议先备份再清空。',['模块开关','地址管理','分区管理','一键备份','导入恢复'])}
<button class="g-back" data-action="close-guide">🏠 返回首页</button>
<div class="g-foot">物掌柜 StuffManage · 长期免费 · 如有需求欢迎找作者定制</div>
</div>`;
  }

  // ================= 设置页 =================
  function viewSettings() {
    const modRows = MODULES.filter(m => !m.always).map(m =>
      `<div class="sw-row"><span>${m.label}</span>
        <label class="switch"><input type="checkbox" data-module="${m.key}" ${state.modules[m.key] ? 'checked' : ''}><span class="slider"></span></label>
      </div>`
    ).join('');

    const addrList = (state.addresses || []).map(a =>
      `<span class="tag loc">${esc(a)} <button type="button" class="link" data-action="del-address" data-val="${esc(a)}">✕</button></span>`
    ).join(' ') || '<span class="note-muted">未设置</span>';

    const zoneList = (state.zones || []).map(z =>
      `<span class="tag loc">${esc(z)} <button type="button" class="link" data-action="del-zone" data-val="${esc(z)}">✕</button></span>`
    ).join(' ') || '<span class="note-muted">未设置</span>';

    return `
      <div class="card"><h3>🧩 功能模块</h3>${modRows}<div class="hint">关闭后对应页签隐藏；首页始终显示。</div></div>

      <div class="card">
        <h3>📍 地址管理</h3>
        <div class="hint">设置多个地址，入库时可快速选择。</div>
        <div class="row"><input id="addrInput" placeholder="如：成都家 / 出租屋"><button class="btn sm" data-action="add-address">添加</button></div>
        <div class="mt">${addrList}</div>
      </div>

      <div class="card">
        <h3>🗂️ 分区位置</h3>
        <div class="hint">设置多个分区，如：卧室柜 / 书房架。</div>
        <div class="row"><input id="zoneInput" placeholder="如：主卧衣柜 / 客厅柜"><button class="btn sm" data-action="add-zone">添加</button></div>
        <div class="mt">${zoneList}</div>
      </div>

      <div class="card">
        <h3>🏷️ 条码前缀</h3>
        <div class="row"><input id="prefixInput" value="${esc(state.barcodePrefix)}" maxlength="6"><button class="btn sm" data-action="save-prefix">保存</button></div>
        <div class="hint">生成一维条码时的前缀，默认 WM。</div>
      </div>

      <div class="card">
        <h3>💾 数据备份与恢复</h3>
        <div class="hint">数据存在本机浏览器（刷新、关机不丢），但清除缓存、卸载、换设备会丢失。建议定期导出备份存云盘或电脑。</div>
        <div class="row mt">
          <button class="btn" data-action="backup-all">🔧 一键备份</button>
          <button class="btn" data-action="import-all">📥 导入备份</button>
        </div>
        ${state.backupReady && state.pendingBackup ? `
          <div class="card" style="background:var(--panel-2);margin-top:8px">
            <div style="font-weight:700;color:var(--accent-2);margin-bottom:6px">✅ 备份已准备就绪</div>
            <div class="kv-list" style="margin:4px 0">
              <div class="kv"><span>备份时间</span><b>${new Date(state.pendingBackup.meta.exportedAt).toLocaleString('zh-CN')}</b></div>
              ${Object.keys(state.pendingBackup.stores).map(k =>
                `<div class="kv"><span>${k}</span><b>${state.pendingBackup.stores[k].length} 条</b></div>`
              ).join('')}
            </div>
            <button class="btn secondary full mt" data-action="do-export-backup">💾 导出备份文件</button>
          </div>
        ` : ''}
        <div class="row mt">
          <button class="btn ghost" data-action="clear-all-data" style="color:var(--danger);border-color:var(--danger)">🗑️ 清空所有数据</button>
        </div>
        <div class="hint" style="margin-top:6px">一键备份：收集所有数据并生成备份包。<br>导出备份：下载 JSON 文件，可分享到微信/云盘保存。<br>导入：选择备份文件恢复，按 ID 合并。<br>清空：删除所有数据，不可恢复，请先备份。</div>
      </div>`;
  }

  async function addToSettingList(key, val) {
    if (!val) return;
    if (!Array.isArray(state[key])) state[key] = [];
    if (!state[key].includes(val)) {
      state[key].push(val);
      await DB.put('settings', { key, value: state[key] });
    }
  }
  async function delFromSettingList(key, val) {
    state[key] = (state[key] || []).filter(x => x !== val);
    await DB.put('settings', { key, value: state[key] });
    render();
  }
  async function saveSetting(k, v) { await DB.put('settings', { key: k, value: v }); }

  // ================= 工具 =================
  function genCode() {
    const s = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let r = '';
    for (let i = 0; i < 6; i++) r += s[Math.floor(Math.random() * s.length)];
    return 'ITEM-' + r;
  }
  function fileToDataURL(file) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  }
  // 将图片等比缩放到最长边 maxDim，强制转 JPEG 压缩（控制物品照片体积）
  function downscaleImage(file, maxDim) {
    return fileToDataURL(file).then(dataUrl => new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        const w = img.width, h = img.height;
        if (!w || !h) { res(dataUrl); return; }
        const scale = Math.min(1, maxDim / Math.max(w, h));
        const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
        const c = document.createElement('canvas'); c.width = cw; c.height = ch;
        c.getContext('2d').drawImage(img, 0, 0, cw, ch);
        res(c.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => res(dataUrl);
      img.src = dataUrl;
    }));
  }
  function uniq(arr) { return Array.from(new Set(arr)); }
  function fmt(n) { return Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  // 紧凑金额：巨大的数字用 万 / 亿 表示，避免溢出图形与卡片。返回不含 ¥ 的字符串。
  function fmtCompact(n) {
    const v = Number(n || 0), abs = Math.abs(v);
    const trim = s => s.replace(/\.?0+$/, '');
    if (abs >= 1e8) return trim((v / 1e8).toFixed(2)) + '亿';
    if (abs >= 1e4) return trim((v / 1e4).toFixed(2)) + '万';
    return fmt(v);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // 账户图标（按名称识别，仅用通用 emoji + 品牌暗示色，绝不使用任何支付 App 的官方 logo/商标）
  function accountIcon(name) {
    const n = (name || '').toLowerCase();
    if (n.includes('微信') || n.includes('wechat') || n.includes('wx')) return { emoji: '💚', color: '#07c160', bg: 'rgba(7,193,96,.16)' };
    if (n.includes('支付宝') || n.includes('支') || n.includes('alipay')) return { emoji: '🔵', color: '#1677ff', bg: 'rgba(22,119,255,.16)' };
    if (n.includes('银行') || n.includes('卡') || n.includes('储蓄') || n.includes('信用')) return { emoji: '💳', color: '#ffb454', bg: 'rgba(255,180,84,.16)' };
    if (n.includes('余额宝') || n.includes('理财') || n.includes('基金') || n.includes('股票')) return { emoji: '📈', color: '#a78bfa', bg: 'rgba(167,139,250,.16)' };
    if (n.includes('现金') || n.includes('钱包') || n.includes('零钱') || n.includes('钱')) return { emoji: '💵', color: '#2dd4a7', bg: 'rgba(45,212,167,.16)' };
    return { emoji: '💰', color: '#4f8cff', bg: 'rgba(79,140,255,.16)' };
  }

  function updatePriceTotal() {
    const f = $('#itemForm'); if (!f) return;
    const v = Number($('#itemForm [name=value]').value) || 0;
    const q = Number($('#itemForm [name=stock]').value) || 0;
    const pt = $('#priceTotal'); if (pt) pt.textContent = '¥' + fmt(v * q);
  }

  let currentModalCtx = null;
  let loanDetailId = null; // 当前明细弹窗所对应的借贷 id（用于还一期后刷新视图）
  let personPhotoTemp = null; // 人员修改弹窗中暂存的照片 dataURL（保存时写入）
  function openModal(html, ctx) {
    currentModalCtx = ctx || null;
    let mask = $('#modalMask');
    if (!mask) {
      mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.id = 'modalMask';
      document.body.appendChild(mask);
    }
    mask.innerHTML = `<div class="modal">${html}</div>`;
  }
  function closeModal() { const m = $('#modalMask'); if (m) m.remove(); currentModalCtx = null; loanDetailId = null; }

  // ================= 截图分享 =================
  let shotBlob = null;
  function openShare() {
    const labels = { home: '首页', items: '物品', funds: '资金', loans: '借贷', feature: '特色', inventory: '盘点', locate: '打码', settings: '设置' };
    shotBlob = null;
    openModal(`
      <button class="modal-close" data-action="close-modal">×</button>
      <h3>📷 截图分享</h3>
      <div class="hint">截取当前「${labels[state.tab] || '当前'}」页面。手机上点「分享」会调起系统菜单，可存到相册、发给微信 / 朋友圈等。</div>
      <div id="sharePreview" class="share-preview">正在生成预览…</div>
      <div class="share-tip">📱 手机：<b>长按上方图片 → 存储到相册</b>；或点「分享」调起系统菜单发微信 / 朋友圈。<br>💻 电脑：右键图片「图片另存为」，或点「下载」。</div>
      <div class="modal-actions">
        <button class="btn ghost" data-action="close-modal">取消</button>
        <button class="btn secondary" data-action="dl-shot">⬇️ 下载</button>
        <button class="btn" data-action="save-shot">📤 分享</button>
      </div>
    `);
    renderSharePreview();
  }
  function downloadShot() {
    if (!shotBlob) { renderSharePreview().then(() => doDownload()); return; }
    doDownload();
  }
  function doDownload() {
    if (!shotBlob) { toast('截图生成失败'); return; }
    const filename = '物掌柜_' + (state.tab || 'share') + '_' + Date.now() + '.png';
    // 移动端：打开新页面展示图片，用户长按即可保存到相册
    if (/Mobi|Android|iPhone/i.test(navigator.userAgent)) {
      const url = URL.createObjectURL(shotBlob);
      const w = window.open('', '_blank', 'width=' + screen.width + ',height=' + screen.height);
      if (w) {
        w.document.title = '物掌柜截图';
        w.document.body.innerHTML = '<div style="position:fixed;inset:0;background:#141826;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:20px;font-family:sans-serif;color:#eef2fb"><img src="' + url + '" style="max-width:100%;max-height:80vh;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.5)"><div style="font-size:14px;color:#8b93a3;text-align:center">👆 长按图片即可「保存到相册」</div></div>';
        w.document.close();
        toast('已打开图片，长按即可保存到相册');
        return;
      }
    }
    const url = URL.createObjectURL(shotBlob);
    const a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('已保存到「下载」文件夹');
  }
  async function renderSharePreview() {
    if (typeof html2canvas === 'undefined') { const p = $('#sharePreview'); if (p) p.textContent = '截图组件未加载，请刷新'; return; }
    const preview = $('#sharePreview');
    const fab = $('#shareFab'); if (fab) fab.style.visibility = 'hidden';
    const modal = $('#modalMask'); if (modal) modal.style.display = 'none';
    const toastEl = $('#toast'); if (toastEl) toastEl.style.visibility = 'hidden';
    if (preview) preview.textContent = '正在生成预览…';
    try {
      const node = $('#view');
      const bg = getComputedStyle(document.body).backgroundColor || '#0f1115';
      const canvas = await html2canvas(node || document.body, {
        backgroundColor: bg,
        scale: Math.min(2.5, window.devicePixelRatio || 2),
        useCORS: true, logging: false,
        scrollX: 0, scrollY: 0,
        windowWidth: node ? node.scrollWidth : window.innerWidth,
        windowHeight: node ? node.scrollHeight : window.innerHeight,
      });
      shotBlob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      if (preview && shotBlob) {
        URL.revokeObjectURL(preview.dataset.prevUrl || '');
        const url = URL.createObjectURL(shotBlob);
        preview.dataset.prevUrl = url;
        preview.innerHTML = `<img src="${url}" alt="截图预览">`;
      }
    } catch (e) {
      console.error(e); if (preview) preview.textContent = '预览生成失败：' + (e.message || '未知错误');
    } finally {
      if (modal) modal.style.display = '';
      if (fab) fab.style.visibility = '';
      if (toastEl) toastEl.style.visibility = '';
    }
  }
  async function saveShot() {
    if (typeof html2canvas === 'undefined') { toast('截图组件未加载，请刷新重试'); return; }
    if (!shotBlob) { await renderSharePreview(); }
    if (!shotBlob) { toast('截图生成失败'); return; }
    const file = new File([shotBlob], '物掌柜_' + (state.tab || 'share') + '_' + Date.now() + '.png', { type: 'image/png' });
    // 第一级：系统原生分享
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: '物掌柜 · 我的资产快照', text: '我用物掌柜管理物品与资产，分享给你看看～' });
        toast('已唤起系统分享'); return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    // 第二级：复制到剪贴板
    if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
      try {
        const item = new ClipboardItem({ 'image/png': shotBlob });
        await navigator.clipboard.write([item]);
        toast('✅ 图片已复制到剪贴板，可粘贴到聊天中发送');
        closeModal();
        return;
      } catch (e) { console.warn('clipboard write failed', e); }
    }
    // 第三级：下载到本地
    const url = URL.createObjectURL(shotBlob);
    const a = document.createElement('a'); a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('⚠️ 系统分享不可用，已下载到本地，可从相册手动分享');
  }

  // ================= 资产卡片（物掌柜自家样式 · 非官方截图） =================
  function openAssetCard() {
    const f = computeFinance();
    const d = new Date();
    const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const accRows = state.accounts.length
      ? state.accounts.map(a => {
          const ic = accountIcon(a.name);
          return `<div class="ac-acc-row">
            <span class="ac-acc-ico" style="color:${ic.color};background:${ic.bg}">${ic.emoji}</span>
            <div class="ac-acc-main"><div class="ac-acc-name">${esc(a.name)}</div><div class="ac-acc-sub">${esc(a.note || '—')}</div></div>
            <b class="ac-acc-bal">¥${fmt(a.balance)}</b>
          </div>`;
        }).join('')
      : '<div class="ac-acc-sub" style="padding:8px 2px;color:#8b93a3">还没有账户，先去「资金」添加</div>';

    const cardHTML = `
      <div class="asset-card" id="assetCard">
        <div class="ac-head">
          <div class="ac-brand">📦 物掌柜 <span>StuffManage</span></div>
          <div class="ac-pill">资产快照</div>
        </div>
        <div class="ac-date">${dateStr} · 数据来自本机记账</div>
        <div class="ac-net">
          <div class="ac-net-label">净资产（元）</div>
          <div class="ac-net-val"><span class="cur">¥</span>${fmtCompact(f.net)}</div>
        </div>
        <div class="ac-stats">
          <div class="ac-stat"><span>总资产</span><b>${fmtCompact(f.asset)}</b></div>
          <div class="ac-stat"><span>资金</span><b>${fmtCompact(f.cash)}</b></div>
          <div class="ac-stat"><span>物品</span><b>${fmtCompact(f.itemVal)}</b></div>
          <div class="ac-stat"><span>负债</span><b>${fmtCompact(f.debt)}</b></div>
        </div>
        <div class="ac-acc-title">💰 我的账户（${state.accounts.length}）</div>
        <div class="ac-acc">${accRows}</div>
        <div class="ac-foot">物掌柜 StuffManage · 仅供个人查看 · <b>非官方截图，不冒充任何支付 App</b></div>
      </div>`;

    openModal(`
      <button class="modal-close" data-action="close-modal">×</button>
      <h3>📊 资产卡片</h3>
      <div class="hint">用物掌柜自己的样式生成「资产快照」，可存图发给朋友。卡片带「物掌柜·非官方截图」标识，<b>绝不冒充微信 / 支付宝等任何支付 App</b>，秀资产也安心。</div>
      <div class="ac-wrap">${cardHTML}</div>
      <div class="modal-actions">
        <button class="btn ghost" data-action="close-modal">取消</button>
        <button class="btn secondary" data-action="dl-asset-card">⬇️ 存图</button>
        <button class="btn" data-action="save-asset-card">📤 分享</button>
      </div>
    `);
  }

  async function assetBlobOf() {
    const node = $('#assetCard');
    if (typeof html2canvas === 'undefined' || !node) { toast('截图组件未加载，请刷新'); return null; }
    try {
      const canvas = await html2canvas(node, {
        backgroundColor: '#141826',
        scale: 3,
        useCORS: true,
        allowTaint: false,
        logging: false,
        width: node.offsetWidth,
        height: node.offsetHeight
      });
      return await new Promise(r => canvas.toBlob(r, 'image/png'));
    } catch (e) {
      console.error(e); toast('图片生成失败：' + (e.message || '未知错误')); return null;
    }
  }
  async function dlAssetCard() {
    toast('正在生成图片…');
    const blob = await assetBlobOf();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const filename = '物掌柜_资产卡片_' + Date.now() + '.png';

    // 移动端：打开新页面展示图片，用户长按即可保存到相册
    if (/Mobi|Android|iPhone/i.test(navigator.userAgent)) {
      const w = window.open('', '_blank', 'width=' + screen.width + ',height=' + screen.height);
      if (w) {
        w.document.title = '物掌柜·资产卡片';
        w.document.body.innerHTML = '<div style="position:fixed;inset:0;background:#141826;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:20px;font-family:PingFang SC,sans-serif;color:#eef2fb"><img src="' + url + '" style="max-width:100%;max-height:80vh;border-radius:20px;box-shadow:0 18px 50px rgba(0,0,0,.5)"><div style="font-size:14px;color:#8b93a3;text-align:center">👆 长按图片即可「保存到相册」<br><span style="font-size:12px">保存后可从相册分享至微信/朋友圈</span></div></div>';
        w.document.close();
        toast('已打开图片，长按即可保存到相册');
        return;
      }
    }

    // 桌面端：直接触发下载
    const a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('已保存到「下载」文件夹');
  }
  async function saveAssetCard() {
    toast('正在生成图片…');
    const blob = await assetBlobOf();
    if (!blob) return;
    const file = new File([blob], '物掌柜_资产卡片_' + Date.now() + '.png', { type: 'image/png' });

    // 优先使用系统分享（支持直接发送到微信/QQ等）
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: '物掌柜 · 我的资产卡片', text: '我用物掌柜记账管理资产，分享给你看看～' });
        toast('已唤起系统分享'); return;
      } catch (e) {
        if (e && e.name === 'AbortError') return; // 用户取消，不提示
        console.warn('share failed, fallback to clipboard', e);
      }
    }

    // 降级方案：尝试复制图片到剪贴板（需要支持 ClipboardItem）
    if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
      try {
        const item = new ClipboardItem({ 'image/png': blob });
        await navigator.clipboard.write([item]);
        toast('✅ 图片已复制到剪贴板，可粘贴到聊天中发送');
        closeModal();
        return;
      } catch (e) { console.warn('clipboard write failed', e); }
    }

    // 最终降级：下载到本地
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('⚠️ 系统分享不可用，已下载到「下载」文件夹，可从相册手动分享');
  }

  // 删除二次确认（先点删除→弹窗，再点"确认删除"才真正删，防误触）
  function confirmDelete(kind, id, name) {
    const titles = { item: '删除物品', account: '删除账户', loan: '删除借贷', favor: '删除人情记录' };
    const subs = {
      item: `确定删除「${esc(name)}」？该物品的出入库记录会一并删除，不可恢复。`,
      account: `确定删除账户「${esc(name)}」？该账户的资金增减明细会一并删除，不可恢复。`,
      loan: `确定删除借贷「${esc(name)}」？不可恢复。`,
      favor: `确定删除这条人情记录「${esc(name)}」？若关联了资金账户，对应资金变动也会撤销，不可恢复。`,
    };
    closeModal();
    openModal(`
      <button class="modal-close" data-action="close-modal">×</button>
      <h3>⚠️ ${titles[kind]}</h3>
      <p class="muted">${subs[kind]}</p>
      <div class="modal-actions">
        <button class="btn ghost" data-action="close-modal">取消</button>
        <button class="btn danger" data-action="do-delete">确认删除</button>
      </div>
    `, { delKind: kind, delId: id });
  }

  async function doDelete() {
    const ctx = currentModalCtx;
    if (!ctx || !ctx.delKind) return;
    const { delKind, delId } = ctx;
    if (delKind === 'item') {
      await DB.del('items', delId);
      const logs = state.stockLogs.filter(l => l.itemId === delId);
      await Promise.all(logs.map(l => DB.del('stockLogs', l.id)));
    } else if (delKind === 'account') {
      await DB.del('accounts', delId);
      const linked = state.loans.filter(l => l.accountId === delId);
      await Promise.all(linked.map(l => { l.accountId = ''; return DB.put('loans', l); }));
      const alogs = state.accountLogs.filter(l => l.accountId === delId);
      await Promise.all(alogs.map(l => DB.del('accountLogs', l.id)));
      const flinked = state.favors.filter(f => f.accountId === delId);
      await Promise.all(flinked.map(f => { f.accountId = ''; return DB.put('favors', f); }));
      const rlinked = state.favors.filter(f => f.reciprocals && f.reciprocals.some(r => r.accountId === delId));
      await Promise.all(rlinked.map(f => { f.reciprocals.forEach(r => { if (r.accountId === delId) r.accountId = ''; }); return DB.put('favors', f); }));
    } else if (delKind === 'loan') {
      await DB.del('loans', delId);
    } else if (delKind === 'favor') {
      await delFavor(delId);
      return;
    }
    closeModal();
    await refresh(); render(); toast('已删除');
  }

  let toastTimer;
  function toast(msg) {
    let t = $('#toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg; t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 1900);
  }

  // ================= 事件绑定 =================
  function bindEvents() {
    document.addEventListener('click', onClick);
    document.addEventListener('input', (e) => {
      if (e.target.closest('#itemForm')) updatePriceTotal();
      if (e.target.id === 'stockOutSearch') {
        const box = $('#stockOutResults');
        if (box) box.innerHTML = stockOutResultsHTML(e.target.value.trim());
      }
    });
    document.addEventListener('change', onChange);
  }

  function onClick(e) {
    // 使用指南缩略图点击放大 / 再次点击关闭
    var gi = e.target.closest('.g-card img');
    if (gi) {
      if (gi.classList.contains('full')) {
        gi.classList.remove('full');
      } else {
        document.querySelectorAll('.g-card img.full').forEach(function(i){ i.classList.remove('full'); });
        gi.classList.add('full');
      }
      return;
    }
    // 照片删除按钮
    if (e.target.closest('#photoDelBtn')) {
      const img = $('#photoPreview'); if (img) img.src = '';
      const wrap = $('#photoPreviewWrap'); if (wrap) wrap.style.display = 'none';
      const delF = $('#deletePhoto'); if (delF) delF.value = '1';
      const file = $('#photoFile'); if (file) file.value = '';
      // 清空拍照/相册两个 input
      document.querySelectorAll('.photo-btns input[type="file"]').forEach(el => el.value = '');
      return;
    }

    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) {
      state.tab = tabBtn.dataset.tab;
      state.stockView = null; state.editItemId = ''; state.editAccId = ''; state.accAddOpen = false; state.editLoanId = ''; state.loanAddOpen = false; state.favorAddOpen = false; state.editFavorId = ''; state.favorRecipOf = '';
      saveView();
      render(); return;
    }
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const act = el.dataset.action;
    const id = el.dataset.id;

    switch (act) {
      case 'close-modal': closeModal(); break;
      case 'stock-in': state.stockView = 'in'; state.editItemId = ''; saveView(); render(); break;
      case 'stock-out': state.stockView = 'out'; state.editItemId = ''; saveView(); render(); break;
      case 'cancel-stock': state.stockView = null; state.editItemId = ''; saveView(); render(); break;
      case 'save-item': saveItem($('#itemForm')); break;
      case 'save-stock-out': saveStockOut($('#stockOutForm')); break;
      case 'open-item': itemDetail(id); break;
      case 'select-stockout-item': selectStockOutItem(id); break;
      case 'edit-item': state.editItemId = id; closeModal(); render(); break;
      case 'save-acc': saveAcc($('#accForm')); break;
      case 'edit-acc': state.editAccId = id; closeModal(); render(); break;
      case 'cancel-edit-acc': state.editAccId = ''; render(); break;
      case 'acc-add': state.accAddOpen = true; render(); break;
      case 'cancel-add-acc': state.accAddOpen = false; render(); break;
      case 'open-acc-detail': accountDetail(id); break;
      case 'acc-change': accChange(id); break;
      case 'del-item': { const it = state.items.find(x => x.id === id); confirmDelete('item', id, it ? it.name : ''); break; }
      case 'del-acc': { const a = state.accounts.find(x => x.id === id); confirmDelete('account', id, a ? a.name : ''); break; }
      case 'do-delete': doDelete(); break;
      case 'save-loan': saveLoan($('#loanForm')); break;
      case 'edit-loan': closeModal(); state.editLoanId = id; render(); break;
      case 'cancel-edit-loan': state.editLoanId = ''; render(); break;
      case 'loan-toggle-closed': state.loanClosedOpen = !state.loanClosedOpen; render(); break;
      case 'loan-add': state.loanAddOpen = true; render(); break;
      case 'cancel-add-loan': state.loanAddOpen = false; render(); break;
      case 'open-loan-detail': loanDetail(id); break;
      case 'del-loan': { const l = state.loans.find(x => x.id === id); confirmDelete('loan', id, l ? l.name : ''); break; }
      case 'repay-loan': repayLoanModal(id, el.dataset.repay === 'true'); break;
      case 'confirm-repay': confirmRepay(id, el.dataset.repay === 'true'); break;
      case 'loan-pay-period': confirmPayLoanPeriod(id); break;
      case 'confirm-pay-period': doPayLoanPeriod(id); break;
      case 'inv-mode': state.invMode = el.dataset.mode || ''; render(); break;
      case 'commit-inventory-items': commitInventoryItems(); break;
      case 'commit-inventory-funds': commitInventoryFunds(); break;
      case 'favor-add':
        if (state.favorAddOpen || state.editFavorId || state.favorRecipOf || state.favorRecipName) { state.favorAddOpen = false; state.editFavorId = ''; state.favorRecipOf = ''; state.favorRecipName = ''; render(); }
        else { state.favorAddOpen = true; render(); }
        break;
        closeModal(); render(); break;
      case 'favor-person-detail': favorPersonDetail(el.dataset.person); break;
      case 'favor-person-edit': personPhotoTemp = null; favorPersonEdit(el.dataset.person); break;
      case 'save-person': savePerson(el.dataset.person); break;
      case 'favor-me-edit': favorMeEdit(); break;
      case 'save-me': saveMeName(); break;
      case 'favor-view': state.favorView = el.dataset.view; render(); break;
      case 'save-favor': saveFavor($('#favorForm')); break;
      case 'edit-favor': state.editFavorId = id; state.favorAddOpen = false; state.favorRecipOf = ''; closeModal(); render(); break;
      case 'cancel-edit-favor': state.editFavorId = ''; render(); break;
      case 'favor-recip': {
        const p = state.persons.find(x => x.id === el.dataset.person);
        if (!p) break;
        closeModal(); state.favorAddOpen = true; state.favorRecipOf = ''; state.editFavorId = ''; state.favorRecipName = p.name; render(); break;
      }
      case 'favor-add-row': {
        const box = $('#favorRows');
        if (box) box.insertAdjacentHTML('beforeend', favorRowHTML(null, favorAccOpts(''), false));
        break;
      }
      case 'favor-del-row': {
        const row = el.closest('.favor-row');
        const box = row && row.parentElement;
        if (row && box && box.querySelectorAll('.favor-row').length > 1) row.remove();
        else if (row) toast('至少保留一行');
        break;
      }
      case 'del-favor': { const f = state.favors.find(x => x.id === id); confirmDelete('favor', id, (f ? (f.party || '') + ' · ' + (f.event || '') : '')); break; }
      case 'backup-all': backupAllData(); break;
      case 'do-export-backup': doExportBackup(); break;
      case 'import-all': importAllStart(); break;
      case 'confirm-import-all': confirmImportAll(); break;
      case 'clear-all-data': confirmClearAll(); break;
      case 'do-clear-all': doClearAll(); break;
      case 'view-snapshot': viewSnapshotDetail(id); break;
      case 'open-share': openShare(); break;
      case 'save-shot': saveShot(); break;
      case 'dl-shot': downloadShot(); break;
      case 'open-asset-card': openAssetCard(); break;
      case 'save-asset-card': saveAssetCard(); break;
      case 'dl-asset-card': dlAssetCard(); break;
      case 'gen-barcode': genBarcode(id); break;
      case 'print-barcode': printBarcode(el.dataset.code, el.dataset.name); break;
      case 'print-all': printAllBarcodes(); break;
      case 'locate-filter-clear': state.locateFilter = { cat: '', addr: '', period: '' }; render(); break;
      case 'feature-tab': state.featureTab = el.dataset.ftab || ''; render(); break;
      case 'open-guide': state.tab = 'guide'; saveView(); render(); break;
      case 'close-guide': state.tab = 'home'; saveView(); render(); break;
      case 'add-address': {
        const v = $('#addrInput').value.trim(); if (!v) return toast('请输入地址');
        addToSettingList('addresses', v).then(() => render());
        break;
      }
      case 'del-address': delFromSettingList('addresses', el.dataset.val); break;
      case 'add-zone': {
        const v = $('#zoneInput').value.trim(); if (!v) return toast('请输入分区位置');
        addToSettingList('zones', v).then(() => render());
        break;
      }
      case 'del-zone': delFromSettingList('zones', el.dataset.val); break;
      case 'save-prefix': {
        state.barcodePrefix = ($('#prefixInput').value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'WM';
        saveSetting('barcodePrefix', state.barcodePrefix).then(() => toast('已保存'));
        break;
      }
    }
  }

  function onChange(e) {
    // 借贷类型切换：贷款显示分期字段
    const kindSel = e.target.closest('#loanForm [name=kind]');
    if (kindSel) {
      const w = $('#loanDetailWrap');
      if (w) w.style.display = kindSel.value === '贷款' ? '' : 'none';
      return;
    }
    // 模块开关
    const mod = e.target.closest('[data-module]');
    if (mod) {
      state.modules[mod.dataset.module] = mod.checked;
      saveSetting('modules', state.modules).then(() => renderTabs());
      return;
    }
    // 自定义下拉（单位 / 地址 / 分区）
    const sel = e.target.closest('[data-custom]');
    if (sel) {
      const el = $('#' + sel.dataset.custom);
      if (el) {
        if (sel.value === '__new__') { el.style.display = ''; }
        else { el.style.display = 'none'; const inp = el.querySelector('input'); if (inp) inp.value = ''; }
      }
      return;
    }
    // 盘点差异原因备注持久化
    const dn = e.target.closest('.diffnote');
    if (dn && state.activeSnapshot) {
      const s = state.snapshots.find(x => x.id === state.activeSnapshot);
      if (s) { s.diffNotes = s.diffNotes || {}; s.diffNotes[dn.dataset.key] = dn.value; DB.put('snapshots', s); }
      return;
    }
    // 打码页筛选
    const fltSel = e.target.closest('[data-action="locate-filter"]');
    if (fltSel) {
      state.locateFilter = state.locateFilter || {};
      state.locateFilter[fltSel.dataset.key] = fltSel.value;
      render();
      return;
    }
    // 物品照片选择（拍照 / 相册两个 input 统一处理）
    const itemPhotoInput = e.target.closest('.photo-btns input[type="file"]');
    if (itemPhotoInput && itemPhotoInput.files[0]) {
      const dt = new DataTransfer();
      dt.items.add(itemPhotoInput.files[0]);
      const hidden = $('#photoFile');
      if (hidden) hidden.files = dt.files;
      const reader = new FileReader();
      reader.onload = () => {
        const img = $('#photoPreview');
        const wrap = $('#photoPreviewWrap');
        if (img) img.src = reader.result;
        if (wrap) wrap.style.display = '';
        const delF = $('#deletePhoto'); if (delF) delF.value = '0';
      };
      reader.readAsDataURL(itemPhotoInput.files[0]);
      return;
    }
    // 人员照片选择：缩放后暂存，并刷新预览
    const photoInput = e.target.closest('#personPhoto');
    if (photoInput) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      downscaleImage(file, 256).then(url => {
        personPhotoTemp = url;
        const prev = document.querySelector('.person-edit-photo');
        if (prev) { prev.src = url; prev.classList.remove('person-edit-photo--empty'); prev.textContent = ''; }
      });
      return;
    }
  }

  init();
})();
