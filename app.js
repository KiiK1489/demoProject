/**
 * 経費回収トラッカー — app.js v7
 *
 * 残債 = 総回収見込み(mrFinal×months) - 累計回収額
 * 月進行廃止 → 一覧で直接日付+回収金額を入力して記録
 * 不足時は利益率/月数/月額を選んで再計算
 */
'use strict';

const STORAGE_KEY       = 'projects';
const PLANS_STORAGE_KEY = 'plans';
let projects = [];
let plans    = [];
let deleteTargetId  = null;
let detailProjectId = null;
let shortageContext = null; // 不足モーダル用

const DEFAULT_PLANS = [
  { id:1, name:'プランA', rate:20, color:'#6b91c8' },
  { id:2, name:'プランB', rate:25, color:'#3ecf8e' },
  { id:3, name:'プランC', rate:30, color:'#f5a623' },
];

/* ══════════════════════════════════════
   STORAGE
══════════════════════════════════════ */
function loadData() {
  try {
    const rp = localStorage.getItem(PLANS_STORAGE_KEY);
    plans = rp ? JSON.parse(rp) : [...DEFAULT_PLANS];
    if (!Array.isArray(plans)||!plans.length) plans=[...DEFAULT_PLANS];
  } catch(e){ plans=[...DEFAULT_PLANS]; }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw){ projects=[]; return; }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error();
    projects = parsed.map(migrate);
  } catch(e){ console.error(e); projects=[]; }
}

function migrate(p) {
  if (!p.segments)           p.segments      = [{startElapsed:0, rate:p.rate}];
  if (!p.memo)               p.memo          = '';
  if (p.actualCost==null)    p.actualCost    = p.principal;
  if (!p.startDate)          p.startDate     = todayStr();
  if (!p.deposits)           p.deposits      = [{date:p.startDate, amount:p.principal, actualAmount:p.actualCost, note:'初回入金（移行）'}];
  if (!p.repayments)         p.repayments    = [];
  if (!p.shortageMode)       p.shortageMode  = 'extend';
  if (p.shortageAccum==null) p.shortageAccum = 0;
  if (p.planId===undefined)  p.planId        = null;
  if (!p.roundUnit)          p.roundUnit     = 10000;
  if (p.virtualCost==null)   p.virtualCost   = 0;
  return p;
}

function saveData() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(projects)); }
  catch(e){ showToast('保存に失敗しました','error'); }
}
function savePlans() {
  try { localStorage.setItem(PLANS_STORAGE_KEY, JSON.stringify(plans)); }
  catch(e){ showToast('プランの保存に失敗しました','error'); }
}

/* ══════════════════════════════════════
   UTILS
══════════════════════════════════════ */
function genId()     { return projects.length===0?1:Math.max(...projects.map(p=>p.id))+1 }
function genPlanId() { return plans.length===0?1:Math.max(...plans.map(p=>p.id))+1 }

