import { liveStation, ageLabel, sparkPath } from './collect-live.mjs';
import { createAdminClient, AdminError, beijingInput, parseBeijing, formatBeijing, exportChunk } from './collect-core.mjs';

const $ = id => document.getElementById(id);
const TABLES = [
  {node:'N3',name:'公桌 1',marker:'1',place:'左下 · 邻近实验室'},
  {node:'N2',name:'公桌 2',marker:'2',place:'中下 · 工位区中部'},
  {node:'N1',name:'公桌 3',marker:'3',place:'右下 · 邻近网络机房'},
  {node:'N5',name:'公桌 A',marker:'A',place:'左上 · 邻近卫生间'},
  {node:'N4',name:'公桌 B',marker:'B',place:'右上 · 邻近会议室'},
  {node:'D1',name:'工位 D1',marker:'D1',place:'公桌3右侧 · 东墙最南端'},
];
const names = Object.fromEntries(TABLES.map(table => [table.node,table.name]));
const num = value => Number(value || 0).toLocaleString('zh-CN');
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const planNames = {none:'未设置',waiting:'等待开始',recording:'正在采集',finished:'已结束'};
const actionNames = {overview:'读取观测总览',series:'读取声级曲线',count:'统计选定记录',suspects:'检查可疑数据',plan:'保存采集计划',exclude:'排除选定时段',unexclude:'撤销排除',export:'导出观测记录',purge:'核对与处理删除'};
let authenticated=false, state=null, currentTab='overview', statePending=false, busy=false, planDirty=false;
let series=null, selection=null, selectedNodes=new Set(TABLES.map(table=>table.node));
let dataLoaded=false, exportController=null, chartDrag=null;
let confirmResolve=null, confirmRequired='';
let lastRefreshAt=0, refreshFailed=false, sessionGeneration=0;

function operation(message, error=false) { $('operation-status').textContent=message; $('operation-status').hidden=!message; $('operation-status').dataset.error=String(error); }
const client=createAdminClient({onProgress:({action,status})=>operation((actionNames[action]||'操作')+' · '+(status==='running'?'采集端正在执行…':'已发送，等待采集端执行…'))});

function showLogin(message='') {
  authenticated=false;state=null;sessionGeneration++;$('login-panel').hidden=false;$('admin-app').hidden=true;$('logout').hidden=true;
  $('login-status').textContent=message;$('login-status').dataset.error=String(Boolean(message));
}
function errorMessage(error) {
  if(error?.name==='AbortError') return '已停止等待此查询。';
  if(error?.commandId && /fetch|network|网络|连接/i.test(error.message)) return '连接中断，操作可能已送达。请先刷新确认结果，勿重复提交。';
  return error?.message || '操作暂未完成，请稍后重试。';
}
function handleError(error) {
  if(error?.status===401){showLogin('登录已失效，请重新输入管理口令。');return;}
  operation(errorMessage(error),true);
}
function setBusy(value) {
  busy=value;
  document.querySelectorAll('[data-command]').forEach(button=>button.disabled=value||!state?.connected);
  $('logout').disabled=value;
  document.querySelectorAll('.collector-panel').forEach(panel=>panel.setAttribute('aria-busy',String(value)));
}
function requireOnline() { if(!state?.connected)throw new AdminError('采集电脑当前离线，恢复连接后可进行操作。'); }
async function perform(action,payload,{success='',signal}={}) {
  requireOnline();
  if(busy)throw new AdminError('请等待当前操作完成。');
  setBusy(true);
  try { const result=await client.command(action,payload,{signal});operation(success||'采集端已完成操作。');return result; }
  finally { setBusy(false); }
}

function confirmOperation(title,description,phrase='') {
  if(confirmResolve)confirmResolve(false);
  $('confirm-title').textContent=title;$('confirm-description').textContent=description;
  confirmRequired=phrase;$('confirm-phrase-area').hidden=!phrase;$('confirm-phrase').value='';
  $('confirm-phrase-help').textContent=phrase?'请输入 '+phrase+' 以确认。':'';
  $('confirm-accept').disabled=Boolean(phrase);
  $('confirm-dialog').showModal();
  return new Promise(resolve=>{confirmResolve=resolve;});
}
function resolveConfirmation(value) { const resolve=confirmResolve;confirmResolve=null;$('confirm-dialog').close();resolve?.(value); }
$('confirm-accept').addEventListener('click',()=>{if(!confirmRequired||$('confirm-phrase').value===confirmRequired)resolveConfirmation(true);});
$('confirm-cancel').addEventListener('click',()=>resolveConfirmation(false));
$('confirm-dialog').addEventListener('cancel',event=>{event.preventDefault();resolveConfirmation(false);});
$('confirm-phrase').addEventListener('input',()=>{$('confirm-accept').disabled=$('confirm-phrase').value!==confirmRequired;});

