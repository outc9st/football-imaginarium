const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const PUBLIC = path.join(__dirname, 'public');
const rooms = new Map();

function roomCode(){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let x;
  do{x=Array.from({length:5},()=>chars[Math.floor(Math.random()*chars.length)]).join('')}while(rooms.has(x));
  return x;
}
function cleanName(n){return String(n||'').trim().replace(/\s+/g,' ').slice(0,24)||'Игрок'}
function send(ws,p){if(ws.readyState===1)ws.send(JSON.stringify(p))}
function broadcast(r,p){for(const x of r.players.values())send(x.ws,p)}
function playerList(r){return [...r.players.values()].map(p=>({id:p.id,name:p.name,isHost:p.id===r.hostId}))}
function clampBotCount(r,n){const humans=r.players.size;const min=Math.max(0,4-humans);const max=Math.max(0,8-humans);return Math.max(min,Math.min(max,Number.isFinite(Number(n))?Number(n):min))}
function roundOptions(total){if(total===4)return ['8','16','end'];if(total===5)return ['10','20','end'];if(total===6)return ['12','end'];if(total===7)return ['14','end'];return ['end']}
function normalizeRoomSettings(r){r.botCount=clampBotCount(r,r.botCount);const total=r.players.size+r.botCount;const opts=roundOptions(Math.max(4,Math.min(8,total)));if(!opts.includes(String(r.roundMode)))r.roundMode=opts[0]}
function lobbyState(r){normalizeRoomSettings(r);return {type:'lobby',roomCode:r.code,hostId:r.hostId,started:r.started,botCount:r.botCount,roundMode:r.roundMode,players:playerList(r)}}

function leave(p){
  if(!p.roomCode)return;
  const r=rooms.get(p.roomCode);
  if(!r){p.roomCode=null;return;}
  r.players.delete(p.id);
  const wasHost=r.hostId===p.id;
  if(wasHost){
    if(r.started){
      r.started=false;
      r.gameState=null;
      r.hostId=null;
      broadcast(r,{type:'gameReset',reason:'Создатель комнаты отключился.'});
    }else{
      const n=r.players.values().next().value;
      r.hostId=n?n.id:null;
    }
  }
  if(!r.players.size)rooms.delete(r.code);
  else broadcast(r,lobbyState(r));
  p.roomCode=null;
}

function sendJson(res,status,data){const body=JSON.stringify(data);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(body)}
function readJson(req){return new Promise((resolve,reject)=>{let s='';req.on('data',c=>{s+=c;if(s.length>1500000)req.destroy()});req.on('end',()=>{try{resolve(JSON.parse(s||'{}'))}catch(e){reject(e)}});req.on('error',reject)})}
function clip(v,n=800){return String(v??'').slice(0,n)}
async function callGeminiModel(model,payload,timeoutMs=4500){
  const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal});
    const text=await r.text();
    if(!r.ok){
      const err=new Error(`Gemini HTTP ${r.status}: ${text.slice(0,500)}`);
      err.status=r.status;
      throw err;
    }
    let data;try{data=JSON.parse(text)}catch{throw new Error('Gemini вернул некорректный JSON.')}
    const raw=data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if(!raw)throw new Error('Gemini не вернул результат.');
    let result;try{result=JSON.parse(raw)}catch{throw new Error('Gemini вернул некорректный structured JSON.')}
    return {result,model};
  }catch(err){
    if(err.name==='AbortError'){
      const e=new Error(`Gemini timeout (${timeoutMs} ms)`);e.retryable=true;throw e;
    }
    if([429,500,502,503,504].includes(err.status)) err.retryable=true;
    throw err;
  }finally{clearTimeout(timer)}
}