function parseNum(v) {
  if (v==null) return null;
  const n=parseFloat(String(v).replace(/,/g,''));
  return isNaN(n)?null:n;
}
function ok(v,label,positive=true) {
  const fail=positive?(v===null||v<=0):(v===null||v<0);
  if(fail){showToast(`「${label}」に${positive?'正の':'0以上の'}数を入力してください`,'error');return false;}
  return true;
}
function fmt(n)  { return '¥'+Math.round(n).toLocaleString('ja-JP') }
function pct(n)  { return n.toFixed(1)+'%' }
function todayStr() {
  const d=new Date();
  return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`;
}
function z(n){ return String(n).padStart(2,'0') }
function fmtDate(s){
  if(!s) return '—';
  const [y,m,d]=s.split('-'); return `${y}/${m}/${d}`;
}
function dlFile(content,name,mime){
  const a=Object.assign(document.createElement('a'),{href:URL.createObjectURL(new Blob([content],{type:mime})),download:name});
  document.body.appendChild(a);a.click();document.body.removeChild(a);
}
function ceilTo(v,u){ if(!u||u<=1)return Math.ceil(v); return Math.ceil(v/u)*u; }

/* ── カンマ入力 ── */
function initCI(el) {
  function ap(){
    const raw=el.value.replace(/[^0-9]/g,'');
    if(!raw){el.value='';return;}
    const n=parseInt(raw,10);
    el.value=isNaN(n)?'':n.toLocaleString('ja-JP');
    try{const l=el.value.length;el.setSelectionRange(l,l);}catch(e){}
  }
  el.addEventListener('input',ap);
  el.addEventListener('compositionend',ap);
  el.addEventListener('blur',ap);
  el.addEventListener('focus',()=>setTimeout(()=>el.select(),0));
}
function cv(id){ return parseNum(document.getElementById(id)?.value) }

/* ══════════════════════════════════════
   計算
══════════════════════════════════════ */
/** 月元本 = 元金 ÷ 月数 */
function mr(p)  { return p.months?p.principal/p.months:0 }
/** 切り上げ前月回収額 = 月元本 × (1 + 利益率%) */
function mrRaw(p){ return p.months?(p.principal/p.months)*(1+p.rate/100):0 }
/** 切り上げ後月回収額 */
function mrFinal(p){ const u=(p.roundUnit>0)?p.roundUnit:10000; return ceilTo(mrRaw(p),u); }
/** 見込み利益 = mrFinal × months - 元金 */
function expectedProfit(p){ return mrFinal(p)*p.months-p.principal; }
/** 総回収見込み = mrFinal × months */
function expectedTotal(p){ return mrFinal(p)*p.months; }
/** 残債 = 総回収見込み - 累計回収額 */
function calcDebt(p){ return Math.max(0, expectedTotal(p)-calcRecovered(p)); }

/** 累計回収額 */
function calcRecovered(p){
  if(p.repayments&&p.repayments.length>0)
    return p.repayments.reduce((s,r)=>s+(r.amount||0),0);
  return p.recovered||0;
}

/**
 * 累計利益 = (mrFinal - 月元本) × 回収済み回数
 *
 * 月元本 = 元金 ÷ 月数
 * 利益/回 = 切り上げ後月回収額 - 月元本
 * 累計利益 = 利益/回 × elapsed
 *
 * プラン変更（セグメント）がある場合は
 * セグメントごとに mrFinal を再計算して積算
 */
function calcProfit(p){
  if(!p.elapsed) return 0;
  const monthlyBase = mr(p); // 月元本（元金÷月数）
  let total = 0;
  for(let i=0;i<p.segments.length;i++){
    const seg      = p.segments[i];
    const nextStart= i+1<p.segments.length ? p.segments[i+1].startElapsed : p.elapsed;
    const segMonths= Math.max(0, nextStart - seg.startElapsed);
    if(segMonths===0) continue;
    // このセグメントの月回収額を計算（元金・月数・利益率・切り上げ単位を使用）
    const segRaw   = monthlyBase * (1 + seg.rate/100);
    const segFinal = ceilTo(segRaw, p.roundUnit||10000);
    // 利益/回 = mrFinal - 月元本
    total += (segFinal - monthlyBase) * segMonths;
  }
  return total;
}

/* ══════════════════════════════════════
   プラン
══════════════════════════════════════ */
function getPlan(id)     { return plans.find(p=>p.id===id)||null }
function getPlanRate(id) { const pl=getPlan(id); return pl?pl.rate:0 }

function planBadgeHtml(planId){
  const plan=getPlan(planId);
  if(!plan) return '<span style="color:var(--text-muted);font-size:.78rem">—</span>';
  const bg=plan.color+'22';
  return `<span class="plan-badge" style="color:${plan.color};background:${bg};border-color:${plan.color}">${escHtml(plan.name)}</span>`;
}

function populatePlanSelects(selectedId=null){
  ['add-plan','detail-plan-select'].forEach(id=>{
    const sel=document.getElementById(id); if(!sel) return;
    const cur=selectedId!==null?selectedId:(parseNum(sel.value)||null);
    sel.innerHTML='<option value="">— プランなし —</option>';
    plans.forEach(plan=>{
      const opt=document.createElement('option');
      opt.value=plan.id; opt.textContent=plan.name;
      if(cur===plan.id) opt.selected=true;
      sel.appendChild(opt);
    });
  });
}

/* ══════════════════════════════════════
   管理者
══════════════════════════════════════ */
function openAdmin(){ renderPlanList(); document.getElementById('modal-admin').classList.remove('hidden'); }
function closeAdmin(){ document.getElementById('modal-admin').classList.add('hidden'); }

function renderPlanList(){
  const container=document.getElementById('plan-list');
  container.innerHTML='';
  if(!plans.length){ container.innerHTML='<p style="color:var(--text-muted);font-size:.85rem;padding:8px">プランがありません。</p>'; return; }
  plans.forEach((plan,i)=>{
    const row=document.createElement('div'); row.className='plan-row';
    row.innerHTML=`
      <input type="text" class="plan-name-input" value="${escAttr(plan.name)}" data-i="${i}"/>
      <input type="number" class="plan-rate-input" value="${plan.rate}" min="0" step="0.1" inputmode="decimal" data-i="${i}" title="利益率(%)"/>
      <input type="color" class="color-swatch" value="${plan.color}" data-i="${i}"/>
      <button class="plan-del-btn" data-i="${i}">🗑</button>`;
    container.appendChild(row);
  });
  container.querySelectorAll('.plan-name-input').forEach(el=>{
    el.addEventListener('blur',()=>{ plans[Number(el.dataset.i)].name=el.value.trim()||plans[Number(el.dataset.i)].name; savePlans();populatePlanSelects();renderAll(); });
    el.addEventListener('keydown',e=>{ if(e.key==='Enter') el.blur(); });
  });
  container.querySelectorAll('.plan-rate-input').forEach(el=>{
    el.addEventListener('blur',()=>{
      const i=Number(el.dataset.i); const val=parseNum(el.value);
      if(val!==null&&val>=0){
        plans[i].rate=val;
        projects.forEach(p=>{ if(p.planId===plans[i].id){ p.rate=val; const last=p.segments[p.segments.length-1]; if(last.startElapsed===p.elapsed) last.rate=val; else p.segments.push({startElapsed:p.elapsed,rate:val}); } });
        savePlans();saveData();renderAll();
      } else el.value=plans[i].rate;
    });
    el.addEventListener('keydown',e=>{ if(e.key==='Enter') el.blur(); });
  });
  container.querySelectorAll('.color-swatch').forEach(el=>{
    el.addEventListener('input',()=>{ plans[Number(el.dataset.i)].color=el.value; savePlans();renderAll(); });
  });
  container.querySelectorAll('.plan-del-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const i=Number(btn.dataset.i); const planId=plans[i].id;
      if(!confirm(`プラン「${plans[i].name}」を削除しますか？`)) return;
      plans.splice(i,1);
      projects.forEach(p=>{ if(p.planId===planId) p.planId=null; });
      savePlans();saveData();renderPlanList();populatePlanSelects();renderAll();
      showToast('プランを削除しました');
    });
  });
}

/* ══════════════════════════════════════
   月回収額プレビュー
══════════════════════════════════════ */
function updateMonthlyPreview(){
  const principal   = cv('add-principal');
  const roundUnit   = parseNum(document.getElementById('add-round').value)||10000;
  const recovType   = document.getElementById('add-recovery-type').value;
  const preview     = document.getElementById('monthly-preview');
  const previewVal  = document.getElementById('monthly-preview-val');
  const previewMon  = document.getElementById('monthly-preview-months');
  if(!principal||principal<=0){ preview.classList.add('hidden'); return; }

  const virtualCost  = cv('add-actual')||0;
  const totalPrincipal = principal + (virtualCost>0?virtualCost:0);
  const planId       = parseNum(document.getElementById('add-plan').value);
  const rate         = planId?getPlanRate(planId):0;

  let monthlyRaw, months;
  if(recovType==='months'){
    months = parseNum(document.getElementById('add-months').value);
    if(!months||months<=0){ preview.classList.add('hidden'); return; }
    monthlyRaw = (totalPrincipal/months)*(1+rate/100);
  } else {
    const mon = cv('add-monthly');
    if(!mon||mon<=0){ preview.classList.add('hidden'); return; }
    monthlyRaw = mon*(1+rate/100);
    months = Math.ceil(totalPrincipal/mon);
  }

  const ceiledMonthly = ceilTo(monthlyRaw, roundUnit);
  const expProfit     = ceiledMonthly*months - totalPrincipal;
  previewVal.textContent = fmt(ceiledMonthly);
  previewMon.textContent = `${months}ヶ月 ｜ 切上前: ${fmt(monthlyRaw)} ｜ 見込み利益: ${fmt(expProfit)}`;
  preview.classList.remove('hidden');
}

/* ══════════════════════════════════════
   新規追加
══════════════════════════════════════ */
let addMode = 'months';

function addProject(){
  const principal  = cv('add-principal');
  const actualCost = cv('add-actual');
  const planId     = parseNum(document.getElementById('add-plan').value);
  const roundUnit  = parseNum(document.getElementById('add-round').value)||10000;
  const recovType  = document.getElementById('add-recovery-type').value;
  const memo       = document.getElementById('add-memo').value.trim();

  if(!ok(principal,'元金')) return;

  const rate         = planId?getPlanRate(planId):0;
  const virtualCost  = (!actualCost||actualCost<=0)?0:actualCost;
  const totalPrincipal = principal+virtualCost;

  let months, monthlyFinal;
  if(recovType==='months'){
    const m=parseNum(document.getElementById('add-months').value);
    if(!ok(m,'回収月数')) return;
    const rawMonthly=(totalPrincipal/m)*(1+rate/100);
    monthlyFinal=ceilTo(rawMonthly,roundUnit);
    months=m;
  } else {
    const mon=cv('add-monthly');
    if(!ok(mon,'月元本回収額')) return;
    if(mon>totalPrincipal){ showToast('月回収額が元金を超えています','error'); return; }
    const rawMonthly=mon*(1+rate/100);
    monthlyFinal=ceilTo(rawMonthly,roundUnit);
    months=Math.ceil(totalPrincipal/mon);
  }

  const p={
    id:genId(), principal:totalPrincipal, virtualCost, actualCost:principal,
    months, rate, elapsed:0, recovered:0,
    memo, startDate:todayStr(), planId:planId||null, roundUnit,
    segments:[{startElapsed:0,rate}],
    deposits:[{date:todayStr(),amount:totalPrincipal,actualAmount:principal,note:'初回入金'}],
    repayments:[], shortageMode:'extend', shortageAccum:0
  };
  projects.push(p);
  saveData(); renderAll();

  ['add-principal','add-actual','add-months','add-monthly','add-memo'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.value='';
  });
  document.getElementById('monthly-preview').classList.add('hidden');
  showToast(`案件 #${p.id} を追加しました`,'success');
}

