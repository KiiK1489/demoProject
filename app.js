/**
 * 経費回収トラッカー app.js
 *
 * 計算ルール:
 *   fee = 元金 × 利率%（毎月固定の手数料）
 *   月支払(raw) = 元金/月数 + fee
 *   月支払(final) = ceilTo(raw, 切上単位)
 *   残債 = mrFinal×月数 - 累計回収
 *
 *   不足時: 元金+不足額 → fee再計算(新元金×利率) → 月数/月額を指定して再計算
 *   超過時: 元金-超過額 → fee変えない → 月数/月額を指定して再計算
 */
'use strict';

const SK = 'projects';
const PK = 'plans';
let projects = [];
let plans    = [];
let deletingId     = null;
let detailId       = null;
let shortageCtx    = null;

const DEFAULT_PLANS = [
  {id:1, name:'Easy',   rate:10,   color:'#3fb950'},
  {id:2, name:'Normal', rate:12.5, color:'#388bfd'},
  {id:3, name:'Hard',   rate:15,   color:'#d29922'},
];

/* ═══════════════════════════════
   STORAGE
═══════════════════════════════ */
function load(){
  try{ const r=localStorage.getItem(PK); plans=r?JSON.parse(r):[...DEFAULT_PLANS]; if(!Array.isArray(plans)||!plans.length) plans=[...DEFAULT_PLANS]; }catch{ plans=[...DEFAULT_PLANS]; }
  try{
    const r=localStorage.getItem(SK);
    if(!r){projects=[];return;}
    const p=JSON.parse(r);
    if(!Array.isArray(p)) throw 0;
    projects=p.map(mg);
  }catch{ projects=[]; }
}
function save()  { try{localStorage.setItem(SK,JSON.stringify(projects));}catch{toast('保存失敗','err');} }
function saveP() { try{localStorage.setItem(PK,JSON.stringify(plans));}catch{} }

function mg(p){
  if(!p.segments)           p.segments      = [{startElapsed:0,rate:p.rate||0}];
  if(!p.name)               p.name          = p.memo||'';
  if(!p.memo)               p.memo          = '';
  if(p.actualCost==null)    p.actualCost    = p.principal;
  if(!p.startDate)          p.startDate     = today();
  if(!p.deposits)           p.deposits      = [{date:p.startDate,amount:p.principal,virtualAmount:0,actualAmount:p.actualCost,note:'初回入金（移行）'}];
  if(!p.repayments)         p.repayments    = [];
  if(!p.shortageMode)       p.shortageMode  = 'months';
  if(p.shortageAccum==null) p.shortageAccum = 0;
  if(p.planId===undefined)  p.planId        = null;
  if(!p.roundUnit)          p.roundUnit     = 10000;
  if(p.virtualCost==null)   p.virtualCost   = 0;
  if(p.fee==null)           p.fee           = p.principal*(p.rate||0)/100;
  return p;
}