const monitorTime = new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
function renderMonitor() {
  if(!authenticated)return;
  const now=Date.now(),items=TABLES.map(table=>({table,...liveStation(state,table.node,now)}));
  const connected=items.some(item=>item.sourceFresh);
  $('connection-dot').dataset.online=String(connected);
  $('connection-title').textContent=connected?'采集端已连接':'采集端离线';
  $('connection-message').textContent=connected?'自动接收观测，读数按设备实际上传更新。':'连接中断，保留历史曲线，暂停显示实时数值。';
  $('last-sync').textContent=state?.receivedAt?'状态同步 '+monitorTime.format(new Date(state.receivedAt))+' · 北京时间':'尚未收到状态';
  $('online-count').textContent=items.filter(item=>item.online).length+' / '+TABLES.length;
  $('fresh-count').textContent=items.filter(item=>item.fresh).length+' / '+TABLES.length;
  $('monitor-clock').textContent=monitorTime.format(now)+' 北京时间';
  $('monitor-refresh').textContent=refreshFailed?'正在重连':statePending?'检查更新…':Math.max(0,5-Math.floor((now-lastRefreshAt)/1000))+' 秒后检查';
  const issues=items.filter(item=>!item.fresh);
  $('monitor-alert').hidden=!issues.length;
  $('monitor-alert').textContent=!connected?'采集端暂未连接。下方为已收到的历史数据，恢复连接后自动更新。':issues.map(item=>item.table.name+'：'+item.status).join('；');
  $('station-monitor').innerHTML=items.map(item=>{
    const {table,observation:obs}=item;
    const summary=(state?.overview?.nodes||[]).find(row=>row.node===table.node)||{};
    const recent=item.history.length>0;
    const last=Number.isFinite(obs.laeq)?obs.laeq.toFixed(1)+' dB(A)':'—';
    return `<article class="monitor-station" data-tone="${item.tone}" aria-label="${table.name}实时监测">
      <header><div class="monitor-name"><span class="station-marker">${table.marker}</span><div><h3>${table.name}</h3><span>${table.node}${table.node==='D1'?' · 个人工位':' · 声级节点'}</span></div></div><span class="monitor-status">${item.status}</span></header>
      <p class="monitor-place">${table.place}</p>
      <div class="monitor-reading"><strong>${item.value===null?'—':item.value.toFixed(1)}</strong><div><span>dB(A)</span><small>最新 1 秒 LAeq</small></div></div>
      <p class="sample-age">${Number.isFinite(item.age)?'数据 '+ageLabel(item.age)+(item.fresh?'':' · 上次 '+last):'等待第一条有效观测'}</p>
      <div class="monitor-spark"><svg viewBox="0 0 400 62" preserveAspectRatio="none" role="img" aria-label="${table.name}近五分钟声级曲线，统一30至90分贝刻度"><path class="spark-guide" d="M0,31 H400"/><path class="spark-line" d="${sparkPath(item.history,now)}"/></svg>${recent?'':'<span class="spark-empty">近 5 分钟暂无有效数据</span>'}</div>
      <div class="spark-axis"><span>5 分钟前</span><span>现在</span></div>
      <footer><div><span>5 分钟 LAeq</span><strong>${recent&&Number.isFinite(obs.windowLeq)?obs.windowLeq.toFixed(1):'—'} <small>dB(A)</small></strong></div><div><span>有效记录</span><strong>${num(summary.usable)} <small>条</small></strong></div><div><span>设备通信</span><strong class="communication-age">${ageLabel((now-Date.parse(item.ready.lastSeen))/1000)}</strong></div></footer>
    </article>`;
  }).join('');
}