/* ══════════════════════════════════════
   追加投資
══════════════════════════════════════ */
function addFunds(){
  const id     = parseNum(document.getElementById('funds-id').value);
  const amount = cv('funds-amount');
  const actual = cv('funds-actual');
  const date   = document.getElementById('funds-date').value||todayStr();
  const mode   = document.querySelector('input[name="funds-mode"]:checked').value;

  if(!ok(id,'案件ID'))     return;
  if(!ok(amount,'追加元金')) return;

  const p=projects.find(x=>x.id===id);
  if(!p){ showToast(`ID ${id} の案件が見つかりません`,'error'); return; }

  const actualAdd=(!actual||actual<=0)?0:actual;
  const prevMonthlyFinal = mrFinal(p); // 追加前の切り上げ後月額（固定）
  p.principal  += amount;
  p.virtualCost = (p.virtualCost||0)+actualAdd;
  p.actualCost  = p.principal - p.virtualCost;
  if(mode==='extend'){
    // 月額固定で月数を再計算
    // 月元本 = 切り上げ後月額 / (1 + rate/100)
    const monthlyPrincipalPart = prevMonthlyFinal / (1 + p.rate/100);
    p.months = Math.ceil(p.principal / monthlyPrincipalPart);
  }
  // 'increase': months 変えない → mrFinal が自動で増える

  if(!p.deposits) p.deposits=[];
  p.deposits.push({date,amount,actualAmount:amount-actualAdd,note:'追加投資'});
  saveData(); renderAll();

  ['funds-id','funds-amount','funds-actual'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
  document.getElementById('funds-date').value=todayStr();
  showToast(`案件 #${id} に追加投資を反映しました`,'success');
}

/* ══════════════════════════════════════
   回収記録（一覧から直接入力）
══════════════════════════════════════ */
function recordPayment(id){
  const p=projects.find(x=>x.id===id); if(!p) return;

  const dateEl = document.querySelector(`.pay-date-input[data-id="${id}"]`);
  const amtEl  = document.querySelector(`.pay-amount-input[data-id="${id}"]`);

  const date   = dateEl?.value || todayStr();
  const amount = parseNum(amtEl?.value?.replace(/,/g,''));

  if(!ok(amount,'回収金額')) return;
  if(amount<=0){ showToast('回収金額は1以上を入力してください','error'); return; }

  const expected = mrFinal(p);
  const debt     = calcDebt(p);

  if(amount>debt){ showToast(`回収金額が残債(${fmt(debt)})を超えています`,'error'); return; }

  // 回収履歴に追加
  if(!p.repayments) p.repayments=[];
  p.repayments.push({date, amount});
  p.elapsed++;
  p.recovered=calcRecovered(p);

  // 想定より少ない場合 → 不足モーダルを表示
  if(amount < expected && calcDebt(p) > 0){
    shortageContext={id, amount, expected, shortage: expected-amount};
    openShortageModal(p);
  } else {
    saveData(); renderAll();
    showToast(`案件 #${id} 回収を記録しました（${fmt(amount)}）`,'success');
  }

  if(amtEl) amtEl.value='';
}

/* ══════════════════════════════════════
   不足モーダル
══════════════════════════════════════ */
function openShortageModal(p){
  const {expected, shortage} = shortageContext;
  document.getElementById('shortage-info').innerHTML =
    `想定回収額: <strong>${fmt(expected)}</strong><br>
     実際の回収額: <strong>${fmt(shortageContext.amount)}</strong><br>
     不足額: <strong>${fmt(shortage)}</strong>`;
  // デフォルト選択をプロジェクト設定に合わせる
  const radio = document.querySelector(`input[name="shortage-action"][value="${p.shortageMode||'extend'}"]`);
  if(radio) radio.checked=true;
  document.getElementById('shortage-rate-wrap').classList.add('hidden');
  document.getElementById('shortage-new-rate').value = p.rate;
  document.getElementById('modal-shortage').classList.remove('hidden');
}

function applyShortage(){
  if(!shortageContext) return;
  const {id, shortage} = shortageContext;
  const p=projects.find(x=>x.id===id); if(!p) return;

  const action = document.querySelector('input[name="shortage-action"]:checked').value;

  // ★ 元金増加前に月額を固定（増加後に計算すると月額が変わってしまう）
  const fixedMonthlyFinal = mrFinal(p); // この時点の切り上げ後月額を固定

  if(action==='extend'){
    // ── 月額固定・回収回数を増やす ──
    // 不足分のうち利息相当のみ元金に加算（実費・仮想元金は変えない）
    const rawRate       = mrRaw(p)>0 ? (mrRaw(p)-mr(p))/mrRaw(p) : 0;
    const interestShort = shortage * rawRate;
    p.principal     += interestShort;
    p.shortageAccum += interestShort;
    // 月額固定 → 月数を再計算
    const monthlyPrincipalPart = fixedMonthlyFinal / (1 + p.rate/100);
    p.months = Math.ceil(p.principal / monthlyPrincipalPart);
    p.shortageMode = 'extend';

  } else if(action==='rate'){
    // ── 利益率を変更して再計算 ──
    const newRate = parseNum(document.getElementById('shortage-new-rate').value);
    if(newRate===null||newRate<0){ showToast('利益率を入力してください','error'); return; }
    const last=p.segments[p.segments.length-1];
    if(last.startElapsed===p.elapsed) last.rate=newRate;
    else p.segments.push({startElapsed:p.elapsed, rate:newRate});
    p.rate   = newRate;
    p.planId = null;
    // 月額固定で月数を再計算（利益率が変わっても月額上限は同じ）
    const monthlyPrincipalPart = fixedMonthlyFinal / (1 + newRate/100);
    p.months = Math.ceil(p.principal / monthlyPrincipalPart);
  }
  // 'none': 何もしない（記録のみ）

  saveData(); renderAll();
  closeShortage();
  showToast(`案件 #${id} の調整を適用しました`,'success');
}

function closeShortage(){
  document.getElementById('modal-shortage').classList.add('hidden');
  shortageContext=null;
}

/* ══════════════════════════════════════
   利益率変更
══════════════════════════════════════ */
function changeRate(id, newRate){
  const p=projects.find(x=>x.id===id); if(!p||newRate===p.rate||newRate<0) return;
  const last=p.segments[p.segments.length-1];
  if(last.startElapsed===p.elapsed) last.rate=newRate;
  else p.segments.push({startElapsed:p.elapsed,rate:newRate});
  p.rate=newRate;
  saveData(); renderSummary();
  showToast(`案件 #${id} の利益率を ${newRate}% に変更しました`,'success');
}

/* ══════════════════════════════════════
   削除
══════════════════════════════════════ */
function requestDelete(id){
  deleteTargetId=id;
  document.getElementById('modal-delete-text').textContent=`案件 #${id} を削除しますか？`;
  document.getElementById('modal-delete').classList.remove('hidden');
}
function confirmDelete(){
  if(deleteTargetId===null) return;
  const id=deleteTargetId;
  projects=projects.filter(p=>p.id!==id);
  saveData();renderAll();closeDelete();
  showToast(`案件 #${id} を削除しました`);
}
function closeDelete(){ document.getElementById('modal-delete').classList.add('hidden'); deleteTargetId=null; }

/* ══════════════════════════════════════
   詳細モーダル
══════════════════════════════════════ */
function openDetail(id){
  const p=projects.find(x=>x.id===id); if(!p) return;
  detailProjectId=id;
  document.getElementById('detail-title').textContent=`案件 #${id}${p.memo?' — '+p.memo:''}`;
  const sm=document.querySelector(`input[name="shortage-mode"][value="${p.shortageMode||'extend'}"]`);
  if(sm) sm.checked=true;
  populatePlanSelects(p.planId);
  document.getElementById('detail-plan-select').value=p.planId||'';
  // サマリータブを初期表示
  switchDetailTab('summary');
  renderDetailSummary(p);
  renderDepositTable(p);
  renderRepaymentTable(p);
  document.getElementById('modal-detail').classList.remove('hidden');
}

function switchDetailTab(name){
  document.querySelectorAll('.detail-tab').forEach(t=>t.classList.toggle('active', t.dataset.dtab===name));
  document.querySelectorAll('.detail-tab-pane').forEach(p=>p.classList.toggle('hidden', p.id!==`dtab-${name}`));
}
function closeDetail(){ document.getElementById('modal-detail').classList.add('hidden'); detailProjectId=null; }

function renderDetailSummary(p){
  const rec      = calcRecovered(p);
  const debt     = calcDebt(p);
  const recRate  = expectedTotal(p)>0?Math.min((rec/expectedTotal(p))*100,100):0;
  const profit   = calcProfit(p);
  // 実費 = 最初に入力した元金（不足利息加算で元金が増えても実費は変わらない）
  const realCost = p.actualCost || (p.principal-(p.virtualCost||0));
  const remainM  = Math.max(0, p.months-p.elapsed);

  document.getElementById('ds-principal').textContent    = fmt(p.principal);
  document.getElementById('ds-actual').textContent       = fmt(Math.max(0,realCost));
  document.getElementById('ds-monthly').textContent      = fmt(mrRaw(p));
  document.getElementById('ds-monthly-final').textContent= fmt(mrFinal(p));
  document.getElementById('ds-total-months').textContent = `${p.months}回`;
  document.getElementById('ds-remain-months').textContent= `${remainM}回`;
  document.getElementById('ds-recovered').textContent    = fmt(rec);
  document.getElementById('ds-remaining').textContent    = fmt(debt);
  document.getElementById('ds-profit').textContent       = fmt(profit);
  document.getElementById('ds-rate').textContent         = pct(recRate);

  const bar=document.getElementById('ds-rate-bar');
  bar.style.width=recRate.toFixed(1)+'%';
  bar.className='ds-rate-bar-fill'+(recRate>=70?'':recRate>=30?' mid':' low');

  document.getElementById('ds-expected-profit').textContent = fmt(expectedProfit(p));
  document.getElementById('ds-expected-total').textContent  = fmt(expectedTotal(p));

  const shRow=document.getElementById('ds-shortage-row');
  if(p.shortageAccum>0){
    shRow.classList.remove('hidden');
    document.getElementById('ds-shortage').textContent=fmt(p.shortageAccum);
  } else shRow.classList.add('hidden');
}

/* ── 入金履歴 ── */
function renderDepositTable(p){
  const tbody=document.getElementById('deposit-tbody');
  tbody.innerHTML='';
  if(!p.deposits||!p.deposits.length){
    tbody.innerHTML='<tr><td colspan="5" style="text-align:center;padding:16px;color:var(--text-muted)">履歴なし</td></tr>';
    return;
  }
  p.deposits.forEach((d,i)=>{
    const tag=i===0?'<span class="tag-init">初回</span>':'<span class="tag-add">追加</span>';
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td><input type="date" class="h-input dep-date" value="${d.date||''}" data-i="${i}"/></td>
      <td><input type="text" class="h-input amount dep-amount" value="${Math.round(d.amount||0).toLocaleString('ja-JP')}" inputmode="numeric" data-i="${i}"/></td>
      <td><input type="text" class="h-input amount dep-actual" value="${Math.round(d.actualAmount||d.amount||0).toLocaleString('ja-JP')}" inputmode="numeric" data-i="${i}"/></td>
      <td><div style="display:flex;gap:6px;align-items:center">${tag}<input type="text" class="h-input memo-h dep-note" value="${escAttr(d.note||'')}" placeholder="メモ" data-i="${i}"/></div></td>
      <td><button class="h-del-btn dep-del" data-i="${i}">🗑</button></td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.dep-amount,.dep-actual').forEach(el=>initCI(el));
  tbody.querySelectorAll('.dep-date,.dep-amount,.dep-actual,.dep-note').forEach(el=>{
    el.addEventListener('blur',()=>saveDepositEdit(p));
    el.addEventListener('change',()=>saveDepositEdit(p));
  });
  tbody.querySelectorAll('.dep-del').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const i=Number(btn.dataset.i);
      if(p.deposits.length<=1){showToast('最低1件必要です','error');return;}
      p.deposits.splice(i,1); recalcFromDeposits(p);
      saveData();renderDepositTable(p);renderDetailSummary(p);renderAll();
    });
  });
}
function saveDepositEdit(p){
  const tbody=document.getElementById('deposit-tbody');
  tbody.querySelectorAll('tr').forEach((tr,i)=>{
    if(!p.deposits[i]) return;
    const d=tr.querySelector(`.dep-date[data-i="${i}"]`);
    const a=tr.querySelector(`.dep-amount[data-i="${i}"]`);
    const ac=tr.querySelector(`.dep-actual[data-i="${i}"]`);
    const n=tr.querySelector(`.dep-note[data-i="${i}"]`);
    if(d)  p.deposits[i].date         = d.value;
    if(a)  p.deposits[i].amount       = parseNum(a.value)||0;
    if(ac) p.deposits[i].actualAmount = parseNum(ac.value)||0;
    if(n)  p.deposits[i].note         = n.value;
  });
  recalcFromDeposits(p); saveData(); renderDetailSummary(p); renderAll();
}