async function geminiCompare(body){
  if(!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY не задан на сервере.');
  const isDecoy=body.task==='decoy';
  const bots=(Array.isArray(body.bots)?body.bots:[]).slice(0,8).map(b=>({
    botId:String(b.botId),coach:clip(b.coach,80),personality:clip(b.personality,700),
    options:(Array.isArray(b.options)?b.options:[]).slice(0,12).map(o=>({id:String(o.id),name:clip(o.name,120),profile:clip(o.profile,700)}))
  }));
  if(!bots.some(b=>b.options.length)) throw new Error('У ботов нет доступных карт для выбора.');
  const task=isDecoy?'выбери карту-обманку из своей руки для ассоциации':'угадай, какая из отправленных карт является секретной картой ведущего';
  const prompt=`Ты — ИИ-мозг бота в футбольной игре ассоциаций.\n\nЗадача: ${task}.\nАссоциация: «${clip(body.clue,500)}»\n\nПравила:\n- Понимай смысл ассоциации как футбольную идею, а не только совпадение слов.\n- Используй футбольные факты из профилей карт.\n- Явные факты важнее слабых тематических совпадений.\n- Учитывай отрицательную совместимость: ассоциация про чувство штрафной не должна автоматически вести к защитнику или вратарю.\n- Не выдумывай факты, которых нет в профилях, кроме общеизвестных футбольных фактов.\n- Характер тренера влияет на предпочтения и тай-брейки, но не должен перебивать очевидное смысловое соответствие.\n- Для каждого бота верни ровно один существующий option id из его собственного списка.\n- Никогда не возвращай ID из списка другого бота.\n- Ответ должен быть максимально коротким: только структурированный JSON без объяснения вне JSON.\n\nБоты и варианты:\n${JSON.stringify(bots)}`;
  const properties={botId:{type:'string'},choiceId:{type:'string'},confidence:{type:'number'}};
  if(!isDecoy) properties.reason={type:'string'};
  const payload={
    contents:[{role:'user',parts:[{text:prompt}]}],
    generationConfig:{
      responseMimeType:'application/json',
      responseSchema:{type:'object',properties:{results:{type:'array',items:{type:'object',properties,required:['botId','choiceId','confidence']}}},required:['results']},
      thinkingConfig:{thinkingLevel:isDecoy?'minimal':'low'}
    }
  };

  // Decoy selection is a fast classification task: use the fastest Flash-Lite model.
  // Voting needs a little more semantic reasoning: use the configured Flash model at low thinking.
  const configured=GEMINI_MODEL || 'gemini-3.8-flash';
  const primary=isDecoy?'gemini-3.5-flash-lite':configured;
  const fallback=isDecoy?'gemini-3.6-flash':'gemini-3.6-flash';
  const models=[primary,fallback].filter((m,i,a)=>m&&a.indexOf(m)===i);
  const timeout=isDecoy?3500:4500;
  let lastError=null;
  for(const model of models){
    try{
      const level=isDecoy?'minimal':'low';
      payload.generationConfig.thinkingConfig={thinkingLevel:level};
      return await callGeminiModel(model,payload,timeout);
    }catch(err){
      lastError=err;
      // Capacity errors are worth an immediate fallback. A timeout means the game
      // should move on quickly to the local fallback rather than stacking waits.
      if(!err.retryable || /timeout/i.test(err.message||'')) break;
    }
  }
  throw lastError || new Error('Gemini request failed');
}

const server=http.createServer(async (req,res)=>{
  const u=decodeURIComponent(req.url.split('?')[0]);
  if(req.method==='GET' && u==='/api/ai-status') return sendJson(res,200,{configured:!!GEMINI_API_KEY,model:GEMINI_MODEL});
  if(req.method==='POST' && u==='/api/gemini/compare'){try{const out=await geminiCompare(await readJson(req));return sendJson(res,200,{ok:true,model:out.model,result:out.result})}catch(e){return sendJson(res,502,{ok:false,error:e.message||'Gemini request failed'})}}
  let filePath=u; if(filePath==='/')filePath='/index.html';
  const f=path.normalize(path.join(PUBLIC,filePath));
  if(!f.startsWith(PUBLIC)){res.writeHead(403);return res.end('Forbidden')}
  fs.readFile(f,(e,d)=>{
    if(e){res.writeHead(404);return res.end('Not found')}
    const t={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}[path.extname(f)]||'application/octet-stream';
    res.writeHead(200,{'Content-Type':t,'Cache-Control':'no-cache'});res.end(d);
  });
});

const wss=new WebSocketServer({server});
wss.on('connection',ws=>{
  const p={id:Math.random().toString(36).slice(2,10),name:'Игрок',roomCode:null,ws};
  send(ws,{type:'connected',playerId:p.id});

  ws.on('message',raw=>{
    let m;try{m=JSON.parse(raw)}catch{return send(ws,{type:'error',message:'Некорректный запрос.'})}

    if(m.type==='createRoom'){
      leave(p);
      const code=roomCode();
      const r={code,hostId:p.id,players:new Map(),started:false,botCount:3,roundMode:'8',gameState:null};
      rooms.set(code,r);
      p.name=cleanName(m.name);p.roomCode=code;r.players.set(p.id,p);
      return broadcast(r,lobbyState(r));
    }

    if(m.type==='joinRoom'){
      leave(p);
      const code=String(m.roomCode||'').trim().toUpperCase();
      const r=rooms.get(code);
      if(!r)return send(ws,{type:'error',message:'Комната не найдена.'});
      if(r.started)return send(ws,{type:'error',message:'Игра уже началась. Подключиться к ней сейчас нельзя.'});
      if(r.players.size>=8)return send(ws,{type:'error',message:'Комната заполнена.'});
      p.name=cleanName(m.name);p.roomCode=code;r.players.set(p.id,p);
      return broadcast(r,lobbyState(r));
    }

    if(m.type==='leaveRoom'){
      leave(p);return send(ws,{type:'leftRoom'});
    }

    const r=p.roomCode?rooms.get(p.roomCode):null;
    if(!r)return;

    if(m.type==='setSettings'){
      if(r.hostId!==p.id)return send(ws,{type:'error',message:'Только создатель комнаты может менять настройки.'});
      if(r.started)return;
      r.botCount=clampBotCount(r,m.botCount);
      r.roundMode=String(m.roundMode||'end');
      normalizeRoomSettings(r);
      return broadcast(r,lobbyState(r));
    }

    if(m.type==='startGame'){
      if(r.hostId!==p.id)return send(ws,{type:'error',message:'Только создатель комнаты может начать игру.'});
      if(r.started)return;
      normalizeRoomSettings(r);
      if(r.players.size+r.botCount<4 || r.players.size+r.botCount>8)return send(ws,{type:'error',message:'Для начала игры нужно от 4 до 8 игроков всего.'});
      if(!roundOptions(r.players.size+r.botCount).includes(String(r.roundMode)))return send(ws,{type:'error',message:'Недопустимое количество раундов для этого состава.'});
      r.started=true;
      r.gameState=null;
      return broadcast(r,{type:'gameStarting',players:playerList(r),botCount:r.botCount,roundMode:r.roundMode});
    }

    if(m.type==='gameThinking'){
      const r=p.roomCode?rooms.get(p.roomCode):null;
      if(r && p.id===r.hostId) broadcast(r,{type:'gameThinking',show:m.show!==false,kind:String(m.kind||'thinking'),names:Array.isArray(m.names)?m.names.slice(0,8):[]});
      return;
    }

    if(m.type==='gameAction'){
      if(!r.started)return;
      // Только авторитетный хост исполняет действия. Сервер лишь доставляет
      // действия от остальных игроков хосту, чтобы состояние было единым.
      if(p.id===r.hostId)return;
      return send([...r.players.values()].find(x=>x.id===r.hostId)?.ws,{type:'gameAction',fromId:p.id,action:m.action,payload:m.payload||{}});
    }

    if(m.type==='gameState'){
      if(!r.started || r.hostId!==p.id)return;
      r.gameState=m.state||null;
      return broadcast(r,{type:'gameState',state:r.gameState});
    }

    if(m.type==='resetGame'){
      if(r.hostId!==p.id)return send(ws,{type:'error',message:'Только создатель комнаты может вернуть игру в лобби.'});
      r.started=false;r.gameState=null;
      return broadcast(r,{type:'gameReset'});
    }
  });

  ws.on('close',()=>leave(p));
});

server.listen(PORT,()=>console.log(`Football Imaginarium server on ${PORT}; Gemini ${GEMINI_API_KEY?'configured':'not configured'}; model=${GEMINI_MODEL}`));