/* ═══════════════════════════════
   UTILS
═══════════════════════════════ */
function nextId()  { return projects.length?Math.max(...projects.map(p=>p.id))+1:1 }
function nextPid() { return plans.length?Math.max(...plans.map(p=>p.id))+1:1 }
function pn(v)     { if(v==null)return null; const n=parseFloat(String(v).replace(/,/g,'')); return isNaN(n)?null:n; }
function cv(id)    { return pn(document.getElementById(id)?.value) }
function fmt(n)    { return '¥'+Math.round(n).toLocaleString('ja-JP') }
function pct(n)    { return n.toFixed(1)+'%' }
function fmtRate(r){ return (r>=1?r/100:r).toFixed(3) }
function today()   { const d=new Date(); return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}` }
function z(n)      { return String(n).padStart(2,'0') }
function ceil(v,u) { if(!u||u<=1)return Math.ceil(v); return Math.ceil(v/u)*u }
function esc(s)    { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
function ea(s)     { return String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;') }
function dlFile(c,n,m){ const a=Object.assign(document.createElement('a'),{href:URL.createObjectURL(new Blob([c],{type:m})),download:n}); document.body.appendChild(a);a.click();document.body.removeChild(a); }

function ci(el){
  function ap(){ const r=el.value.replace(/[^0-9]/g,''); if(!r){el.value='';return;} const n=parseInt(r,10); el.value=isNaN(n)?'':n.toLocaleString('ja-JP'); }
  el.addEventListener('input',ap); el.addEventListener('compositionend',ap); el.addEventListener('blur',ap);
  el.addEventListener('focus',()=>setTimeout(()=>el.select(),0));
}
function initCI(){ document.querySelectorAll('.ci').forEach(ci); }

/* ═══════════════════════════════
   計算
═══════════════════════════════ */
function getFee(p)    { return p.fee!=null?p.fee:p.principal*(p.rate||0)/100 }
function mrRaw(p)     { return p.months?p.principal/p.months+getFee(p):0 }
function mrFinal(p)   { return ceil(mrRaw(p),p.roundUnit||10000) }
function totalPay(p)  { return mrFinal(p)*p.months }
function recovered(p) { return p.repayments&&p.repayments.length?p.repayments.reduce((s,r)=>s+(r.amount||0),0):p.recovered||0 }
function debt(p)      { return Math.max(0,totalPay(p)-recovered(p)) }
function capProfit(p) { return p.principal-(p.actualCost||p.principal) }

function profit(p){
  if(!p.elapsed) return 0;
  const mp=p.months?p.principal/p.months:0;
  let t=0;
  for(let i=0;i<p.segments.length;i++){
    const seg=p.segments[i];
    const nxt=i+1<p.segments.length?p.segments[i+1].startElapsed:p.elapsed;
    const sm=Math.max(0,nxt-seg.startElapsed); if(!sm) continue;
    const sf=p.principal*(seg.rate/100);
    const sr=ceil(mp+sf,p.roundUnit||10000);
    t+=(sr-mp)*sm;
  }
  return t;
}

/* ═══════════════════════════════
   プラン
═══════════════════════════════ */
function getPlan(id)  { return plans.find(p=>p.id===id)||null }
function getRate(id)  { const p=getPlan(id); return p?p.rate:0 }

function badge(planId){
  const pl=getPlan(planId);
  if(!pl) return '<span style="color:var(--muted);font-size:.78rem">—</span>';
  return `<span class="pbadge" style="color:${pl.color};border-color:${pl.color};background:${pl.color}18">${esc(pl.name)}</span>`;
}

function fillPlanSelects(sel=null){
  ['add-plan','detail-plan-select'].forEach(id=>{
    const el=document.getElementById(id); if(!el) return;
    const cur=sel!==null?sel:(pn(el.value)||null);
    el.innerHTML='<option value="">— プランなし —</option>';
    plans.forEach(pl=>{ const o=document.createElement('option'); o.value=pl.id; o.textContent=pl.name; if(cur===pl.id)o.selected=true; el.appendChild(o); });
  });
}

/* ═══════════════════════════════
   管理者
═══════════════════════════════ */
function openAdmin()  { renderPlans(); document.getElementById('modal-admin').classList.remove('hidden'); }
function closeAdmin() { document.getElementById('modal-admin').classList.add('hidden'); }

function renderPlans(){
  const c=document.getElementById('plan-list'); c.innerHTML='';
  if(!plans.length){ c.innerHTML='<p style="color:var(--muted);font-size:.85rem">プランがありません</p>'; return; }
  plans.forEach((pl,i)=>{
    const row=document.createElement('div'); row.className='plan-row';
    row.innerHTML=`
      <input class="plan-input" type="text" value="${ea(pl.name)}" data-i="${i}"/>
      <input class="plan-rate" type="number" value="${fmtRate(pl.rate)}" min="0" max="1" step="0.001" data-i="${i}" title="利率（0.125など）"/>
      <input type="color" class="color-pick" value="${pl.color}" data-i="${i}"/>
      <button class="btn-icon-sm btn-del" data-i="${i}">🗑</button>`;
    c.appendChild(row);
  });
  c.querySelectorAll('.plan-input').forEach(el=>{
    el.addEventListener('blur',()=>{ plans[+el.dataset.i].name=el.value.trim()||plans[+el.dataset.i].name; saveP();fillPlanSelects();renderAll(); });
    el.addEventListener('keydown',e=>{ if(e.key==='Enter')el.blur(); });
  });
  c.querySelectorAll('.plan-rate').forEach(el=>{
    el.addEventListener('blur',()=>{
      const i=+el.dataset.i; const rv=pn(el.value); if(rv===null||rv<0){ el.value=fmtRate(plans[i].rate); return; }
      const rp=rv<=1?rv*100:rv; plans[i].rate=rp;
      projects.forEach(p=>{ if(p.planId===plans[i].id){ p.rate=rp; p.fee=p.principal*(rp/100); const l=p.segments[p.segments.length-1]; if(l.startElapsed===p.elapsed)l.rate=rp; else p.segments.push({startElapsed:p.elapsed,rate:rp}); } });
      el.value=fmtRate(rp); saveP();save();renderAll();
    });
    el.addEventListener('keydown',e=>{ if(e.key==='Enter')el.blur(); });
  });
  c.querySelectorAll('.color-pick').forEach(el=>{ el.addEventListener('input',()=>{ plans[+el.dataset.i].color=el.value; saveP();renderAll(); }); });
  c.querySelectorAll('.btn-del').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const i=+btn.dataset.i; const pid=plans[i].id;
      if(!confirm(`プラン「${plans[i].name}」を削除しますか？`))return;
      plans.splice(i,1); projects.forEach(p=>{ if(p.planId===pid)p.planId=null; });
      saveP();save();renderPlans();fillPlanSelects();renderAll(); toast('プランを削除しました');
    });
  });
}

/* ═══════════════════════════════
   プレビュー（新規追加）
═══════════════════════════════ */
function updatePreview(){
  const principal=cv('add-principal'); const roundUnit=pn(document.getElementById('add-round').value)||10000;
  const recovType=document.getElementById('add-recovery-type').value;
  const planId=pn(document.getElementById('add-plan').value);
  const rate=planId?getRate(planId):0;
  const prev=document.getElementById('monthly-preview');
  if(!principal||principal<=0){ prev.classList.add('hidden'); return; }
  const virt=cv('add-actual')||0;
  const totalP=principal+virt;
  const fee=totalP*(rate/100);
  let months,rawM;
  if(recovType==='months'){
    months=pn(document.getElementById('add-months').value);
    if(!months||months<=0){ prev.classList.add('hidden'); return; }
    rawM=totalP/months+fee;
  } else {
    const mon=cv('add-monthly');
    if(!mon||mon<=0){ prev.classList.add('hidden'); return; }
    const mpp=mon-fee; if(mpp<=0){ prev.classList.add('hidden'); return; }
    months=Math.ceil(totalP/mpp); rawM=totalP/months+fee;
  }
  const finalM=ceil(rawM,roundUnit);
  document.getElementById('monthly-preview-val').textContent=fmt(finalM);
  document.getElementById('monthly-preview-detail').innerHTML=
    `月元本: ${fmt(totalP/months)} ＋ 月手数料: ${fmt(fee)} ＝ 切上前: ${fmt(rawM)} → 切上後: ${fmt(finalM)}<br>`+
    `${months}回払い　総支払: ${fmt(finalM*months)}　総手数料: ${fmt(fee*months)}`;
  prev.classList.remove('hidden');
}

/* ═══════════════════════════════
   新規追加
═══════════════════════════════ */
function addProject(){
  const name=document.getElementById('add-name').value.trim();
  const principal=cv('add-principal');
  if(!principal||principal<=0){ toast('元金を入力してください','err'); return; }
  const virt=cv('add-actual')||0;
  const totalP=principal+virt;
  const planId=pn(document.getElementById('add-plan').value)||null;
  const rate=planId?getRate(planId):0;
  const roundUnit=pn(document.getElementById('add-round').value)||10000;
  const recovType=document.getElementById('add-recovery-type').value;
  const fee=totalP*(rate/100);
  let months;
  if(recovType==='months'){
    months=pn(document.getElementById('add-months').value);
    if(!months||months<1){ toast('回収月数を入力してください','err'); return; }
  } else {
    const mon=cv('add-monthly');
    if(!mon||mon<=0){ toast('月支払額を入力してください','err'); return; }
    const mpp=mon-fee;
    if(mpp<=0){ toast('月支払額が手数料より少ないです','err'); return; }
    months=Math.ceil(totalP/mpp);
  }
  const p={
    id:nextId(), name, memo:'',
    principal:totalP, virtualCost:virt, actualCost:principal,
    fee, rate, months, elapsed:0, recovered:0,
    startDate:today(), planId, roundUnit,
    segments:[{startElapsed:0,rate}],
    deposits:[{date:today(),amount:totalP,virtualAmount:virt,actualAmount:principal,note:'初回入金'}],
    repayments:[], shortageMode:'months', shortageAccum:0
  };
  projects.push(p); save(); renderAll();
  ['add-name','add-principal','add-actual','add-months','add-monthly'].forEach(id=>{ const el=document.getElementById(id); if(el)el.value=''; });
  document.getElementById('monthly-preview').classList.add('hidden');
  document.getElementById('add-recovery-type').value='months';
  document.getElementById('wrap-months').classList.remove('hidden');
  document.getElementById('wrap-monthly').classList.add('hidden');
  toast(`案件 #${p.id}「${name||'無題'}」を追加しました`,'ok');
}