/* ── 回収履歴 ── */
function renderRepaymentTable(p){
  const tbody=document.getElementById('repayment-tbody');
  tbody.innerHTML='';
  if(!p.repayments||!p.repayments.length){
    tbody.innerHTML='<tr><td colspan="6" style="text-align:center;padding:16px;color:var(--text-muted)">履歴なし</td></tr>';
    return;
  }
  const expected=mrFinal(p);
  p.repayments.forEach((r,i)=>{
    const diff=(r.amount||0)-expected;
    const dc=diff>=0?'surplus':'deficit';
    const ds=diff>=0?`+${fmt(diff)}`:fmt(diff);
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td style="color:var(--text-muted);font-size:.8rem;font-family:var(--font-body)">${i+1}</td>
      <td><input type="date" class="h-input rep-date" value="${r.date||''}" data-i="${i}"/></td>
      <td><input type="text" class="h-input amount rep-amount" value="${Math.round(r.amount||0).toLocaleString('ja-JP')}" inputmode="numeric" data-i="${i}"/></td>
      <td style="font-size:.82rem">${fmt(expected)}</td>
      <td class="${dc}" style="font-size:.82rem">${ds}</td>
      <td><button class="h-del-btn rep-del" data-i="${i}">🗑</button></td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.rep-amount').forEach(el=>initCI(el));
  tbody.querySelectorAll('.rep-date,.rep-amount').forEach(el=>{
    el.addEventListener('blur',()=>saveRepaymentEdit(p));
    el.addEventListener('change',()=>saveRepaymentEdit(p));
  });
  tbody.querySelectorAll('.rep-del').forEach(btn=>{
    btn.addEventListener('click',()=>{
      p.repayments.splice(Number(btn.dataset.i),1);
      p.elapsed=p.repayments.length;
      p.recovered=calcRecovered(p);
      saveData();renderRepaymentTable(p);renderDetailSummary(p);renderAll();
    });
  });
}
function saveRepaymentEdit(p){
  const tbody=document.getElementById('repayment-tbody');
  tbody.querySelectorAll('tr').forEach((tr,i)=>{
    if(!p.repayments[i]) return;
    const d=tr.querySelector(`.rep-date[data-i="${i}"]`);
    const a=tr.querySelector(`.rep-amount[data-i="${i}"]`);
    if(d) p.repayments[i].date   = d.value;
    if(a) p.repayments[i].amount = parseNum(a.value)||0;
  });
  p.elapsed=p.repayments.length;
  p.recovered=calcRecovered(p);
  saveData();renderRepaymentTable(p);renderDetailSummary(p);renderAll();
}

/* ── 再計算 ── */
function recalcFromDeposits(p){
  if(!p.deposits||!p.deposits.length) return;
  p.principal  = p.deposits.reduce((s,d)=>s+(d.amount||0),0)+(p.shortageAccum||0);
  p.virtualCost= p.deposits.reduce((s,d)=>s+(d.amount||0),0) - p.deposits.reduce((s,d)=>s+(d.actualAmount||d.amount||0),0);
  p.actualCost = p.principal - (p.virtualCost||0);
}

/* ══════════════════════════════════════
   RENDER: メインテーブル
══════════════════════════════════════ */
function renderTable(){
  const tbody=document.getElementById('table-body');
  tbody.innerHTML='';
  if(!projects.length){
    tbody.innerHTML='<tr class="empty-row"><td colspan="9">案件がありません。上のフォームから追加してください。</td></tr>';
    return;
  }
  projects.forEach(p=>{
    const debt       = calcDebt(p);
    const mf         = mrFinal(p);
    const totalMths  = p.months;
    const remainMths = Math.max(0, p.months-p.elapsed);
    const isComplete = debt<=0;

    const tr=document.createElement('tr');
    tr.dataset.id=p.id;
    tr.innerHTML=`
      <td class="td-id col-id">#${p.id}</td>
      <td class="td-plan col-plan">${planBadgeHtml(p.planId)}</td>
      <td class="td-debt col-debt">
        <span class="debt-val${isComplete?' zero':''}">${isComplete?'完済':fmt(debt)}</span>
      </td>
      <td class="td-monthly col-monthly">${fmt(mf)}<span style="font-size:.7rem;color:var(--text-muted)">/月</span></td>
      <td class="td-count col-count">
        <span style="color:var(--text-primary)">${p.elapsed}</span>/${totalMths}回
        <span style="display:block;font-size:.72rem;color:${isComplete?'var(--green)':remainMths<=2?'var(--red)':'var(--amber)'}">残${remainMths}回</span>
      </td>
      <td class="td-date col-date">
        <input type="date" class="date-input pay-date-input" data-id="${p.id}" value="${todayStr()}" ${isComplete?'disabled':''}/>
      </td>
      <td class="td-pay col-pay">
        <input type="text" class="pay-input pay-amount-input comma-input-pay" data-id="${p.id}"
          placeholder="${fmt(mf).replace('¥','')}" inputmode="numeric" ${isComplete?'disabled':''}/>
      </td>
      <td class="td-memo col-memo">
        <input class="memo-input" type="text" value="${escAttr(p.memo)}" placeholder="備考…" data-id="${p.id}"/>
      </td>
      <td class="td-action col-action">
        <div class="row-actions">
          ${isComplete?'':'<button class="btn-record rec-btn" data-id="'+p.id+'">記録</button>'}
          <button class="btn-row btn-row-detail" data-id="${p.id}" title="詳細">📋</button>
          <button class="btn-row btn-row-del"    data-id="${p.id}" title="削除">🗑</button>
        </div>
      </td>`;
    tbody.appendChild(tr);
  });

  // 回収金額入力欄にカンマ処理
  tbody.querySelectorAll('.pay-amount-input').forEach(el=>{
    initCI(el);
    el.addEventListener('keydown',e=>{ if(e.key==='Enter') recordPayment(Number(el.dataset.id)); });
  });

  // 記録ボタン
  tbody.querySelectorAll('.rec-btn').forEach(btn=>{
    btn.addEventListener('click',()=>recordPayment(Number(btn.dataset.id)));
  });

  // 備考
  tbody.querySelectorAll('.memo-input').forEach(input=>{
    input.addEventListener('keydown',e=>{ if(e.key==='Enter') input.blur(); });
    input.addEventListener('blur',()=>{
      const id=Number(input.dataset.id);
      const p=projects.find(x=>x.id===id); if(!p||input.value===p.memo) return;
      p.memo=input.value; saveData();
    });
  });

  tbody.querySelectorAll('.btn-row-detail').forEach(btn=>btn.addEventListener('click',()=>openDetail(Number(btn.dataset.id))));
  tbody.querySelectorAll('.btn-row-del').forEach(btn    =>btn.addEventListener('click',()=>requestDelete(Number(btn.dataset.id))));
}

/* ══════════════════════════════════════
   RENDER: サマリー
══════════════════════════════════════ */
function renderSummary(){
  const ids=['sum-principal','sum-actual','sum-remaining','sum-recovered','sum-profit','sum-avg-rate'];
  if(!projects.length){ ids.forEach(id=>{ document.getElementById(id).textContent=id==='sum-avg-rate'?'0%':'¥0'; }); return; }
  const totalPrincipal = projects.reduce((a,p)=>a+p.principal,0);
  const totalActual    = projects.reduce((a,p)=>a+(p.actualCost||(p.principal-(p.virtualCost||0))),0);
  const totalDebt      = projects.reduce((a,p)=>a+calcDebt(p),0);
  const totalRecovered = projects.reduce((a,p)=>a+calcRecovered(p),0);
  const totalProfit    = projects.reduce((a,p)=>a+calcProfit(p),0);
  const totalExpected  = projects.reduce((a,p)=>a+expectedTotal(p),0);
  const avgRate        = totalExpected>0?Math.min((totalRecovered/totalExpected)*100,100):0;
  document.getElementById('sum-principal').textContent = fmt(totalPrincipal);
  document.getElementById('sum-actual').textContent    = fmt(totalActual);
  document.getElementById('sum-remaining').textContent = fmt(totalDebt);
  document.getElementById('sum-recovered').textContent = fmt(totalRecovered);
  document.getElementById('sum-profit').textContent    = fmt(totalProfit);
  document.getElementById('sum-avg-rate').textContent  = pct(avgRate);
}

function renderAll(){ renderTable(); renderSummary(); }

/* ══════════════════════════════════════
   JSON / CSV
══════════════════════════════════════ */
function exportJSON(){
  if(!projects.length){showToast('データがありません','error');return;}
  dlFile(JSON.stringify({projects,plans},null,2),`backup_${todayStr()}.json`,'application/json');
  showToast('JSONをダウンロードしました','success');
}
function importJSON(file){
  if(!file) return;
  const reader=new FileReader();
  reader.onload=e=>{
    try{
      const parsed=JSON.parse(e.target.result);
      let np,nl;
      if(Array.isArray(parsed)){np=parsed;nl=plans;}
      else{np=parsed.projects||[];nl=parsed.plans||plans;}
      if(!Array.isArray(np)) throw new Error('案件データが不正です');
      if(!confirm(`${np.length}件を読み込みます。現在のデータを上書きしますか？`)) return;
      projects=np.map(migrate);
      if(Array.isArray(nl)&&nl.length) plans=nl;
      saveData();savePlans();populatePlanSelects();renderAll();
      showToast(`${projects.length}件を復元しました`,'success');
    }catch(err){showToast('読み込みエラー: '+err.message,'error');}
  };
  reader.onerror=()=>showToast('ファイルの読み込みに失敗しました','error');
  reader.readAsText(file);
  document.getElementById('input-import-json').value='';
}
function exportCSV(){
  if(!projects.length){showToast('データがありません','error');return;}
  const heads=['ID','元金','実費','回収月数','月回収額(切上後)','プラン','回収回数','累計回収','残債','累計利益','見込み利益','総回収見込み','備考'];
  const rows=projects.map(p=>{
    const plan=getPlan(p.planId);
    return[p.id,p.principal,(p.actualCost||(p.principal-(p.virtualCost||0))),p.months,Math.round(mrFinal(p)),
      plan?plan.name:'',p.elapsed,Math.round(calcRecovered(p)),Math.round(calcDebt(p)),
      Math.round(calcProfit(p)),Math.round(expectedProfit(p)),Math.round(expectedTotal(p)),
      `"${(p.memo||'').replace(/"/g,'""')}"`];
  });
  const csv=[heads.join(','),...rows.map(r=>r.join(','))].join('\r\n');
  dlFile('\uFEFF'+csv,`projects_${todayStr()}.csv`,'text/csv;charset=utf-8;');
  showToast('CSVをダウンロードしました','success');
}

/* ══════════════════════════════════════
   TOAST
══════════════════════════════════════ */
let _tt=null;
function showToast(msg,type=''){
  document.querySelector('.toast')?.remove(); clearTimeout(_tt);
  const el=Object.assign(document.createElement('div'),{className:`toast${type?' '+type:''}`,textContent:msg});
  document.body.appendChild(el);
  _tt=setTimeout(()=>{ el.style.cssText='opacity:0;transition:opacity .3s ease'; setTimeout(()=>el.remove(),300); },2800);
}

/* ══════════════════════════════════════
   HELPERS
══════════════════════════════════════ */
function escHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
function escAttr(s){ return String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;') }

/* ══════════════════════════════════════
   TABS
══════════════════════════════════════ */
function initTabs(){
  document.querySelectorAll('.panel-tab').forEach(tab=>{
    tab.addEventListener('click',()=>{
      document.querySelectorAll('.panel-tab').forEach(t=>t.classList.remove('active'));
      document.querySelectorAll('.panel-body').forEach(b=>b.classList.add('hidden'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.remove('hidden');
    });
  });
}

/* ══════════════════════════════════════
   BIND EVENTS
══════════════════════════════════════ */
function bindEvents(){
  // 管理者
  document.getElementById('btn-admin').addEventListener('click',openAdmin);
  document.getElementById('admin-close').addEventListener('click',closeAdmin);
  document.getElementById('admin-close-btn').addEventListener('click',closeAdmin);
  document.getElementById('modal-admin').addEventListener('click',e=>{ if(e.target===document.getElementById('modal-admin')) closeAdmin(); });
  document.getElementById('btn-add-plan').addEventListener('click',()=>{
    const colors=['#6b91c8','#3ecf8e','#f5a623','#f06060','#a78bfa','#38bdf8','#fb7185','#34d399'];
    plans.push({id:genPlanId(),name:`プラン${String.fromCharCode(65+plans.length)}`,rate:20,color:colors[plans.length%colors.length]});
    savePlans();renderPlanList();populatePlanSelects();
  });

  // 新規追加
  document.getElementById('btn-add').addEventListener('click',addProject);
  document.getElementById('add-recovery-type').addEventListener('change',()=>{
    const t=document.getElementById('add-recovery-type').value;
    document.getElementById('wrap-months').classList.toggle('hidden',t!=='months');
    document.getElementById('wrap-monthly').classList.toggle('hidden',t!=='monthly');
    updateMonthlyPreview();
  });
  ['add-principal','add-months','add-monthly','add-round','add-plan','add-actual'].forEach(id=>{
    document.getElementById(id)?.addEventListener('input',updateMonthlyPreview);
    document.getElementById(id)?.addEventListener('change',updateMonthlyPreview);
  });

  // 追加投資
  document.getElementById('btn-funds').addEventListener('click',addFunds);

  // JSON/CSV
  document.getElementById('btn-export-json').addEventListener('click',exportJSON);
  document.getElementById('btn-export-csv').addEventListener('click',exportCSV);
  document.getElementById('input-import-json').addEventListener('change',e=>importJSON(e.target.files[0]));

  // 削除モーダル
  document.getElementById('modal-delete-confirm').addEventListener('click',confirmDelete);
  document.getElementById('modal-delete-cancel').addEventListener('click',closeDelete);
  document.getElementById('modal-delete').addEventListener('click',e=>{ if(e.target===document.getElementById('modal-delete')) closeDelete(); });

  // 不足モーダル
  document.getElementById('shortage-confirm').addEventListener('click',applyShortage);
  document.getElementById('shortage-cancel').addEventListener('click',()=>{ closeShortage(); saveData(); renderAll(); showToast('記録しました（調整なし）','success'); });
  document.getElementById('modal-shortage').addEventListener('click',e=>{ if(e.target===document.getElementById('modal-shortage')){ closeShortage(); saveData(); renderAll(); } });
  document.querySelectorAll('input[name="shortage-action"]').forEach(r=>{
    r.addEventListener('change',()=>{
      const isRate = r.value==='rate';
      document.getElementById('shortage-rate-wrap').classList.toggle('hidden',!isRate);
    });
  });

  // 詳細タブ切り替え
  document.querySelectorAll('.detail-tab').forEach(tab=>{
    tab.addEventListener('click',()=>switchDetailTab(tab.dataset.dtab));
  });

  // 詳細モーダル
  document.getElementById('detail-close').addEventListener('click',closeDetail);
  document.getElementById('detail-close-btn').addEventListener('click',closeDetail);
  document.getElementById('modal-detail').addEventListener('click',e=>{ if(e.target===document.getElementById('modal-detail')) closeDetail(); });
  document.getElementById('detail-plan-select').addEventListener('change',()=>{
    const p=projects.find(x=>x.id===detailProjectId); if(!p) return;
    const newPlanId=parseNum(document.getElementById('detail-plan-select').value);
    p.planId=newPlanId||null;
    if(newPlanId) changeRate(p.id,getPlanRate(newPlanId));
    saveData();renderAll();showToast('プランを変更しました','success');
  });
  document.getElementById('btn-add-deposit').addEventListener('click',()=>{
    const p=projects.find(x=>x.id===detailProjectId); if(!p) return;
    if(!p.deposits) p.deposits=[];
    p.deposits.push({date:todayStr(),amount:0,actualAmount:0,note:''});
    saveData();renderDepositTable(p);renderDetailSummary(p);
  });
  document.getElementById('btn-add-repayment').addEventListener('click',()=>{
    const p=projects.find(x=>x.id===detailProjectId); if(!p) return;
    if(!p.repayments) p.repayments=[];
    p.repayments.push({date:todayStr(),amount:Math.round(mrFinal(p))});
    p.elapsed=p.repayments.length; p.recovered=calcRecovered(p);
    saveData();renderRepaymentTable(p);renderDetailSummary(p);renderAll();
  });
  document.querySelectorAll('input[name="shortage-mode"]').forEach(r=>{
    r.addEventListener('change',()=>{
      const p=projects.find(x=>x.id===detailProjectId); if(!p) return;
      p.shortageMode=r.value; saveData();
    });
  });

  // Enterキー
  ['add-principal','add-actual','add-months','add-monthly','add-memo'].forEach(id=>{
    document.getElementById(id)?.addEventListener('keydown',e=>{ if(e.key==='Enter') addProject(); });
  });
  ['funds-id','funds-amount','funds-actual','funds-date'].forEach(id=>{
    document.getElementById(id)?.addEventListener('keydown',e=>{ if(e.key==='Enter') addFunds(); });
  });

  // カンマ入力
  ['add-principal','add-actual','add-monthly','funds-amount','funds-actual'].forEach(id=>{
    const el=document.getElementById(id); if(el) initCI(el);
  });
}

/* ══════════════════════════════════════
   INIT
══════════════════════════════════════ */
function init(){
  loadData();
  if(projects.length>0) saveData();
  populatePlanSelects();
  renderAll();
  initTabs();
  bindEvents();
  document.getElementById('funds-date').value=todayStr();
}

document.addEventListener('DOMContentLoaded',init);