function readinessFor(node) { return (state?.readiness||[]).find(item=>(item.node||item.id)===node)||{}; }
function currentPlan() {
  const plan=state?.plan||{};
  return {startMs:plan.startMs??state?.overview?.plan?.start??0,endMs:plan.endMs??state?.overview?.plan?.end??0,version:plan.version??0,state:plan.state||'none'};
}
function renderState() {
  const connected=Boolean(state?.connected),overview=state?.overview||{},plan=currentPlan();
  $('connection-dot').dataset.online=String(connected);
  $('connection-title').textContent=connected?'采集端已连接':'采集端离线';
  $('connection-message').textContent=connected?'远程操作会由采集电脑执行。':'请保持采集电脑开机联网，并运行接收程序。';
  $('last-sync').textContent=state?.receivedAt?'最近同步 '+formatBeijing(Date.parse(state.receivedAt)).slice(5):'尚未收到采集端状态';
  const online=TABLES.filter(table=>connected&&readinessFor(table.node).online).length;
  $('online-count').textContent=online+' / '+TABLES.length;
  $('usable-count').textContent=num((overview.nodes||[]).filter(node=>names[node.node]).reduce((sum,node)=>sum+(node.usable||0),0));
  $('plan-metric').textContent=planNames[plan.state]||'—';
  $('station-rows').innerHTML=TABLES.map(table=>{
    const info=readinessFor(table.node),summary=(overview.nodes||[]).find(item=>item.node===table.node)||{};
    const isOnline=connected&&info.online;
    const latest=typeof info.lastSeen==='number'?(info.lastSeen<1e12?info.lastSeen*1000:info.lastSeen):Date.parse(info.lastSeen);
    return `<tr><td><div class="station-identity"><span class="station-marker">${table.marker}</span><div><strong>${table.name}</strong><small>${table.node}</small></div></div></td><td>${table.place}</td><td><span class="${isOnline?'station-online':'station-offline'}">${isOnline?'在线':info.lastSeen?'离线':'待连接'}</span><small>${esc(info.message||'尚未连接过')}</small></td><td>${num(summary.usable)} 条可用<small>共 ${num(summary.count)} 条 · 排除 ${num(summary.excluded)} 条</small></td><td>${formatBeijing(latest,true)}</td></tr>`;
  }).join('');
  $('plan-state').textContent=planNames[plan.state]||'—';
  $('current-start').textContent=formatBeijing(plan.startMs,true);
  $('current-end').textContent=plan.startMs?(plan.endMs?formatBeijing(plan.endMs,true):'手动停止'):'—';
  if(!planDirty){$('plan-start').value=beijingInput(plan.startMs||Math.ceil((Date.now()+120000)/60000)*60000);$('plan-end').value=beijingInput(plan.endMs);}
  $('readiness-list').innerHTML=TABLES.map(table=>{
    const row=readinessFor(table.node),ready=connected&&row.online&&row.synced&&row.mic&&(row.planSynced??row.planReceived);
    return `<div class="readiness-item" data-ready="${Boolean(ready)}"><strong>${table.name} · ${table.node}</strong><span>${esc(row.message||'尚未连接')}</span></div>`;
  }).join('');
  const reasons=overview.reasons||['现场测试','设备异常','其他原因'];
  const selectedReason=$('exclude-reason').value;
  $('exclude-reason').replaceChildren(...reasons.map(reason=>new Option(reason,reason)));
  if(reasons.includes(selectedReason))$('exclude-reason').value=selectedReason;
  const nodeIds=[...TABLES.map(table=>table.node),...(overview.nodes||[]).map(node=>node.node).filter(node=>!names[node])];
  const checked=new Set(selectedNodes);
  $('data-nodes').innerHTML=nodeIds.map(node=>`<label><input type="checkbox" value="${esc(node)}" ${checked.has(node)?'checked':''}><span>${esc(names[node]||node)}</span><small>${esc(node)}</small></label>`).join('');
  $('data-nodes').querySelectorAll('input').forEach(input=>input.addEventListener('change',()=>{input.checked?selectedNodes.add(input.value):selectedNodes.delete(input.value);drawChart();updateSelectionDescription();}));
  renderExclusions();
  $('backup-summary').textContent=(overview.backups||[]).length?'最近本机备份：'+overview.backups.slice(0,3).map(item=>`${item.name}（${item.mb} MB）`).join('；'):'本机还没有列出的备份。';
  if(!$('range-start').value)chooseRange('all',false);
  setBusy(busy);
  renderMonitor();
}
async function refreshState(silent=false) {
  if(!authenticated||statePending||document.hidden)return;
  statePending=true;
  const generation=sessionGeneration;
  try { const incoming=await client.state();if(!authenticated||generation!==sessionGeneration)return;state=incoming;lastRefreshAt=Date.now();refreshFailed=false;renderState(); }
  catch(error){if(!authenticated||generation!==sessionGeneration)return;refreshFailed=true;if(error.status===401)handleError(error);else{state={...(state||{}),connected:false};renderState();if(!silent)handleError(error);}}
  finally{statePending=false;}
}