/* ═══════════════════════════════
   追加投資
═══════════════════════════════ */
function addFunds(){
  const id=pn(document.getElementById('funds-id').value);
  const amount=cv('funds-amount')||0;
  const virt=cv('funds-actual')||0;
  const date=document.getElementById('funds-date').value||today();
  const mode=document.querySelector('input[name="funds-mode"]:checked').value;
  if(!id||id<=0){ toast('案件IDを入力してください','err'); return; }
  if(amount<=0&&virt<=0){ toast('追加元金または仮想元金を入力してください','err'); return; }
  const p=projects.find(x=>x.id===id);
  if(!p){ toast(`ID ${id} の案件が見つかりません`,'err'); return; }
  const fixedFinal=mrFinal(p);
  if(!p.deposits)p.deposits=[];
  p.deposits.push({date,amount,virtualAmount:virt,actualAmount:amount,note:'追加投資'});
  recalcDeposits(p);
  if(mode==='extend'){
    const newMPP=fixedFinal-p.fee;
    const remP=Math.max(0,p.principal-(p.principal/p.months)*p.elapsed);
    if(newMPP>0) p.months=p.elapsed+Math.max(1,Math.ceil(remP/newMPP));
  }
  save(); renderAll();
  ['funds-id','funds-amount','funds-actual'].forEach(id=>{ const el=document.getElementById(id); if(el)el.value=''; });
  document.getElementById('funds-date').value=today();
  toast(`案件 #${id} に追加投資を反映しました`,'ok');
}

function recalcDeposits(p){
  if(!p.deposits||!p.deposits.length)return;
  const newP=p.deposits.reduce((s,d)=>s+(d.amount||0)+(d.virtualAmount||0),0);
  const newA=p.deposits.reduce((s,d)=>s+(d.actualAmount||0),0);
  const newV=p.deposits.reduce((s,d)=>s+(d.virtualAmount||0),0);
  p.principal=newP; p.actualCost=newA; p.virtualCost=newV;
  p.fee=newP*(p.rate/100);
  const finalM=mrFinal(p);
  const mpp=finalM-p.fee;
  if(mpp>0){
    const remP=Math.max(0,newP-mpp*p.elapsed);
    p.months=remP>0?p.elapsed+Math.ceil(remP/mpp):p.elapsed;
  }
}

/* ═══════════════════════════════
   回収記録
═══════════════════════════════ */
function recordPayment(id){
  const p=projects.find(x=>x.id===id); if(!p)return;
  const dateEl=document.querySelector(`.pay-date[data-id="${id}"]`);
  const amtEl=document.querySelector(`.pay-amt[data-id="${id}"]`);
  const date=dateEl?.value||today();
  const amount=pn(amtEl?.value?.replace(/,/g,''));
  if(!amount||amount<=0){ toast('回収金額を入力してください','err'); return; }
  const d=debt(p);
  if(amount>d+1){ toast(`残債(${fmt(d)})を超えています`,'err'); return; }
  const expected=mrFinal(p);
  const diff=amount-expected;
  if(diff<-1&&debt(p)>0){
    shortageCtx={id,date,amount,expected,shortage:expected-amount,type:'shortage'};
    openAdjust(p);
  } else if(diff>1){
    shortageCtx={id,date,amount,expected,surplus:amount-expected,type:'surplus'};
    openAdjust(p);
  } else {
    if(!p.repayments)p.repayments=[];
    p.repayments.push({date,amount}); p.elapsed++; p.recovered=recovered(p);
    save();renderAll();
    toast(`案件 #${id} 回収記録（${fmt(amount)}）`,'ok');
  }
  if(amtEl)amtEl.value='';
}

