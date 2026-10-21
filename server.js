const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const RELAY_API_KEY = process.env.RELAY_API_KEY || '';
const RELAY_BASE_URL = (process.env.RELAY_BASE_URL || 'https://api.relaymodels.com/v1').replace(/\/$/, '');
const RELAY_MODEL = process.env.RELAY_MODEL || 'gemini-3.7-flash';
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
async function parseStructuredJson(raw, provider){
  const text=String(raw??'').trim();
  if(!text)throw new Error(`${provider} не вернул результат.`);
  const cleaned=text.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
  try{return JSON.parse(cleaned)}catch{throw new Error(`${provider} вернул некорректный structured JSON.`)}
}

async function callGeminiModel(model,payload){
  const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  try{
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const text=await r.text();
    if(!r.ok){
      const err=new Error(`Gemini HTTP ${r.status}: ${text.slice(0,500)}`);
      err.status=r.status;
      throw err;
    }
    let data;try{data=JSON.parse(text)}catch{throw new Error('Gemini вернул некорректный JSON.')}
    const raw=data?.candidates?.[0]?.content?.parts?.[0]?.text;
    const result=await parseStructuredJson(raw,'Gemini');
    return {result,model,provider:'Google Gemini'};
  }catch(err){
    if([429,500,502,503,504].includes(err.status)) err.retryable=true;
    throw err;
  }
}