$('login-form').addEventListener('submit',async event=>{
  event.preventDefault();$('login-button').disabled=true;$('login-status').textContent='正在验证…';$('login-status').dataset.error='false';
  try{const session=await client.login($('admin-key').value);if(!session.authenticated)throw new AdminError('未能登录，请检查管理口令。');$('admin-key').value='';authenticated=true;$('login-panel').hidden=true;$('admin-app').hidden=false;$('logout').hidden=false;await refreshState();}
  catch(error){$('login-status').textContent=errorMessage(error);$('login-status').dataset.error='true';}
  finally{$('login-button').disabled=false;}
});
$('logout').addEventListener('click',async()=>{try{await client.logout();showLogin();series=null;selection=null;dataLoaded=false;operation('');}catch(error){handleError(error);}});
$('refresh-state').addEventListener('click',()=>refreshState());
$('collector-theme').addEventListener('click',()=>{const theme=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=theme;try{localStorage.setItem('sound-atlas-theme',theme);}catch{}drawChart();});
document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>{
  currentTab=button.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach(item=>item.setAttribute('aria-current',item===button?'page':'false'));
  for(const tab of ['overview','plan','manage'])$('panel-'+tab).hidden=tab!==currentTab;
  if(currentTab==='manage'){drawChart();if(!dataLoaded&&state?.connected)loadSeries();}
}));
$('plan-start').addEventListener('input',()=>{planDirty=true;});$('plan-end').addEventListener('input',()=>{planDirty=true;});
async function sendPlan(payload,title,description) {
  try{
    requireOnline();if(busy)return;
    if(!await confirmOperation(title,description+'\n\n将发送到采集电脑，收到执行确认后生效。'))return;
    const result=await perform('plan',{...payload,planVersion:currentPlan().version},{success:'采集端已确认计划变更。'});
    planDirty=false;await refreshState(true);
    if(result?.message)operation(result.message);
  }catch(error){handleError(error);}
}
$('plan-form').addEventListener('submit',event=>{
  event.preventDefault();const start=$('plan-start').value,end=$('plan-end').value;
  const startMs=parseBeijing(start),endMs=end?parseBeijing(end):0;
  if(!startMs||end&&(!endMs||endMs<=startMs)){operation('请填写有效的开始和结束时间，结束应晚于开始。',true);return;}
  sendPlan({action:'set',start,end},'保存采集计划',`北京时间\n开始 ${formatBeijing(startMs,true)}\n结束 ${endMs?formatBeijing(endMs,true):'手动停止'}`);
});
document.querySelectorAll('[data-plan-action]').forEach(button=>button.addEventListener('click',()=>{
  const action=button.dataset.planAction;
  const copy={quick:['连续采集 7 天','所有测点将在约两分钟后的整分钟统一开始，持续 7 天。'],start_now:['统一开始采集','所有测点将在约 30 秒后统一开始，不设结束时间。'],stop:['统一停止采集','采集端将安排约 15 秒后的统一结束时间，保留已有记录。'],cancel:['取消采集计划','未开始的计划会取消；正在执行的计划将安排统一停止。已有记录保留。']}[action];
  sendPlan({action,...(action==='quick'?{days:7}:{})},...copy);
}));