/* ═══════════════════════════════
   返済条件変更モーダル
═══════════════════════════════ */
function openAdjust(p){
  const ctx=shortageCtx;
  const isSh=ctx.type==='shortage';
  const diff=isSh?ctx.shortage:ctx.surplus;
  const diffLabel=isSh?'不足':'超過';
  const diffColor=isSh?'var(--red)':'var(--green)';
  document.getElementById('adjust-modal-title').textContent=isSh?'⚠ 不足 — 返済条件の変更':'✚ 超過 — 返済条件の変更';
  document.getElementById('shortage-info').innerHTML=
    `<span style="color:${diffColor}">${diffLabel}: <strong>${fmt(diff)}</strong></span>　`+
    `想定: <strong>${fmt(ctx.expected)}</strong> → 実際: <strong>${fmt(ctx.amount)}</strong>`;
  document.getElementById('shortage-info').style.cssText=`background:${isSh?'var(--red-bg)':'var(--green-bg)'};border:1px solid ${diffColor};border-radius:8px`;

  // プレビュー用: 不足→元金増、超過→元金減
  const origP=p.principal;
  const origFee=p.fee;
  if(isSh){
    p.principal = origP+ctx.shortage;
    p.fee = p.principal*(p.rate/100); // 不足: 新元金でfee再計算
  } else {
    p.principal = Math.max(0,origP-ctx.surplus);
    // 超過: feeは元のまま
  }

  const mp=origP/p.months;
  const remP=Math.max(0,p.principal-mp*p.elapsed);
  const remFee=remP*(p.rate/100);
  document.getElementById('shortage-remain-info').innerHTML=
    `残り元金: <strong>${fmt(remP)}</strong>　残り手数料: <strong>${fmt(remFee)}</strong>　残債合計: <strong>${fmt(remP+remFee)}</strong>`;

  // 元金を元に戻す
  p.principal=origP;
  p.fee=origFee;

  const rem=Math.max(1,p.months-p.elapsed);
  document.getElementById('shortage-new-months').value=rem;
  document.getElementById('shortage-new-monthly').value='';
  const r=document.querySelector('input[name="shortage-action"][value="months"]');
  if(r)r.checked=true;
  document.getElementById('shortage-months-wrap').classList.remove('hidden');
  document.getElementById('shortage-monthly-wrap').classList.add('hidden');
  document.getElementById('shortage-preview').classList.add('hidden');
  document.getElementById('modal-shortage').classList.remove('hidden');
}

function applyShortage(){
  if(!shortageCtx)return;
  const ctx=shortageCtx;
  const p=projects.find(x=>x.id===ctx.id); if(!p)return;
  const action=document.querySelector('input[name="shortage-action"]:checked').value;
  const isSh=ctx.type==='shortage';

  // 回収記録
  if(!p.repayments)p.repayments=[];
  p.repayments.push({date:ctx.date,amount:ctx.amount});
  p.elapsed++; p.recovered=recovered(p);

  // 元金・fee調整
  // 不足: 元金+不足分 → fee=新元金×利率（月支払増）
  // 超過: 元金-超過分 → fee=元のまま（月支払変わらず・回数が減る）
  const origMp=p.principal/p.months;
  if(isSh){
    p.principal   += ctx.shortage;
    p.shortageAccum=(p.shortageAccum||0)+ctx.shortage;
    p.fee = p.principal*(p.rate/100); // 新元金で再計算
  } else {
    p.principal = Math.max(0,p.principal-ctx.surplus);
    // feeは変えない → 月支払額は変わらず、残り回数だけ減る
  }

  // fee = 元金 × 利率%（これが正しい。絶対に上書きしない）
  // 月支払 = 元金/月数 + fee（月数だけ変えれば月支払は自動で決まる）
  // 残り元金・残り手数料（残り月数の計算に使う）
  const remP   = Math.max(0, p.principal - origMp*p.elapsed);
  const remFee = remP*(p.rate/100);
  const remTotal = remP + remFee;

  if(action==='months'){
    const nm=pn(document.getElementById('shortage-new-months').value);
    if(!nm||nm<1){ toast('残り月数を入力してください','err'); return; }
    // 月数を指定 → feeはそのまま → 月支払 = 元金/新月数 + fee が自動で変わる
    p.months = p.elapsed + nm;

  } else if(action==='monthly'){
    const mf=pn(document.getElementById('shortage-new-monthly').value?.replace(/,/g,''));
    if(!mf||mf<=0){ toast('月支払額を入力してください','err'); return; }
    // 月支払額から月数を逆算
    // mf = 元金/月数 + fee → 月数 = 元金/(mf - fee)
    const monthlyPrincipalPart = mf - p.fee;
    if(monthlyPrincipalPart <= 0){ toast('月支払額が手数料より少ないです','err'); return; }
    const nm = Math.max(1, Math.ceil(p.principal / monthlyPrincipalPart));
    p.months = nm; // 総月数（elapsed含む）
  }
  // none: 何もしない

  if(detailId===ctx.id) renderDetailSummary(p);
  save();renderAll();closeShortage();
  toast(`案件 #${ctx.id} の調整を適用しました`,'ok');
}

function closeShortage(){
  document.getElementById('modal-shortage').classList.add('hidden');
  shortageCtx=null;
}

function updateShortagePreview(){
  if(!shortageCtx)return;
  const p=projects.find(x=>x.id===shortageCtx.id); if(!p)return;
  const action=document.querySelector('input[name="shortage-action"]:checked')?.value;
  const isSh=shortageCtx.type==='shortage';

  // 新しい元金（確定時と同じ計算）
  const newPrincipal = isSh
    ? p.principal + shortageCtx.shortage
    : Math.max(0, p.principal - shortageCtx.surplus);
  // fee = 新元金×利率（不足時）or 元のfee（超過時）
  const newFee = isSh ? newPrincipal*(p.rate/100) : p.fee;

  const pv=document.getElementById('shortage-preview');
  const pt=document.getElementById('shortage-preview-text');

  if(action==='months'){
    const nm=pn(document.getElementById('shortage-new-months').value);
    if(!nm||nm<1){ pv.classList.add('hidden'); return; }
    // 月支払 = 新元金/新月数 + 新fee
    const newTotal=p.elapsed+nm;
    const rawM=newPrincipal/newTotal+newFee;
    const finalM=ceil(rawM,p.roundUnit||10000);
    pt.textContent=`月支払: ${fmt(finalM)}　×　${nm}回　総支払: ${fmt(finalM*newTotal)}`;
    pv.classList.remove('hidden');
  } else if(action==='monthly'){
    const mf=pn(document.getElementById('shortage-new-monthly').value?.replace(/,/g,''));
    if(!mf||mf<=0){ pv.classList.add('hidden'); return; }
    // 月数 = 新元金 / (mf - 新fee)
    const mpp=mf-newFee;
    if(mpp<=0){ pv.classList.add('hidden'); return; }
    const nm=Math.max(1,Math.ceil(newPrincipal/mpp));
    pt.textContent=`月支払: ${fmt(mf)}　×　${nm}回　総支払: ${fmt(mf*nm)}`;
    pv.classList.remove('hidden');
  } else pv.classList.add('hidden');
}

