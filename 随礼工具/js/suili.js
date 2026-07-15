(function(){
// ============ 随礼记 · 独立工具 ============
var state = {
  favors: [], persons: [], accounts: [],
  favorAddOpen: false, favorRecipOf: '', favorRecipName: '', editFavorId: '',
  favorView: 'event',
};
var DB = window.DB;

function esc(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function fmt(n){return Number(n||0).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}
function $(s){return document.querySelector(s)}
function $$(s){return document.querySelectorAll(s)}

var FAVOR_KINDS = {
  give:{label:'我随礼',dir:-1,color:var(--danger)},
  get:{label:'他人随礼',dir:1,color:var(--accent2)}
};

function toast(m){var t=document.createElement('div');t.textContent=m;t.style.cssText='position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#1a1d28;color:#fff;padding:10px 24px;border-radius:10px;font-size:14px;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);animation:fadeOut 2s forwards';document.body.appendChild(t);setTimeout(function(){t.remove()},2200)}

// ============ 初始化 ============
DB.open().then(refresh).then(render);

async function refresh(){
  [state.favors, state.persons, state.accounts] = await Promise.all([DB.getAll('favors'),DB.getAll('persons'),DB.getAll('accounts')]);
}

function render(){
  $('#view').innerHTML = viewMain();
  bindClicks();
}

function bindClicks(){
  $('#view').addEventListener('click',function(e){
    var el = e.target.closest('[data-action]');
    if(!el) return;
    var act = el.dataset.action;
    var id = el.dataset.id;
    switch(act){
      case 'favor-add': toggleFavorForm(); break;
      case 'save-favor': saveFavor(); break;
      case 'edit-favor': editFavor(id); break;
      case 'del-favor': delFavor(id); break;
      case 'favor-view': state.favorView = el.dataset.view; render(); break;
      case 'favor-recip': startRecip(el.dataset.person); break;
      case 'favor-recip-name': startRecipName(id); break;
      case 'open-qr': showQR(); break;
      case 'close-qr': closeQR(); break;
    }
  });
}

// ============ 主视图 ============
function viewMain(){
  var total = state.favors.length;
  var formHTML = state.favorAddOpen || state.editFavorId || state.favorRecipOf || state.favorRecipName ? favorFormHTML() : '';
  var view = state.favorView || 'event';
  var seg = '<div class="inv-seg" style="margin-bottom:12px"><button class="'+(view==='event'?'active':'')+'" data-action="favor-view" data-view="event">📋 按事项</button><button class="'+(view==='person'?'active':'')+'" data-action="favor-view" data-view="person">👤 按人员</button></div>';
  var body = view==='person' ? favorByPersonHTML() : favorByEventHTML();
  return '<div class="card"><h3>💝 随礼记 · 人情往来</h3><div class="hint">记下每一次随礼：你给出去的、别人给你的。心里有数，人情不丢。</div></div>'+
    seg+
    '<div class="summary"><div class="box"><div class="k">随礼笔数</div><div class="v">'+total+'</div></div>'+
    (formHTML?'':'<button class="btn" style="flex:0 0 auto;align-self:center" data-action="favor-add">➕ 添加随礼</button>')+
    '</div>'+
    formHTML+
    '<div class="card">'+body+'</div>';
}

// ============ 随礼表单 ============
function favorFormHTML(){
  var editing = state.editFavorId ? state.favors.find(function(f){return f.id===state.editFavorId}) : null;
  var recip = state.favorRecipOf ? state.favors.find(function(f){return f.id===state.favorRecipOf}) : null;
  var recipName = state.favorRecipName;
  var kind = editing ? editing.kind : (recip ? 'give' : 'give');
  var event = editing ? (editing.event||'') : '';
  var date = editing ? (editing.date||'') : new Date().toISOString().slice(0,10);
  var note = editing ? (editing.note||'') : '';
  var party0 = editing ? (editing.party||'') : (recip ? (recip.party||'') : '');
  var amount0 = editing ? (editing.amount||'') : '';
  var acc0 = editing ? (editing.accountId||'') : '';
  var accOpts = state.accounts.map(function(a){return '<option value="'+a.id+'">'+esc(a.name)+' (¥'+fmt(a.balance)+')</option>'}).join('');
  var title = editing ? '✏️ 修改随礼' : (recip ? '🔁 回礼 · 我随礼给「'+(recip.party||'')+'」' : '填写随礼');

  return '<div class="card"><h3>'+title+'</h3>'+
    '<form id="favorForm" data-edit="'+(editing?editing.id:'')+'">'+
    '<div class="row"><label>类型<select name="kind"><option value="give" '+(kind==='give'?'selected':'')+'>我随礼（日后他人回礼）</option><option value="get" '+(kind==='get'?'selected':'')+'>他人随礼（日后我回礼）</option></select></label>'+
    '<label>日期<input name="date" type="date" value="'+esc(date)+'"></label></div>'+
    '<label>事项<input name="event" value="'+esc(event)+'" placeholder="如：升学宴 / 婚礼 / 生日 / 乔迁"></label>'+
    '<label>备注<input name="note" value="'+esc(note)+'" placeholder="如：同学聚会"></label>'+
    '<label>对方名称<input name="party" value="'+esc(party0)+'" placeholder="姓名或称呼"></label>'+
    '<label>金额<input name="amount" type="number" step="0.01" value="'+amount0+'" placeholder="0.00"></label>'+
    '<label>关联账户<select name="accountId"><option value="">（不关联）</option>'+accOpts+'</select></label>'+
    '<div class="row mt"><button type="button" class="btn ghost" data-action="favor-add">取消</button><button type="button" class="btn" data-action="save-favor">💾 保存</button></div>'+
    '</form></div>';
}

function toggleFavorForm(){
  if(state.favorAddOpen||state.editFavorId||state.favorRecipOf||state.favorRecipName){
    state.favorAddOpen=false;state.editFavorId='';state.favorRecipOf='';state.favorRecipName='';
  }else{state.favorAddOpen=true;}
  render();
}

// ============ 保存随礼 ============
async function saveFavor(){
  var form = $('#favorForm'); if(!form) return;
  var fd = new FormData(form);
  var editingId = form.dataset.edit || '';
  var kind = fd.get('kind');
  var event = (fd.get('event')||'').trim()||'未命名';
  var date = fd.get('date')||new Date().toISOString().slice(0,10);
  var note = (fd.get('note')||'').trim();
  var party = (fd.get('party')||'').trim();
  var amount = Number(fd.get('amount'))||0;
  var accountId = fd.get('accountId')||'';

  if(!party) return toast('请填写对方名称');

  if(editingId && state.editFavorId){
    var old = state.favors.find(function(f){return f.id===editingId});
    if(!old) return toast('记录不存在');
    // 撤销旧资金联动
    if(old.amount&&old.accountId){await undoFund(old);}
    old.kind=kind;old.event=event;old.date=date;old.party=party;old.note=note;
    old.amount=amount;old.accountId=accountId;old.t=Date.now();
    await DB.put('favors',old);
    if(amount&&accountId) await applyFund(old);
  }else{
    var f={
      id:'fv_'+Date.now()+Math.random().toString(36).slice(2,6),
      kind:kind,event:event,date:date,party:party,note:note,
      amount:amount,accountId:accountId,t:Date.now()
    };
    await DB.put('favors',f);
    if(amount&&accountId) await applyFund(f);
    // 自动添加人员
    var exists = state.persons.find(function(p){return p.name===party});
    if(!exists){
      var p={id:'p_'+Date.now(),name:party,createdAt:Date.now()};
      await DB.put('persons',p);
      state.persons.push(p);
    }
  }
  state.favorAddOpen=false;state.editFavorId='';state.favorRecipOf='';state.favorRecipName='';
  await refresh();render();toast('已保存');
}

async function undoFund(f){
  var a=state.accounts.find(function(x){return x.id===f.accountId});
  if(!a) return;
  var delta = f.kind==='give' ? f.amount : -f.amount;
  a.balance+=delta;await DB.put('accounts',a);
}

async function applyFund(f){
  var a=state.accounts.find(function(x){return x.id===f.accountId});
  if(!a) return;
  var delta = f.kind==='give' ? -f.amount : f.amount;
  a.balance+=delta;await DB.put('accounts',a);
}

// ============ 编辑 / 删除 ============
function editFavor(id){
  state.editFavorId=id;state.favorAddOpen=false;state.favorRecipOf='';state.favorRecipName='';render();
}
async function delFavor(id){
  var f=state.favors.find(function(x){return x.id===id});
  if(!f) return;
  if(!confirm('确定删除「'+(f.party||f.event)+'」的随礼记录？')) return;
  if(f.amount&&f.accountId) await undoFund(f);
  await DB.del('favors',id);
  await refresh();render();toast('已删除');
}

// ============ 回礼 ============
function startRecip(personId){
  state.favorRecipOf='';state.favorRecipName='';
  var last = state.favors.filter(function(f){return f.kind==='get'&&f.personId===personId}).sort(function(a,b){return b.t-a.t})[0];
  if(last){state.favorRecipOf=last.id;}else{state.favorRecipName=personId;}
  state.favorAddOpen=false;state.editFavorId='';render();
}
function startRecipName(name){
  state.favorRecipName=name;state.favorRecipOf='';state.favorAddOpen=false;state.editFavorId='';render();
}

// ============ 按事项 / 按人员 ============
function favorByEventHTML(){
  if(!state.favors.length) return '<div class="empty"><div class="big">🤝</div>还没有随礼记录</div>';
  var groups={};
  state.favors.forEach(function(f){var ev=(f.event||'').trim()||'未命名';(groups[ev]=groups[ev]||[]).push(f);});
  return Object.keys(groups).sort(function(a,b){
    var da=groups[a][0].date||'',db=groups[b][0].date||'';
    return (db||'').localeCompare(da||'')||a.localeCompare(b);
  }).map(function(ev){
    var list=groups[ev].sort(function(a,b){return (b.date||'').localeCompare(a.date||'')||b.t-a.t});
    var giveSum=list.filter(function(f){return f.kind==='give'}).reduce(function(s,f){return s+(Number(f.amount)||0)},0);
    var getSum=list.filter(function(f){return f.kind==='get'}).reduce(function(s,f){return s+(Number(f.amount)||0)},0);
    return '<div class="loan-card"><div class="lh"><span class="lname">'+esc(ev)+'</span><span class="lbal">'+list.length+' 笔</span></div>'+
      '<div class="lmeta">我随 ¥'+fmt(giveSum)+' · 收 ¥'+fmt(getSum)+'</div>'+
      list.map(favorEntryHTML).join('')+'</div>';
  }).join('');
}

function favorByPersonHTML(){
  if(!state.favors.length) return '<div class="empty"><div class="big">🤝</div>还没有随礼记录</div>';
  var groups={};
  state.favors.forEach(function(f){var p=f.party||'未知';(groups[p]=groups[p]||[]).push(f);});
  return Object.keys(groups).sort().map(function(p){
    var list=groups[p].sort(function(a,b){return (b.date||'').localeCompare(a.date||'')||b.t-a.t});
    return '<div class="loan-card"><div class="lh"><span class="lname">'+esc(p)+'</span><span class="lbal">'+list.length+' 笔</span></div>'+
      list.map(favorEntryHTML).join('')+'</div>';
  }).join('');
}

function favorEntryHTML(f){
  var k=FAVOR_KINDS[f.kind]||{label:f.kind,dir:0};
  var amt=Number(f.amount)||0;
  var amtStr=amt>0?'<b style="color:'+(k.dir>0?'var(--accent2)':'var(--danger)')+'">'+(k.dir>0?'+':'-')+'¥'+fmt(amt)+'</b>':'';
  return '<div class="recip-row"><span><b>'+esc(f.party||'')+'</b> · '+k.label+' · '+amtStr+(f.date?' · '+esc(f.date):'')+'</span>'+
    '<span class="row-ops"><button class="btn sm ghost" data-action="edit-favor" data-id="'+f.id+'">修改</button>'+
    '<button type="button" class="link-del sm" data-action="del-favor" data-id="'+f.id+'">删除</button></span></div>';
}

// ============ 二维码分享 ============
function showQR(){
  var m=document.createElement('div');
  m.className='modal-overlay';m.id='qrModal';
  m.innerHTML='<div class="modal"><button class="modal-close" data-action="close-qr">×</button><h3>📷 分享随礼记</h3><p style="font-size:12px;color:var(--muted);margin-bottom:12px">扫码或发送链接给朋友</p><div class="qr" id="qrBox"></div><p style="font-size:11px;color:var(--muted);margin-top:10px">数据各存各的，互不影响</p></div>';
  document.body.appendChild(m);
  new QRCode(document.getElementById('qrBox'),{text:window.location.href,width:240,height:240,colorDark:'#0f1115',colorLight:'#ffffff'});
}
function closeQR(){var m=document.getElementById('qrModal');if(m)m.remove();}

})();