function filterRange() {
  const start=parseBeijing($('range-start').value),end=parseBeijing($('range-end').value);
  if(!start||!end||end<=start)throw new AdminError('请选择有效时段，结束时间应晚于开始。');
  return {start,end};
}
function operationRange() { return selection||filterRange(); }
function dataNodes() {const nodes=[...selectedNodes];if(!nodes.length)throw new AdminError('请至少选择一个公桌或设备。');return nodes;}
function chooseRange(type,load=true) {
  const overview=state?.overview||{},plan=currentPlan(),now=Date.now();
  const available=(overview.nodes||[]).filter(node=>Number.isFinite(node.first)&&Number.isFinite(node.last));
  const first=available.length?Math.min(...available.map(node=>node.first)):now-3600000;
  const last=available.length?Math.max(...available.map(node=>node.last))+1000:now;
  let start=first,end=last;
  if(type==='plan'){start=plan.startMs||first;end=Math.min(plan.endMs||now,now);if(end<=start)end=start+3600000;}
  if(type==='today'){const today=beijingInput(now).slice(0,10);start=Date.parse(today+'T00:00:00+08:00');end=now;}
  if(type==='hour'){start=now-3600000;end=now;}
  $('range-start').value=beijingInput(start);$('range-end').value=beijingInput(end);
  selection=null;updateSelectionDescription();if(load)loadSeries();
}
document.querySelectorAll('[data-range]').forEach(button=>button.addEventListener('click',()=>chooseRange(button.dataset.range)));
$('data-filter-form').addEventListener('submit',event=>{event.preventDefault();selection=null;loadSeries();});
async function loadSeries() {
  try{const range=filterRange();dataNodes();series=await perform('series',{...range,w:450},{success:'声级曲线已更新。'});dataLoaded=true;selection=null;drawChart();updateSelectionDescription();}
  catch(error){handleError(error);}
}
function updateSelectionDescription() {
  try{const range=operationRange();$('selection-description').textContent=formatBeijing(range.start,true)+' — '+formatBeijing(range.end,true);$('selection-count').textContent=(selection?'图上选区':'当前筛选时段')+' · '+[...selectedNodes].map(node=>names[node]||node).join('、');}
  catch{$('selection-description').textContent='请选择时段';$('selection-count').textContent='';}
  $('clear-selection').hidden=!selection;
}
$('clear-selection').addEventListener('click',()=>{selection=null;drawChart();updateSelectionDescription();});