/* ═══════════════════════════════
   削除
═══════════════════════════════ */
function askDelete(id){
  deletingId=id;
  document.getElementById('modal-delete-text').textContent=`案件 #${id} を削除しますか？`;
  document.getElementById('modal-delete').classList.remove('hidden');
}
function doDelete(){
  if(deletingId===null)return;
  projects=projects.filter(p=>p.id!==deletingId);
  save();renderAll();closeDelete();toast(`案件 #${deletingId} を削除しました`);
}
function closeDelete(){ document.getElementById('modal-delete').classList.add('hidden'); deletingId=null; }

/* ═══════════════════════════════
   詳細
═══════════════════════════════ */
function openDetail(id){
  const p=projects.find(x=>x.id===id); if(!p)return;
  detailId=id;
  document.getElementById('detail-title').textContent=`案件 #${id}「${p.name||'無題'}」`;
  fillPlanSelects(p.planId);
  document.getElementById('detail-plan-select').value=p.planId||'';
  document.getElementById('detail-memo').value=p.memo||'';
  document.getElementById('detail-months').value=p.months||'';
  switchTab('summary');
  renderDetailSummary(p); renderDepositTable(p); renderRepaymentTable(p);
  document.getElementById('modal-detail').classList.remove('hidden');
}
function closeDetail(){ document.getElementById('modal-detail').classList.add('hidden'); detailId=null; }

function switchTab(name){
  document.querySelectorAll('.dtab').forEach(t=>t.classList.toggle('active',t.dataset.dtab===name));
  document.querySelectorAll('.dpane').forEach(p=>p.classList.toggle('hidden',p.id!==`dtab-${name}`));
}

function renderDetailSummary(p){
  const rec=recovered(p), d=debt(p), tp=totalPay(p);
  const recRate=tp>0?Math.min((rec/tp)*100,100):0;
  const pr=profit(p), fee=getFee(p), cap=capProfit(p);
  const remainM=Math.max(0,p.months-p.elapsed);
  const totalPayFinal=mrFinal(p)*p.months;
  const feeProfit=Math.max(0,totalPayFinal-p.principal);
  const profitRatePct=totalPayFinal>0?(feeProfit/totalPayFinal)*100:0;
  const profitExpected=feeProfit+Math.max(0,cap);
  const actualCostV=p.actualCost||p.principal;
  const actualRecRate=actualCostV>0?Math.min((rec/actualCostV)*100,999):0;

  const set=(id,v)=>{ const el=document.getElementById(id); if(el)el.textContent=v; };
  set('ds-principal',   fmt(p.principal));
  set('ds-actual',      fmt(actualCostV));
  set('ds-cap-profit',  fmt(cap));
  set('ds-fee',         fmt(fee*p.months));
  set('ds-monthly-fee', fmt(fee));
  set('ds-monthly',     fmt(mrRaw(p)));
  set('ds-total-months',`${p.months}回`);
  set('ds-remain-months',`${remainM}回`);
  set('ds-recovered',   fmt(rec));
  set('ds-remaining',   fmt(d));
  set('ds-profit',      fmt(pr));
  set('ds-profit-expected', fmt(profitExpected));
  set('ds-profit-rate', profitRatePct.toFixed(1)+'%');
  set('ds-actual-recovery-rate', actualRecRate.toFixed(1)+'%');
  set('ds-rate',        pct(recRate));
  set('ds-total-pay',   fmt(tp));

  const bar=document.getElementById('ds-rate-bar');
  if(bar){ bar.style.width=recRate.toFixed(1)+'%'; bar.className='rate-bar-fill'+(recRate>=70?'':recRate>=30?' mid':' low'); }

  const shr=document.getElementById('ds-shortage-row');
  if(shr){ shr.classList.toggle('hidden',!(p.shortageAccum>0)); }
  const dss=document.getElementById('ds-shortage'); if(dss&&p.shortageAccum>0)dss.textContent=fmt(p.shortageAccum);
}

/* ── 投資履歴 ── */
function renderDepositTable(p){
  const tb=document.getElementById('deposit-tbody'); if(!tb)return;
  tb.innerHTML='';
  if(!p.deposits||!p.deposits.length){ tb.innerHTML='<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--muted)">履歴なし</td></tr>'; return; }
  p.deposits.forEach((d,i)=>{
    const tag=i===0?'<span class="tag tag-init">初回</span>':'<span class="tag tag-add">追加</span>';
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td>${tag}</td>
      <td><input type="date" class="hi hi-date dep-date" value="${d.date||''}" data-i="${i}"/></td>
      <td><input type="text" class="hi hi-amt dep-amt" value="${Math.round(d.amount||0).toLocaleString('ja-JP')}" inputmode="numeric" data-i="${i}"/></td>
      <td><input type="text" class="hi hi-note dep-note" value="${ea(d.note||'')}" placeholder="メモ" data-i="${i}"/></td>
      <td>${i===0?'<span style="font-size:.7rem;color:var(--muted)">削除不可</span>':`<button class="h-del dep-del" data-i="${i}">🗑</button>`}</td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll('.dep-amt').forEach(el=>ci(el));
  tb.querySelectorAll('.dep-date,.dep-amt,.dep-note').forEach(el=>{
    el.addEventListener('blur',()=>saveDepEdit(p));
    el.addEventListener('change',()=>saveDepEdit(p));
  });
  tb.querySelectorAll('.dep-del').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const i=+btn.dataset.i;
      if(!confirm('削除して再計算しますか？'))return;
      p.deposits.splice(i,1); recalcDeposits(p);
      save();renderDepositTable(p);renderDetailSummary(p);renderAll();
      toast('削除して再計算しました');
    });
  });
}