async function callRelayModel(model,prompt){
  if(!RELAY_API_KEY)throw new Error('RELAY_API_KEY не задан на сервере.');
  const url=`${RELAY_BASE_URL}/chat/completions`;
  const payload={
    model,
    messages:[{role:'user',content:String(prompt||'')}],
    response_format:{type:'json_object'},
    temperature:0.2,
    max_tokens:500
  };
  try{
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${RELAY_API_KEY}`},body:JSON.stringify(payload)});
    const text=await r.text();
    if(!r.ok){
      const err=new Error(`RelayModels HTTP ${r.status}: ${text.slice(0,500)}`);
      err.status=r.status;
      throw err;
    }
    let data;try{data=JSON.parse(text)}catch{throw new Error('RelayModels вернул некорректный JSON.')}
    const raw=data?.choices?.[0]?.message?.content;
    const result=await parseStructuredJson(raw,'RelayModels');
    return {result,model,provider:'RelayModels'};
  }catch(err){
    if([429,500,502,503,504].includes(err.status)) err.retryable=true;
    throw err;
  }
}

function relayPromptFromGeminiPayload(payload){
  return (payload?.contents||[]).flatMap(x=>Array.isArray(x?.parts)?x.parts:[]).map(x=>String(x?.text||'')).filter(Boolean).join('\n\n');
}

async function callAiModel(model,payload){
  if(model.provider==='relay') return callRelayModel(model.name,relayPromptFromGeminiPayload(payload));
  return callGeminiModel(model.name,payload);
}

async function geminiCompare(body){
  if(!RELAY_API_KEY && !GEMINI_API_KEY) throw new Error('Ни RELAY_API_KEY, ни GEMINI_API_KEY не заданы на сервере.');
  const isDecoy=body.task==='decoy';
  const bots=(Array.isArray(body.bots)?body.bots:[]).slice(0,8).map(b=>({
    botId:String(b.botId),coach:clip(b.coach,80),personality:clip(b.personality,700),
    options:(Array.isArray(b.options)?b.options:[]).slice(0,12).map(o=>({id:String(o.id),name:clip(o.name,120),profile:clip(o.profile,700)}))
  }));
  if(!bots.some(b=>b.options.length)) throw new Error('У ботов нет доступных карт для выбора.');
  const task=isDecoy?'выбери карту-обманку из своей руки для ассоциации':'угадай, какая из отправленных карт является секретной картой ведущего';
  const baseRules=`Ты — ИИ-мозг одного бота в футбольной игре ассоциаций.\nЗадача: ${task}.\nАссоциация: «${clip(body.clue,500)}»\nИспользуй футбольные факты из профилей и выбирай по смыслу. Не выдумывай факты. Ниже приведены только допустимые варианты именно этого бота. Скопируй choiceId дословно из выбранного варианта. Верни только JSON.`;
  const models=[];
  if(RELAY_API_KEY) models.push({provider:'relay',name:RELAY_MODEL});
  if(GEMINI_API_KEY) models.push({provider:'google',name:GEMINI_MODEL || 'gemini-3.8-flash'});
  if(!models.length) throw new Error('AI provider is not configured');
  const properties={choiceId:{type:'string'},confidence:{type:'number'}};
  if(!isDecoy) properties.reason={type:'string'};
  const results=await Promise.all(bots.map(async bot=>{
    if(!bot.options.length)return null;
    const optionsJson=JSON.stringify(bot.options);
    let lastError=null;
    for(let attempt=0;attempt<2;attempt++){
      const prompt=`${baseRules}\nБот: ${bot.coach}. ${bot.personality}\nДопустимые варианты: ${optionsJson}${attempt?'\nПредыдущий ответ был недопустим. Повтори выбор и верни choiceId ровно как в списке.':''}`;
      const payload={contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{responseMimeType:'application/json',responseSchema:{type:'object',properties,required:['choiceId','confidence']},thinkingConfig:{thinkingLevel:isDecoy?'minimal':'low'}}};
      try{
        const out=await callAiModel(models[0],payload);
        const choiceId=String(out.result?.choiceId??'');
        if(bot.options.some(option=>option.id===choiceId))return {botId:bot.botId,choiceId,confidence:out.result.confidence,reason:out.result.reason,model:out.model};
        lastError=new Error('ИИ вернул ID вне списка этого бота.');
      }catch(err){lastError=err;}
    }
    // Try the reserve provider once when available; its result is still checked against this bot's exact options.
    if(models[1] && !lastError?.message?.includes('вне списка')){
      try{
        const prompt=`${baseRules}\nБот: ${bot.coach}. ${bot.personality}\nДопустимые варианты: ${optionsJson}\nВерни choiceId строго из списка.`;
        const payload={contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{responseMimeType:'application/json',responseSchema:{type:'object',properties,required:['choiceId','confidence']},thinkingConfig:{thinkingLevel:isDecoy?'minimal':'low'}}};
        const out=await callAiModel(models[1],payload);const choiceId=String(out.result?.choiceId??'');
        if(bot.options.some(option=>option.id===choiceId))return {botId:bot.botId,choiceId,confidence:out.result.confidence,reason:out.result.reason,model:out.model};
      }catch(err){lastError=err;}
    }
    return {botId:bot.botId,error:lastError?.message||'ИИ не выбрал допустимую карту.'};
  }));
  const validResults=results.filter(row=>row&&row.choiceId);
  return {result:{results:validResults,errors:results.filter(row=>row?.error)},model:validResults[0]?.model||models[0].name,provider:models[0].provider==='relay'?'RelayModels':'Google Gemini'};
}

const server=http.createServer(async (req,res)=>{
  const u=decodeURIComponent(req.url.split('?')[0]);
  if(req.method==='GET' && u==='/api/ai-status') return sendJson(res,200,{configured:!!(RELAY_API_KEY||GEMINI_API_KEY),relayConfigured:!!RELAY_API_KEY,googleConfigured:!!GEMINI_API_KEY,model:RELAY_API_KEY?RELAY_MODEL:GEMINI_MODEL,provider:RELAY_API_KEY?'RelayModels':'Google Gemini'});
  if(req.method==='POST' && u==='/api/gemini/compare'){try{const out=await geminiCompare(await readJson(req));return sendJson(res,200,{ok:true,model:out.model,provider:out.provider,result:out.result})}catch(e){return sendJson(res,502,{ok:false,error:e.message||'Gemini request failed'})}}
  if(req.method==='POST' && u==='/api/gemini/clue'){try{
    if(!RELAY_API_KEY && !GEMINI_API_KEY) throw new Error('Ни RELAY_API_KEY, ни GEMINI_API_KEY не заданы на сервере.');
    const body=await readJson(req);
    const card=body.card||{};
    const coach=clip(body.coach,80);
    const personality=clip(body.personality,900);
    const profile=clip(body.profile,1800);
    const rawLens=body.coachLens||{};
    const coachLens={
      style:(Array.isArray(rawLens.style)?rawLens.style:[]).slice(0,8).map(x=>clip(x,80)),
      focus:(Array.isArray(rawLens.focus)?rawLens.focus:[]).slice(0,12).map(x=>clip(x,80)),
      voice:(Array.isArray(rawLens.voice)?rawLens.voice:[]).slice(0,5).map(x=>clip(x,120)),
      playerAnchor:(Array.isArray(rawLens.playerAnchor)?rawLens.playerAnchor:[]).slice(0,5).map(x=>clip(x,140)),
      sampleAssociations:(Array.isArray(rawLens.sampleAssociations)?rawLens.sampleAssociations:[]).slice(0,8).map(x=>clip(x,140))
    };
    const prompt=`Ты придумываешь ассоциацию для футбольной версии Имаджинариума.\n\nЗагаданная карта: ${clip(card.name,120)}\nПрофиль футболиста: ${profile}\nТренер: ${coach}\nМанера и характер тренера: ${personality}\nТренерская оптика для этой карты: ${JSON.stringify(coachLens)}\n\nПридумай одну естественную ассоциацию длиной 2–8 слов. Она должна одновременно опираться на конкретное качество футболиста и на футбольную оптику именно этого тренера: его стиль, тактический фокус, любимую манеру игры или известное отношение к этому игроку. Не ограничивайся общим словом вроде «характер», «талант» или «скорость». Используй примеры и личные якоря только как подсказки для мысли; не копируй их автоматически. Если прямой связи тренера с игроком нет, найди правдоподобное пересечение стиля тренера и фактов в профиле.\n\nНе называй игрока или тренера. Не используй клуб, страну, уникальный переход или точный факт, который сразу раскрывает карту. Не выдумывай личную историю или мнение тренера: поле coachLink должно кратко объяснить, какое реальное качество карты связано с указанной оптикой тренера. Ассоциация должна быть понятна другим игрокам и звучать как короткая живая мысль.\n\nВерни только JSON вида {\"clue\":\"2–8 слов\",\"coachLink\":\"короткое объяснение связи\"}.`;
    const clueSchema={type:'string'};
    const payload={contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{responseMimeType:'application/json',responseSchema:{type:'object',properties:{clue:clueSchema,coachLink:{type:'string'}},required:['clue','coachLink']},thinkingConfig:{thinkingLevel:'low'}}};
    let lastError=null;
    const models=[];
    if(RELAY_API_KEY) models.push({provider:'relay',name:RELAY_MODEL});
    if(GEMINI_API_KEY) models.push({provider:'google',name:GEMINI_MODEL||'gemini-3.8-flash'});
    for(const model of models){
      try{
        if(model.provider==='google') payload.generationConfig.thinkingConfig={thinkingLevel:'low'};
        const out=await callAiModel(model,payload);
        return sendJson(res,200,{ok:true,model:out.model,provider:out.provider,result:out.result});
      }catch(e){lastError=e;}
    }
    throw lastError||new Error('AI provider is not configured');
  }catch(e){return sendJson(res,502,{ok:false,error:e.message||'Gemini clue request failed'})}}
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

server.listen(PORT,()=>console.log(`Football Imaginarium server on ${PORT}; RelayModels ${RELAY_API_KEY?'configured':'not configured'}${RELAY_API_KEY?` model=${RELAY_MODEL}`:''}; Google Gemini ${GEMINI_API_KEY?'configured':'not configured'}${GEMINI_API_KEY?` model=${GEMINI_MODEL}`:''}`));