const chart=$('data-chart');
const chartPadding={left:56,right:14,top:20,lane:58,gap:8,bottom:28};
let chartGeometry=null;
function drawChart() {
  if($('panel-manage').hidden)return;
  const nodes=[...selectedNodes],width=chart.clientWidth,height=Math.max(150,nodes.length*(chartPadding.lane+chartPadding.gap)+chartPadding.top+chartPadding.bottom);
  if(!width)return;
  chart.style.height=height+'px';const ratio=Math.min(devicePixelRatio||1,2);chart.width=Math.round(width*ratio);chart.height=Math.round(height*ratio);
  const ctx=chart.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,width,height);
  const styles=getComputedStyle(document.documentElement),color=name=>styles.getPropertyValue('--'+name).trim();
  ctx.font='10px "Instrument Sans",sans-serif';ctx.fillStyle=color('muted');
  if(!series||!nodes.length){ctx.textAlign='center';ctx.fillText(nodes.length?'选择时段并查看曲线。':'请选择公桌或设备。',width/2,height/2);chartGeometry=null;return;}
  const x=stamp=>chartPadding.left+(stamp-series.start)/(series.end-series.start)*(width-chartPadding.left-chartPadding.right);
  chartGeometry={width,height,start:series.start,end:series.end,x};
  const activeSelection=chartDrag?{start:Math.min(chartDrag.start,chartDrag.end),end:Math.max(chartDrag.start,chartDrag.end)}:selection;
  nodes.forEach((node,index)=>{
    const top=chartPadding.top+index*(chartPadding.lane+chartPadding.gap),points=series.series?.[node]||[];
    const valid=points.filter(point=>Number.isFinite(point[1]));
    const low=Math.min(30,...valid.map(point=>point[2])),high=Math.max(80,...valid.map(point=>point[3]));
    const y=value=>top+chartPadding.lane-(value-low)/(high-low)*chartPadding.lane;
    ctx.textAlign='right';ctx.fillStyle=color('ink');ctx.fillText(names[node]||node,chartPadding.left-8,top+16);ctx.fillStyle=color('muted');ctx.fillText(node,chartPadding.left-8,top+31);
    ctx.strokeStyle=color('line');ctx.lineWidth=.6;for(const level of [low,high]){ctx.beginPath();ctx.moveTo(chartPadding.left,y(level));ctx.lineTo(width-chartPadding.right,y(level));ctx.stroke();}
    for(const exclusion of state?.overview?.exclusions||[]){if(!exclusion.nodes.includes(node))continue;const left=Math.max(chartPadding.left,x(exclusion.start)),right=Math.min(width-chartPadding.right,x(exclusion.end));if(right>left){ctx.globalAlpha=.15;ctx.fillStyle=color('strong-line');ctx.fillRect(left,top,right-left,chartPadding.lane);ctx.globalAlpha=1;}}
    if(activeSelection){const left=Math.max(chartPadding.left,x(activeSelection.start)),right=Math.min(width-chartPadding.right,x(activeSelection.end));if(right>left){ctx.fillStyle=color('accent');ctx.globalAlpha=.15;ctx.fillRect(left,top,right-left,chartPadding.lane);ctx.globalAlpha=1;ctx.strokeStyle=color('accent');ctx.strokeRect(left,top,right-left,chartPadding.lane);}}
    let previous=null;ctx.beginPath();ctx.lineWidth=1.4;ctx.strokeStyle=color('accent');
    for(const point of points){if(!Number.isFinite(point[1])){previous=null;continue;}const px=x(series.start+(point[0]+.5)*series.bucket),py=y(point[1]);if(previous!==null&&point[0]-previous<=1)ctx.lineTo(px,py);else ctx.moveTo(px,py);previous=point[0];}
    ctx.stroke();
    for(const point of points){const px=x(series.start+(point[0]+.5)*series.bucket);if(Number.isFinite(point[2])&&Number.isFinite(point[3])){ctx.strokeStyle=color('strong-line');ctx.globalAlpha=.45;ctx.lineWidth=Math.max(1,(width-chartPadding.left-chartPadding.right)*series.bucket/(series.end-series.start));ctx.beginPath();ctx.moveTo(px,y(point[2]));ctx.lineTo(px,y(point[3]));ctx.stroke();ctx.globalAlpha=1;}if(point[5]>0){ctx.fillStyle=color('accent');ctx.fillRect(px-1,top+chartPadding.lane-5,2,5);}}
    if(!valid.length){ctx.textAlign='center';ctx.fillStyle=color('muted');ctx.fillText('无有效读数',(chartPadding.left+width-chartPadding.right)/2,top+30);}
  });
  ctx.fillStyle=color('muted');ctx.textAlign='center';for(let index=0;index<=4;index++){const stamp=series.start+(series.end-series.start)*index/4;ctx.fillText(formatBeijing(stamp).slice(5),Math.max(45,Math.min(width-45,x(stamp))),height-7);}
  $('chart-description').textContent=formatBeijing(series.start)+' — '+formatBeijing(series.end)+' · 每段 '+Math.round(series.bucket/1000)+' 秒';
}
function chartTime(event){const rect=chart.getBoundingClientRect();const px=Math.max(chartPadding.left,Math.min(chartGeometry.width-chartPadding.right,event.clientX-rect.left));return Math.round((chartGeometry.start+(px-chartPadding.left)/(chartGeometry.width-chartPadding.left-chartPadding.right)*(chartGeometry.end-chartGeometry.start))/1000)*1000;}
chart.addEventListener('pointerdown',event=>{if(!chartGeometry||event.button!==0)return;chartDrag={start:chartTime(event),end:chartTime(event)};chart.setPointerCapture(event.pointerId);});
chart.addEventListener('pointermove',event=>{if(!chartGeometry)return;const stamp=chartTime(event);$('chart-hover').textContent='北京时间 '+formatBeijing(stamp,true);if(chartDrag){chartDrag.end=stamp;drawChart();}});
chart.addEventListener('pointerup',()=>{if(!chartDrag)return;if(Math.abs(chartDrag.end-chartDrag.start)>=1000)selection={start:Math.min(chartDrag.start,chartDrag.end),end:Math.max(chartDrag.start,chartDrag.end)};chartDrag=null;drawChart();updateSelectionDescription();});
chart.addEventListener('pointercancel',()=>{chartDrag=null;drawChart();});
new ResizeObserver(drawChart).observe(chart);