function saveDepEdit(p){
  const tb=document.getElementById('deposit-tbody'); if(!tb)return;
  let changed=false;
  tb.querySelectorAll('tr').forEach((tr,i)=>{
    if(!p.deposits[i])return;
    const d=tr.querySelector(`.dep-date[data-i="${i}"]`);
    const a=tr.querySelector(`.dep-amt[data-i="${i}"]`);
    const n=tr.querySelector(`.dep-note[data-i="${i}"]`);
    if(d&&d.value!==p.deposits[i].date){ p.deposits[i].date=d.value; changed=true; }
    const nv=pn(a?.value)||0;
    if(a&&nv!==p.deposits[i].amount){ p.deposits[i].amount=nv; p.deposits[i].actualAmount=nv; changed=true; }
    if(n&&n.value!==p.deposits[i].note){ p.deposits[i].note=n.value; changed=true; }
  });
  if(!changed)return;
  recalcDeposits(p); save(); renderDetailSummary(p); renderAll();
  toast('投資履歴を更新・再計算しました','ok');
}

/* ── 回収履歴 ── */
function renderRepaymentTable(p){
  const tb=document.getElementById('repayment-tbody'); if(!tb)return;
  tb.innerHTML='';
  if(!p.repayments||!p.repayments.length){ tb.innerHTML='<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--muted)">履歴なし</td></tr>'; return; }
  const exp=mrFinal(p);
  p.repayments.forEach((r,i)=>{
    const diff=(r.amount||0)-exp;
    const dc=diff>=0?'surplus':'deficit';
    const ds=diff>=0?`+${fmt(diff)}`:fmt(diff);
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td>${i+1}</td>
      <td><input type="date" class="hi hi-date rep-date" value="${r.date||''}" data-i="${i}"/></td>
      <td><input type="text" class="hi hi-amt rep-amt" value="${Math.round(r.amount||0).toLocaleString('ja-JP')}" inputmode="numeric" data-i="${i}"/></td>
      <td>${fmt(exp)}</td>
      <td class="${dc}">${ds}</td>
      <td><button class="h-del rep-del" data-i="${i}">🗑</button></td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll('.rep-amt').forEach(el=>ci(el));
  tb.querySelectorAll('.rep-date,.rep-amt').forEach(el=>{
    el.addEventListener('blur',()=>saveRepEdit(p));
    el.addEventListener('change',()=>saveRepEdit(p));
  });
  tb.querySelectorAll('.rep-del').forEach(btn=>{
    btn.addEventListener('click',()=>{
      p.repayments.splice(+btn.dataset.i,1);
      p.elapsed=p.repayments.length; p.recovered=recovered(p);
      save();renderRepaymentTable(p);renderDetailSummary(p);renderAll();
    });
  });
}

function saveRepEdit(p){
  const tb=document.getElementById('repayment-tbody'); if(!tb)return;
  tb.querySelectorAll('tr').forEach((tr,i)=>{
    if(!p.repayments[i])return;
    const d=tr.querySelector(`.rep-date[data-i="${i}"]`);
    const a=tr.querySelector(`.rep-amt[data-i="${i}"]`);
    if(d)p.repayments[i].date=d.value;
    if(a)p.repayments[i].amount=pn(a.value)||0;
  });
  p.elapsed=p.repayments.length; p.recovered=recovered(p);
  save();renderRepaymentTable(p);renderDetailSummary(p);renderAll();
}

/* ═══════════════════════════════
   RENDER
═══════════════════════════════ */
function renderTable(){
  const tb=document.getElementById('table-body'); tb.innerHTML='';
  if(!projects.length){ tb.innerHTML='<tr class="empty-row"><td colspan="8">案件がありません</td></tr>'; return; }
  projects.forEach(p=>{
    const d=debt(p), mf=mrFinal(p), rem=Math.max(0,p.months-p.elapsed), done=d<=0;
    const remColor=done?'remain-ok':rem<=2?'remain-urgent':'remain-warn';
    const tr=document.createElement('tr'); tr.dataset.id=p.id;
    tr.innerHTML=`
      <td class="num" style="color:var(--muted);font-size:.78rem">#${p.id}</td>
      <td style="font-weight:600;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name||'—')}</td>
      <td class="num" style="text-align:right"><span class="debt-val${done?' debt-zero':''}">${done?'完済':fmt(d)}</span></td>
      <td class="num" style="text-align:right">${fmt(mf)}<span style="font-size:.7rem;color:var(--muted)">/月</span></td>
      <td class="count-cell">${p.elapsed}/${p.months}回<br><span class="remain-badge ${remColor}">${done?'完済':'残'+rem+'回'}</span></td>
      <td><input type="date" class="pay-date" data-id="${p.id}" value="${today()}" ${done?'disabled':''}/></td>
      <td><input type="text" class="pay-amt ci" data-id="${p.id}" placeholder="${Math.round(mf).toLocaleString('ja-JP')}" inputmode="numeric" ${done?'disabled':''}/></td>
      <td>
        <div class="row-btns">
          ${done?'':'<button class="btn-rec rec-btn" data-id="'+p.id+'">記録</button>'}
          <button class="btn-icon-sm" data-id="${p.id}" title="詳細" onclick="openDetail(${p.id})">📋</button>
          <button class="btn-icon-sm btn-del" data-id="${p.id}" title="削除" onclick="askDelete(${p.id})">🗑</button>
        </div>
      </td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll('.pay-amt').forEach(el=>{
    ci(el);
    el.addEventListener('keydown',e=>{ if(e.key==='Enter')recordPayment(+el.dataset.id); });
  });
  tb.querySelectorAll('.rec-btn').forEach(btn=>btn.addEventListener('click',()=>recordPayment(+btn.dataset.id)));
}

function renderSummary(){
  const s=(id,v)=>{ const el=document.getElementById(id); if(el)el.textContent=v; };
  if(!projects.length){
    ['sum-principal','sum-actual','sum-remaining','sum-recovered','sum-fee-profit','sum-cap-profit'].forEach(id=>s(id,'¥0'));
    s('sum-avg-rate','—'); s('sum-recovery-rate','0%'); return;
  }
  const totalP=projects.reduce((a,p)=>a+p.principal,0);
  const totalA=projects.reduce((a,p)=>a+(p.actualCost||p.principal),0);
  const totalD=projects.reduce((a,p)=>a+debt(p),0);
  const totalR=projects.reduce((a,p)=>a+recovered(p),0);
  const totalFP=projects.reduce((a,p)=>a+profit(p),0);
  const totalCP=projects.reduce((a,p)=>a+capProfit(p),0);
  const avgRate=projects.reduce((a,p)=>a+(p.rate||0),0)/projects.length;
  const sumTP=projects.reduce((a,p)=>a+totalPay(p),0);
  const avgRec=sumTP>0?Math.min((totalR/sumTP)*100,100):0;
  s('sum-principal',fmt(totalP)); s('sum-actual',fmt(totalA));
  s('sum-remaining',fmt(totalD)); s('sum-recovered',fmt(totalR));
  s('sum-fee-profit',fmt(totalFP)); s('sum-cap-profit',fmt(totalCP));
  s('sum-avg-rate',fmtRate(avgRate)); s('sum-recovery-rate',pct(avgRec));
}

function renderAll(){ renderTable(); renderSummary(); }

/* ═══════════════════════════════
   JSON / CSV
═══════════════════════════════ */
function exportJSON(){
  if(!projects.length){ toast('データがありません','err'); return; }
  dlFile(JSON.stringify({projects,plans},null,2),`backup_${today()}.json`,'application/json');
  toast('JSONをダウンロードしました','ok');
}
function importJSON(file){
  if(!file)return;
  const r=new FileReader();
  r.onload=e=>{
    try{
      const d=JSON.parse(e.target.result);
      let np,nl;
      if(Array.isArray(d)){np=d;nl=plans;}else{np=d.projects||[];nl=d.plans||plans;}
      if(!Array.isArray(np))throw new Error('不正なデータ');
      if(!confirm(`${np.length}件を読み込みます。現在のデータを上書きしますか？`))return;
      projects=np.map(mg); if(Array.isArray(nl)&&nl.length)plans=nl;
      save();saveP();fillPlanSelects();renderAll();toast(`${projects.length}件を復元しました`,'ok');
    }catch(err){toast('読込エラー: '+err.message,'err');}
  };
  r.onerror=()=>toast('ファイル読込失敗','err');
  r.readAsText(file);
  document.getElementById('input-import-json').value='';
}
function exportCSV(){
  if(!projects.length){ toast('データがありません','err'); return; }
  const h=['ID','件名','元金','実費','手数料','月支払額','利率(%)','回収月数','回収済','累計回収','残債'];
  const rows=projects.map(p=>[p.id,`"${(p.name||'').replace(/"/g,'""')}"`,p.principal,p.actualCost||p.principal,Math.round(getFee(p)*p.months),Math.round(mrFinal(p)),p.rate,p.months,p.elapsed,Math.round(recovered(p)),Math.round(debt(p))]);
  dlFile('\uFEFF'+[h.join(','),...rows.map(r=>r.join(','))].join('\r\n'),`projects_${today()}.csv`,'text/csv;charset=utf-8;');
  toast('CSVをダウンロードしました','ok');
}

/* ═══════════════════════════════
   TOAST
═══════════════════════════════ */
let _tt=null;
function toast(msg,type=''){
  document.querySelector('.toast')?.remove(); clearTimeout(_tt);
  const el=Object.assign(document.createElement('div'),{className:`toast${type?' '+type:''}`,textContent:msg});
  document.body.appendChild(el);
  _tt=setTimeout(()=>{el.style.opacity='0';el.style.transition='opacity .3s';setTimeout(()=>el.remove(),300);},2600);
}

/* ═══════════════════════════════
   BIND
═══════════════════════════════ */
function bind(){
  // ヘッダー
  document.getElementById('btn-admin').addEventListener('click',openAdmin);
  document.getElementById('btn-export-json').addEventListener('click',exportJSON);
  document.getElementById('btn-export-csv').addEventListener('click',exportCSV);
  document.getElementById('input-import-json').addEventListener('change',e=>importJSON(e.target.files[0]));

  // 管理者
  document.getElementById('admin-close').addEventListener('click',closeAdmin);
  document.getElementById('modal-admin').addEventListener('click',e=>{ if(e.target===document.getElementById('modal-admin'))closeAdmin(); });
  document.getElementById('btn-add-plan').addEventListener('click',()=>{
    const colors=['#3fb950','#388bfd','#d29922','#f85149','#bc8cff','#58a6ff'];
    plans.push({id:nextPid(),name:`プラン${String.fromCharCode(65+plans.length)}`,rate:20,color:colors[plans.length%colors.length]});
    saveP();renderPlans();fillPlanSelects();
  });

  // パネルタブ切り替え
  document.querySelectorAll('.ptab').forEach(tab=>{
    tab.addEventListener('click',()=>{
      document.querySelectorAll('.ptab').forEach(t=>t.classList.remove('active'));
      document.querySelectorAll('.panel-body').forEach(b=>b.classList.add('hidden'));
      tab.classList.add('active');
      document.getElementById(`body-${tab.dataset.ptab}`).classList.remove('hidden');
    });
  });

  // 新規追加
  document.getElementById('btn-add').addEventListener('click',addProject);
  document.getElementById('add-recovery-type').addEventListener('change',()=>{
    const t=document.getElementById('add-recovery-type').value;
    document.getElementById('wrap-months').classList.toggle('hidden',t!=='months');
    document.getElementById('wrap-monthly').classList.toggle('hidden',t!=='monthly');
    updatePreview();
  });
  ['add-principal','add-actual','add-months','add-monthly','add-round','add-plan'].forEach(id=>{
    document.getElementById(id)?.addEventListener('input',updatePreview);
    document.getElementById(id)?.addEventListener('change',updatePreview);
  });
  ['add-name','add-principal','add-actual','add-months','add-monthly'].forEach(id=>{
    document.getElementById(id)?.addEventListener('keydown',e=>{ if(e.key==='Enter')addProject(); });
  });

  // 追加投資
  document.getElementById('btn-funds').addEventListener('click',addFunds);
  ['funds-id','funds-amount','funds-actual'].forEach(id=>{
    document.getElementById(id)?.addEventListener('keydown',e=>{ if(e.key==='Enter')addFunds(); });
  });

  // 削除
  document.getElementById('modal-delete-confirm').addEventListener('click',doDelete);
  document.getElementById('modal-delete-cancel').addEventListener('click',closeDelete);
  document.getElementById('modal-delete').addEventListener('click',e=>{ if(e.target===document.getElementById('modal-delete'))closeDelete(); });

  // 返済条件変更モーダル
  document.getElementById('shortage-confirm').addEventListener('click',applyShortage);
  document.getElementById('shortage-cancel').addEventListener('click',()=>{ closeShortage(); toast('キャンセルしました'); });
  document.getElementById('shortage-close').addEventListener('click',()=>{ closeShortage(); toast('キャンセルしました'); });
  document.getElementById('modal-shortage').addEventListener('click',e=>{ if(e.target===document.getElementById('modal-shortage')){ closeShortage(); toast('キャンセルしました'); } });

  // ラジオ切り替え
  function updateWrap(){
    const v=document.querySelector('input[name="shortage-action"]:checked')?.value;
    document.getElementById('shortage-months-wrap').classList.toggle('hidden',v!=='months');
    document.getElementById('shortage-monthly-wrap').classList.toggle('hidden',v!=='monthly');
    updateShortagePreview();
  }
  document.querySelectorAll('input[name="shortage-action"]').forEach(r=>{
    r.addEventListener('change',updateWrap);
    r.addEventListener('click',updateWrap);
  });
  document.querySelectorAll('.shortage-options .radio-opt, .radio-col .radio-opt').forEach(lbl=>{
    lbl.addEventListener('click',()=>setTimeout(updateWrap,0));
  });
  ['shortage-new-months','shortage-new-monthly'].forEach(id=>{
    document.getElementById(id)?.addEventListener('input',updateShortagePreview);
  });
  ci(document.getElementById('shortage-new-monthly'));

  // 詳細
  document.getElementById('detail-close').addEventListener('click',closeDetail);
  document.getElementById('detail-close-btn').addEventListener('click',closeDetail);
  document.getElementById('modal-detail').addEventListener('click',e=>{ if(e.target===document.getElementById('modal-detail'))closeDetail(); });
  document.querySelectorAll('.dtab').forEach(t=>t.addEventListener('click',()=>switchTab(t.dataset.dtab)));
  document.getElementById('detail-plan-select').addEventListener('change',()=>{
    const p=projects.find(x=>x.id===detailId); if(!p)return;
    const pid=pn(document.getElementById('detail-plan-select').value);
    p.planId=pid||null;
    if(pid){ const nr=getRate(pid); p.rate=nr; p.fee=p.principal*(nr/100); const l=p.segments[p.segments.length-1]; if(l.startElapsed===p.elapsed)l.rate=nr; else p.segments.push({startElapsed:p.elapsed,rate:nr}); }
    save();renderDetailSummary(p);renderAll();toast('プランを変更しました','ok');
  });
  document.getElementById('detail-memo').addEventListener('blur',()=>{
    const p=projects.find(x=>x.id===detailId); if(!p)return;
    p.memo=document.getElementById('detail-memo').value; save();
  });
  document.getElementById('btn-apply-months').addEventListener('click',()=>{
    const p=projects.find(x=>x.id===detailId); if(!p)return;
    const nm=pn(document.getElementById('detail-months').value);
    if(!nm||nm<1){ toast('回数を入力してください','err'); return; }
    if(nm<=p.elapsed){ toast(`すでに${p.elapsed}回回収済みです。それより多い回数を入力してください`,'err'); return; }
    p.months=nm;
    // 新しい月数でfeeを再計算（fee = 新月支払に合わせて調整）
    // 元金・利率はそのまま、月数だけ変える → mrRaw = 元金/nm + fee
    // fee=元金×利率% は変えない → 月支払が自動で変わる
    p.fee=p.principal*(p.rate/100);
    save();renderDetailSummary(p);renderAll();
    toast(`回収回数を${nm}回に変更しました`,'ok');
  });
  document.getElementById('btn-add-repayment').addEventListener('click',()=>{
    const p=projects.find(x=>x.id===detailId); if(!p)return;
    if(!p.repayments)p.repayments=[];
    p.repayments.push({date:today(),amount:Math.round(mrFinal(p))});
    p.elapsed=p.repayments.length; p.recovered=recovered(p);
    save();renderRepaymentTable(p);renderDetailSummary(p);renderAll();
  });
}

/* ═══════════════════════════════
   INIT
═══════════════════════════════ */
function init(){
  load(); if(projects.length)save();
  const normal=plans.find(p=>p.name==='Normal');
  fillPlanSelects(normal?normal.id:null);
  renderAll(); bind(); initCI();
  document.getElementById('funds-date').value=today();
}

document.addEventListener('DOMContentLoaded',init);