function rangeDescription(range,nodes){return nodes.map(node=>(names[node]||node)+' / '+node).join('、')+'\n'+formatBeijing(range.start,true)+' — '+formatBeijing(range.end,true)+'（北京时间）';}
async function excludeRange(range,nodes,reason,note='') {
  try{
    const count=await perform('count',{...range,nodes},{success:'已核对选定时段。'});
    if(!count.total){operation('选定时段没有记录。');return;}
    if(!await confirmOperation('排除这段观测？',rangeDescription(range,nodes)+`\n共 ${num(count.total)} 条，已排除 ${num(count.excluded)} 条。\n原因：${reason}\n原始记录保留，此标记可以撤销。`))return;
    await perform('exclude',{...range,nodes,reason,note},{success:'采集端已确认排除，原始记录仍保留。'});
    $('exclude-note').value='';selection=null;await refreshState(true);await loadSeries();
  }catch(error){handleError(error);}
}
$('exclude-form').addEventListener('submit',event=>{event.preventDefault();try{excludeRange(operationRange(),dataNodes(),$('exclude-reason').value,$('exclude-note').value);}catch(error){handleError(error);}});
function renderExclusions() {
  const entries=state?.overview?.exclusions||[];$('excluded-count').textContent=entries.length+' 组';
  $('exclusion-list').innerHTML=entries.map(entry=>`<div class="record-item"><div><strong>${esc(entry.nodes.map(node=>names[node]||node).join('、'))}</strong><p>${formatBeijing(entry.start)} — ${formatBeijing(entry.end)} · ${num(entry.rows)} 条</p><p>${esc(entry.reason)}${entry.note?' · '+esc(entry.note):''}</p></div><div class="record-actions"><button class="text-button" data-exclusion="${entry.grp}" data-operation="locate" type="button">查看</button><button class="text-button" data-exclusion="${entry.grp}" data-operation="undo" type="button" ${!state?.connected?'disabled':''}>撤销排除</button></div></div>`).join('')||'<p class="empty-state">尚无排除标记。</p>';
  $('exclusion-list').querySelectorAll('button').forEach(button=>button.addEventListener('click',async()=>{
    const entry=entries.find(item=>item.grp===Number(button.dataset.exclusion));if(!entry)return;
    if(button.dataset.operation==='locate'){locateRange(entry.start,entry.end,entry.nodes);return;}
    try{if(!await confirmOperation('撤销排除标记？',rangeDescription(entry,entry.nodes)+'\n撤销后，这些记录会恢复为可用于分析的观测。'))return;await perform('unexclude',{grp:entry.grp},{success:'采集端已撤销排除标记。'});await refreshState(true);if(series)drawChart();}catch(error){handleError(error);}
  }));
}
function locateRange(start,end,nodes){selectedNodes=new Set(nodes);const margin=Math.max(30000,(end-start)*.2);$('range-start').value=beijingInput(start-margin);$('range-end').value=beijingInput(end+margin);selection={start,end};renderState();loadSeries().then(()=>{selection={start,end};updateSelectionDescription();drawChart();});}
$('scan-suspects').addEventListener('click',async()=>{
  try{const result=await perform('suspects',filterRange(),{success:'可疑时段检查完成。'});const entries=(result.items||[]).filter(entry=>selectedNodes.has(entry.node));
    $('suspect-list').innerHTML=entries.map((entry,index)=>`<div class="record-item"><div><strong>${esc(names[entry.node]||entry.node)} · ${esc(entry.name||entry.type)}</strong><p>${formatBeijing(entry.start)} — ${formatBeijing(entry.end)} · ${num(entry.rows)} 条</p><p>${esc(entry.desc||'请结合现场记录判断。')}</p></div><div class="record-actions"><button class="text-button" type="button" data-suspect="${index}" data-operation="locate">查看</button><button class="text-button" type="button" data-suspect="${index}" data-operation="exclude">排除此段</button></div></div>`).join('')||'<p class="empty-state">当前范围未发现可疑时段。</p>';
    if(result.more){const note=document.createElement('p');note.className='field-note';note.textContent='还有 '+num(result.more)+' 个时段，请缩小范围继续检查。';$('suspect-list').append(note);}
    $('suspect-list').querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>{const entry=entries[Number(button.dataset.suspect)];if(button.dataset.operation==='locate')locateRange(entry.start,entry.end,[entry.node]);else excludeRange({start:entry.start,end:entry.end},[entry.node],entry.reason,'自动检查：'+entry.name);}));
  }catch(error){handleError(error);}
});

async function exportData(clean) {
  let writable=null;
  if(busy)return;
  try{
    requireOnline();const range=operationRange(),nodes=dataNodes();
    setBusy(true);
    const filename='sound-atlas-'+(clean?'clean':'raw')+'-'+beijingInput(Date.now()).slice(0,10)+'.csv';
    // Obtain the destination while this is still a direct user gesture, then write one page at a time.
    if(typeof window.showSaveFilePicker==='function'){
      try {
        const handle=await window.showSaveFilePicker({suggestedName:filename,types:[{description:'CSV 观测数据',accept:{'text/csv':['.csv']}}]});writable=await handle.createWritable();
      } catch(error) {
        if(!['SecurityError','NotSupportedError'].includes(error.name))throw error;
        operation('此浏览器使用文件下载方式导出，单次上限 50 MB。');
      }
    }
    exportController=new AbortController();$('cancel-export').hidden=false;setBusy(true);
    let cursor=null,lastCursor='',pages=0,rows=0,bytes=0,header='',outputName=filename;const chunks=[];const encoder=new TextEncoder();
    while(true){
      const result=await client.command('export',{...range,nodes,clean,cursor,limit:1000},{signal:exportController.signal});
      const chunk=exportChunk(result);
      if(pages===0){header=chunk.header;outputName=chunk.filename||filename;const prefix='\ufeff'+header+'\n';if(writable)await writable.write(prefix);else chunks.push(prefix);bytes+=encoder.encode(prefix).length;}
      else if(chunk.header&&chunk.header!==header)throw new AdminError('导出字段发生变化，请重新导出。');
      const block=chunk.csv;bytes+=encoder.encode(block).length;
      if(!writable&&bytes>50*1024*1024)throw new AdminError('此浏览器的导出超过 50 MB，请缩小时段分批导出；完整原始数据也可在采集电脑导出。');
      if(writable)await writable.write(block);else chunks.push(block);
      pages++;rows+=block.trim()?block.trimEnd().split('\n').length:0;$('export-progress').textContent=`已读取 ${num(rows)} 条 · ${pages} 页`;
      if(chunk.done)break;
      const next=JSON.stringify(chunk.nextCursor);if(!chunk.nextCursor||next===lastCursor)throw new AdminError('导出分页未继续，请重新导出。');lastCursor=next;cursor=chunk.nextCursor;
    }
    if(writable){await writable.close();writable=null;}else{const url=URL.createObjectURL(new Blob(chunks,{type:'text/csv;charset=utf-8'}));const anchor=document.createElement('a');anchor.href=url;anchor.download=outputName;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
    operation(`导出完成，共 ${num(rows)} 条记录。`);$('export-progress').textContent=`完成 · ${num(rows)} 条`;
  }catch(error){if(writable)try{await writable.abort();}catch{}if(error.name==='AbortError'){operation('已取消导出，未完成文件未提交。');$('export-progress').textContent='已取消';}else handleError(error);}
  finally{exportController=null;$('cancel-export').hidden=true;setBusy(false);}
}
$('export-clean').addEventListener('click',()=>exportData(true));$('export-raw').addEventListener('click',()=>exportData(false));$('cancel-export').addEventListener('click',()=>exportController?.abort());

async function purge(mode) {
  try{
    const planVersion=currentPlan().version;const payload={mode,dry:true,planVersion};
    if(mode==='range')Object.assign(payload,operationRange(),{nodes:dataNodes()});
    const preview=await perform('purge',payload,{success:'已核对待删除记录。'});
    if(!preview.count){operation('没有符合条件的记录。');return;}
    const phrase='DELETE '+preview.count;
    if(!await confirmOperation('永久删除 '+num(preview.count)+' 条记录？',(preview.desc||'删除选定记录')+'\n\n采集电脑会先备份完整数据库，再执行删除。此操作会移除原始记录，无法通过“撤销排除”恢复。',phrase))return;
    const result=await perform('purge',{...payload,dry:false,expectedCount:preview.count,confirmation:phrase},{success:'采集端已完成删除并保存备份。'});
    operation(`已删除 ${num(result.deleted)} 条。`+(result.backup?' 本机备份：'+result.backup:''));selection=null;await refreshState(true);await loadSeries();
  }catch(error){handleError(error);}
}
$('purge-range').addEventListener('click',()=>purge('range'));$('purge-outside').addEventListener('click',()=>purge('outside_plan'));

setInterval(()=>refreshState(true),5000);
setInterval(()=>{if(authenticated&&!document.hidden)renderMonitor();},1000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshState(true);});
(async()=>{try{const session=await client.session();if(!session.authenticated){showLogin();return;}authenticated=true;$('login-panel').hidden=true;$('admin-app').hidden=false;$('logout').hidden=false;await refreshState();}catch(error){showLogin(errorMessage(error));}})();
